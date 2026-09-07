import type Stripe from "stripe";
import type { Partner } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  PARTNER_COMMISSION_MONTHS,
  PARTNER_FREE_ACCOUNT_THRESHOLD,
  nextPartnerTier,
  partnerTierFor,
  type PartnerTier,
} from "@/lib/plans";
import { subscriptionRevenueCents } from "@/lib/stripe/billing";
import { getOrCreatePartnerReferralCode, referralUrl } from "@/lib/referrals";

// The accountant / bookkeeper partner program.
//
// Structurally different from the customer referral program on purpose: an
// accounting firm that introduces 20 contractors is worth far more than 20
// free months to them, so partners earn a recurring percentage of the
// subscription revenue they generate, tiered by how many paying clients
// they've brought in, for the first 12 paid months of each client.
//
// ─────────────────────────────────────────────────────────────────────────
// SECURITY, stated once and enforced everywhere below:
// Being a partner grants ZERO access to any referred contractor's
// QuickBooks data, financials, jobs, or reports. Not one query in this file
// reads another account's financial data, and the partner dashboard shows
// only counts and commission amounts. If an accountant is ever to see a
// contractor's numbers, that contractor must explicitly grant it through
// normal account access controls - a referral link is not consent.
// ─────────────────────────────────────────────────────────────────────────

export interface PartnerApplication {
  firmName: string;
  contactName: string;
  phone?: string | null;
  website?: string | null;
  clientCountEstimate?: string | null;
}

/** Creates a pending partner application for a signed-in user. */
export async function applyToPartnerProgram(
  userId: string,
  application: PartnerApplication
): Promise<Partner> {
  const existing = await prisma.partner.findUnique({ where: { userId } });
  if (existing) return existing;

  return prisma.partner.create({
    data: {
      userId,
      firmName: application.firmName,
      contactName: application.contactName,
      phone: application.phone ?? null,
      website: application.website ?? null,
      clientCountEstimate: application.clientCountEstimate ?? null,
      status: "pending",
    },
  });
}

/**
 * Approves a partner and issues their referral code. Approval is what makes
 * a partner link live (see attributeReferral, which refuses codes belonging
 * to partners who aren't approved).
 */
export async function approvePartner(partnerId: string): Promise<{ code: string; url: string }> {
  const partner = await prisma.partner.update({
    where: { id: partnerId },
    data: { status: "approved", approvedAt: new Date(), rejectedAt: null },
  });
  const code = await getOrCreatePartnerReferralCode(partner.id);
  return { code, url: referralUrl(code) };
}

/**
 * How many of this partner's referred clients are paying RIGHT NOW. This is
 * the number that sets the commission tier - a partner whose clients churn
 * moves back down a tier for future invoices, which is the correct
 * behaviour for a volume-based rate.
 */
export async function countPayingClients(partnerId: string): Promise<number> {
  // Deliberately two plain queries rather than one nested relation filter.
  // This number sets the commission rate, so it's worth it being obvious
  // what's being counted - and a nested filter across a nullable relation
  // (a referred account can be deleted while the referral record stays) is
  // exactly the kind of thing that silently returns the wrong count.
  const referrals = await prisma.referral.findMany({
    where: { partnerId, status: { in: ["paid", "qualified"] } },
    select: { referredUserId: true },
  });

  const referredUserIds = referrals
    .map((r) => r.referredUserId)
    .filter((id): id is string => id != null);
  if (referredUserIds.length === 0) return 0;

  return prisma.subscription.count({
    where: {
      userId: { in: referredUserIds },
      status: { in: ["active", "past_due"] },
    },
  });
}

/** The tier a partner is currently in, based on live paying-client count. */
export async function currentPartnerTier(partnerId: string): Promise<PartnerTier> {
  return partnerTierFor(await countPayingClients(partnerId));
}

/**
 * Records commission for a successfully paid invoice from a partner-referred
 * customer. Called only from the Stripe webhook handler, only on
 * invoice.paid.
 *
 * Every duplicate-protection concern the spec raises collapses into one
 * database constraint here: PartnerCommission.stripeInvoiceId is @unique.
 * A retried webhook, a double delivery, or two concurrent workers all end
 * up attempting the same insert, and exactly one wins. No read-then-write
 * check is involved, because a read-then-write check is exactly what a
 * concurrent retry defeats.
 *
 * Returns the commission created, or null when none was due (past the
 * 12-month window, zero collectable revenue, partner not approved).
 */
export async function recordCommissionForInvoice(params: {
  invoice: Stripe.Invoice;
  referralId: string;
  partnerId: string;
  referredUserId: string;
  paidAt: Date;
}): Promise<{ commissionCents: number; monthNumber: number; rateBps: number } | null> {
  const { invoice, referralId, partnerId, referredUserId, paidAt } = params;

  const partner = await prisma.partner.findUnique({ where: { id: partnerId } });
  if (!partner || partner.status !== "approved") return null;

  // Commission is capped at the first 12 successfully paid subscription
  // months per referred client. Voided commissions (refunds) don't consume a
  // month - the client didn't actually pay for it.
  const priorMonths = await prisma.partnerCommission.count({
    where: { referralId, status: { in: ["earned", "paid"] } },
  });
  if (priorMonths >= PARTNER_COMMISSION_MONTHS) return null;

  const revenueCents = subscriptionRevenueCents(invoice);
  if (revenueCents <= 0) return null; // nothing collected (fully credited, or $0 invoice)

  // Rate is resolved from the partner's CURRENT paying-client count and then
  // frozen onto this row. Reaching a higher tier later raises the rate on
  // subsequent invoices only - it never retroactively re-prices commissions
  // already earned. That's a deliberate design choice, not an oversight:
  // retroactive re-pricing would make every past month's ledger mutable.
  const tier = await currentPartnerTier(partnerId);
  const commissionCents = Math.round((revenueCents * tier.rateBps) / 10_000);

  try {
    await prisma.partnerCommission.create({
      data: {
        partnerId,
        referralId,
        referredUserId,
        stripeInvoiceId: invoice.id,
        stripeSubscriptionId:
          typeof invoice.subscription === "string"
            ? invoice.subscription
            : invoice.subscription?.id ?? null,
        stripeCustomerId:
          typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? null,
        subscriptionRevenueCents: revenueCents,
        commissionRateBps: tier.rateBps,
        commissionCents,
        monthNumber: priorMonths + 1,
        status: "earned",
        earnedAt: paidAt,
      },
    });
  } catch (err) {
    // P2002 on stripeInvoiceId - this invoice was already commissioned by a
    // previous delivery of the same event. Exactly the outcome we want.
    if ((err as { code?: string })?.code === "P2002") return null;
    throw err;
  }

  await maybeGrantFreeFirmAccount(partnerId);

  return { commissionCents, monthNumber: priorMonths + 1, rateBps: tier.rateBps };
}

/**
 * Voids commission for a refunded or charged-back invoice. Commission is
 * only ever earned on money actually collected and kept, so a refund
 * reverses it - and because voided rows are excluded from the month count,
 * the refunded month doesn't burn one of the client's 12 eligible months.
 */
export async function voidCommissionForInvoice(
  stripeInvoiceId: string,
  reason: string,
  now: Date = new Date()
): Promise<boolean> {
  const result = await prisma.partnerCommission.updateMany({
    where: { stripeInvoiceId, status: { in: ["earned"] } },
    data: { status: "voided", voidedAt: now, voidReason: reason },
  });
  return result.count > 0;
}

/**
 * At roughly 3 active paying clients a partner earns a complimentary
 * JobProfitAI account for their own firm. Recorded here; the actual
 * entitlement is granted by an admin so it's a deliberate act with a record,
 * not an automatic subscription change triggered by a webhook.
 */
export async function maybeGrantFreeFirmAccount(partnerId: string): Promise<boolean> {
  const partner = await prisma.partner.findUnique({ where: { id: partnerId } });
  if (!partner || partner.freeAccountGrantedAt) return false;

  const paying = await countPayingClients(partnerId);
  if (paying < PARTNER_FREE_ACCOUNT_THRESHOLD) return false;

  await prisma.partner.update({
    where: { id: partnerId },
    data: { freeAccountGrantedAt: new Date() },
  });
  return true;
}

// --- Payouts -------------------------------------------------------------

/**
 * Marks commissions as paid out.
 *
 * IMPORTANT, and stated plainly in the partner-facing UI too: this is a
 * LEDGER, not an automated payout system. JobProfitAI does not currently
 * move money to partners automatically - there is no Stripe Connect account,
 * no identity verification flow, and no 1099 reporting pipeline, and
 * pretending otherwise would be both a compliance problem and a lie to
 * partners. An administrator pays partners out of band and records it here.
 *
 * The ledger is deliberately shaped so that adding Stripe Connect later
 * means writing a payout executor that flips these same rows, not redesigning
 * the data model.
 */
export async function markCommissionsPaid(
  commissionIds: string[],
  note: string | null,
  now: Date = new Date()
): Promise<number> {
  const result = await prisma.partnerCommission.updateMany({
    where: { id: { in: commissionIds }, status: "earned" },
    data: { status: "paid", paidAt: now, paidNote: note },
  });
  return result.count;
}

// --- Dashboard -----------------------------------------------------------

export interface PartnerDashboardData {
  partner: Partner;
  code: string | null;
  url: string | null;
  tier: PartnerTier;
  nextTier: PartnerTier | null;
  clientsToNextTier: number | null;
  referredSignups: number;
  trialingClients: number;
  payingClients: number;
  pendingCommissionCents: number;
  paidCommissionCents: number;
  lifetimeCommissionCents: number;
  freeAccountEarned: boolean;
}

/**
 * Everything the partner dashboard renders. Counts and money only - no
 * referred contractor's identity or financial data is loaded here, by
 * design (see the security note at the top of this file).
 */
export async function getPartnerDashboardData(partnerId: string): Promise<PartnerDashboardData> {
  const partner = await prisma.partner.findUnique({ where: { id: partnerId } });
  if (!partner) throw new Error("Partner not found.");

  const [referralCode, referrals, payingClients, commissions] = await Promise.all([
    prisma.referralCode.findUnique({ where: { partnerId } }),
    prisma.referral.findMany({ where: { partnerId }, select: { referredUserId: true } }),
    countPayingClients(partnerId),
    prisma.partnerCommission.findMany({
      where: { partnerId },
      select: { status: true, commissionCents: true },
    }),
  ]);

  const referredUserIds = referrals
    .map((r) => r.referredUserId)
    .filter((id): id is string => id != null);

  const referredSignups = referrals.length;
  const trialingClients =
    referredUserIds.length === 0
      ? 0
      : await prisma.subscription.count({
          where: { userId: { in: referredUserIds }, status: "trialing" },
        });

  const sum = (status: string) =>
    commissions.filter((c) => c.status === status).reduce((t, c) => t + c.commissionCents, 0);

  const tier = partnerTierFor(payingClients);
  const next = nextPartnerTier(payingClients);

  return {
    partner,
    code: referralCode?.code ?? null,
    url: referralCode ? referralUrl(referralCode.code) : null,
    tier,
    nextTier: next,
    clientsToNextTier: next ? Math.max(0, next.minPayingClients - payingClients) : null,
    referredSignups,
    trialingClients,
    payingClients,
    pendingCommissionCents: sum("earned"),
    paidCommissionCents: sum("paid"),
    lifetimeCommissionCents: sum("earned") + sum("paid"),
    freeAccountEarned: partner.freeAccountGrantedAt != null,
  };
}

/** Commission ledger rows for the partner's own dashboard. */
export interface PartnerCommissionRow {
  id: string;
  earnedAt: Date;
  monthNumber: number;
  subscriptionRevenueCents: number;
  commissionRateBps: number;
  commissionCents: number;
  status: string;
  paidAt: Date | null;
}

/**
 * Commission ledger rows for the partner's own dashboard.
 *
 * The returned shape is built field by field, and the return type is
 * declared explicitly, so that "a partner never sees who their referred
 * clients are" is guaranteed by this function rather than by a `select`
 * clause someone could widen later without noticing what it protected.
 * `referredUserId`, `stripeCustomerId` and `stripeInvoiceId` all stay behind
 * this boundary: a partner is entitled to know what they earned and when,
 * not which business generated it.
 */
export async function getPartnerCommissionHistory(
  partnerId: string
): Promise<PartnerCommissionRow[]> {
  const rows = await prisma.partnerCommission.findMany({
    where: { partnerId },
    orderBy: { earnedAt: "desc" },
    take: 200,
    select: {
      id: true,
      earnedAt: true,
      monthNumber: true,
      subscriptionRevenueCents: true,
      commissionRateBps: true,
      commissionCents: true,
      status: true,
      paidAt: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    earnedAt: row.earnedAt,
    monthNumber: row.monthNumber,
    subscriptionRevenueCents: row.subscriptionRevenueCents,
    commissionRateBps: row.commissionRateBps,
    commissionCents: row.commissionCents,
    status: row.status,
    paidAt: row.paidAt,
  }));
}
