import crypto from "crypto";
import type { Prisma, Referral } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { REFERRAL_QUALIFY_DAYS, monthlyPriceCents } from "@/lib/plans";
import { formatDate } from "@/lib/format";
import {
  applyCustomerCredit,
  findCreditByRewardId,
  paidSubscriptionHistory,
  type PaidSubscriptionHistory,
} from "@/lib/stripe/billing";

// The customer referral program: refer a paying customer, earn an account
// credit worth one month of your own current plan, capped at what the
// referred account has paid (see cappedRewardCents).
//
// The integrity rules that matter, and where each is actually enforced:
//
//   * A referred account can be attributed to exactly ONE referrer, ever.
//     Enforced by Referral.referredUserId being @unique - not by a check
//     that a race could slip past.
//   * You cannot refer yourself. Checked here, and unavoidable anyway since
//     a referrer's own account already has a code and would fail the unique
//     constraint against itself.
//   * A qualifying referral produces exactly one reward. Enforced by
//     ReferralReward.referralId being @unique, so a Stripe webhook retry
//     that re-runs qualification inserts nothing the second time.
//   * A reward is only earned after the referred customer has been
//     successfully paid for 30 days with no refund or chargeback.

/**
 * Deliberately excludes 0/O/1/I/L and vowels: these codes get read aloud,
 * texted, and hand-typed, and an ambiguous character is a lost referral.
 */
const CODE_ALPHABET = "23456789BCDFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 7;

function randomCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/** Codes are stored and compared uppercase, so links are case-insensitive. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

async function createUniqueCode(
  data: { kind: "customer"; userId: string } | { kind: "partner"; partnerId: string }
): Promise<string> {
  // 28^7 ≈ 13 billion combinations, so a collision is vanishingly unlikely -
  // but retrying a few times costs nothing and removes the failure mode
  // entirely rather than leaving it to chance.
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode();
    try {
      await prisma.referralCode.create({
        data:
          data.kind === "customer"
            ? { code, kind: "customer", userId: data.userId }
            : { code, kind: "partner", partnerId: data.partnerId },
      });
      return code;
    } catch (err) {
      const code2 = (err as { code?: string })?.code;
      if (code2 !== "P2002") throw err;
      // P2002 on `code` means a collision (retry). P2002 on userId/partnerId
      // means a concurrent request already made this owner's code - return it.
      const existing =
        data.kind === "customer"
          ? await prisma.referralCode.findUnique({ where: { userId: data.userId } })
          : await prisma.referralCode.findUnique({ where: { partnerId: data.partnerId } });
      if (existing) return existing.code;
    }
  }
  throw new Error("Could not generate a unique referral code.");
}

/** A customer's referral code, created lazily on first use. */
export async function getOrCreateCustomerReferralCode(userId: string): Promise<string> {
  const existing = await prisma.referralCode.findUnique({ where: { userId } });
  if (existing) return existing.code;
  return createUniqueCode({ kind: "customer", userId });
}

/** A partner firm's referral code, created when the partner is approved. */
export async function getOrCreatePartnerReferralCode(partnerId: string): Promise<string> {
  const existing = await prisma.referralCode.findUnique({ where: { partnerId } });
  if (existing) return existing.code;
  return createUniqueCode({ kind: "partner", partnerId });
}

/**
 * Name of the httpOnly cookie that carries a referral code from /r/[code]
 * through to signup. Lives here rather than in the route file because
 * Next.js route handlers may only export HTTP methods and a fixed set of
 * config keys - exporting anything else from a route.ts is a build error.
 */
export const REFERRAL_COOKIE = "jpai_ref";

/** How long a referral click stays attributable. */
export const REFERRAL_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** Public referral URL for a code. */
export function referralUrl(code: string): string {
  const base = (process.env.APP_URL ?? "https://jobprofitai.com").replace(/\/+$/, "");
  return `${base}/r/${code}`;
}

// --- Attribution ---------------------------------------------------------

export type AttributionResult =
  | { attributed: true; referral: Referral }
  | { attributed: false; reason: string };

/**
 * Records that a newly created account came in through a referral code.
 * Called from the signup route immediately after the user is created.
 *
 * Never throws: a referral that can't be attributed (bad code, self-referral,
 * already attributed) must never block someone from creating an account.
 * The signup succeeds and the referral is simply not credited.
 */
export async function attributeReferral(
  referredUserId: string,
  rawCode: string | null | undefined
): Promise<AttributionResult> {
  if (!rawCode) return { attributed: false, reason: "No referral code supplied." };

  try {
    const code = normalizeCode(rawCode);
    const referralCode = await prisma.referralCode.findUnique({ where: { code } });
    if (!referralCode) return { attributed: false, reason: "Unknown referral code." };

    // The owning partner is loaded with its own query rather than an
    // `include`. Slightly more code, but the relationship being checked here
    // decides whether commission gets paid, so it's worth it being an
    // explicit, obvious lookup rather than a nested option flag.
    const partner = referralCode.partnerId
      ? await prisma.partner.findUnique({ where: { id: referralCode.partnerId } })
      : null;

    // Self-referral: the code's owner signing up through their own link.
    if (referralCode.userId && referralCode.userId === referredUserId) {
      return { attributed: false, reason: "You can't refer yourself." };
    }
    if (partner && partner.userId === referredUserId) {
      return { attributed: false, reason: "You can't refer yourself." };
    }

    // Partner codes only attribute while the partner is approved and in good
    // standing - a rejected or suspended partner shouldn't keep accruing
    // referrals from links already out in the world.
    if (referralCode.kind === "partner" && partner?.status !== "approved") {
      return { attributed: false, reason: "This partner link isn't active." };
    }

    const referral = await prisma.referral.create({
      data: {
        referralCodeId: referralCode.id,
        kind: referralCode.kind,
        referrerUserId: referralCode.userId,
        partnerId: referralCode.partnerId,
        referredUserId,
        status: "signed_up",
      },
    });

    return { attributed: true, referral };
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      // referredUserId unique violation: this account is already attributed.
      return { attributed: false, reason: "This account has already been referred." };
    }
    console.error(
      "referrals: attribution failed:",
      err instanceof Error ? err.message : "Unknown error"
    );
    return { attributed: false, reason: "Referral could not be recorded." };
  }
}

/**
 * The note left on a referral by flagUnprovenReferral. It sits in
 * disqualifiedReason because that's what the admin referrals page shows
 * under the status, for any status; it says plainly that the referral was
 * NOT disqualified.
 */
export const UNPROVEN_REFERRAL_NOTE_START = "Check by hand before paying:";
export function unprovenReferralNote(provenAt: Date): string {
  return `${UNPROVEN_REFERRAL_NOTE_START} this account's email address was first proven by a password reset on ${formatDate(provenAt)}, so whoever signed up through this link may not have owned it. Nothing was changed.`;
}

/**
 * Flags for a person the referral on an account whose address was first
 * proven by a password reset, not by whoever signed up (audit Oct 27, B3).
 * Called from completePasswordReset, inside its transaction, so `db` is
 * that transaction.
 *
 * Signup attributes a referral before anyone has shown they own the
 * address. A partner (or any customer) could sign up through their own link
 * with a prospect's address; when the prospect later took the account back
 * with a reset and paid, the partner earned commission, or the referrer a
 * free month, on a customer they never brought in.
 *
 * Nothing about the referral changes: an honest customer who never clicked
 * the verification email and then forgot their password looks exactly the
 * same, and disqualifying them took up to 12 months of commission from the
 * partner who did bring them in. So only a note is left, for whoever checks
 * payouts. A reason already there (a disqualification's) is kept, and a
 * disqualified referral earns nothing anyway, so it isn't flagged.
 */
export async function flagUnprovenReferral(
  db: Prisma.TransactionClient,
  referredUserId: string,
  now: Date = new Date()
): Promise<boolean> {
  // One guarded write, so a reason written at the same moment is never overwritten.
  const flagged = await db.referral.updateMany({
    where: { referredUserId, disqualifiedReason: null, status: { not: "disqualified" } },
    data: { disqualifiedReason: unprovenReferralNote(now) },
  });
  return flagged.count > 0;
}

/**
 * Whether a referral is held for a person's check (flagUnprovenReferral):
 * no reward is made or credited for it, and no commission on it is paid
 * out, until someone decides (decideHeldReferral). The flag alone held
 * nothing back, so the money went out before anyone looked (audit Oct 27,
 * B3 review).
 */
export function isHeldForCheck(referral: { status: string; disqualifiedReason: string | null }): boolean {
  return referral.status !== "disqualified" && (referral.disqualifiedReason?.startsWith(UNPROVEN_REFERRAL_NOTE_START) ?? false);
}

/** isHeldForCheck as a query. */
export const HELD_FOR_CHECK_WHERE = {
  status: { not: "disqualified" },
  disqualifiedReason: { startsWith: UNPROVEN_REFERRAL_NOTE_START },
} satisfies Prisma.ReferralWhereInput;

/**
 * Referrals without the check note, for queries that must leave held ones
 * out (callers add their own status filter). The empty (null) note is
 * matched on its own: in SQL a NOT on startsWith is unknown for null, so a
 * bare NOT would leave out every referral with no note at all.
 */
export const WITHOUT_CHECK_NOTE_WHERE = {
  OR: [{ disqualifiedReason: null }, { NOT: { disqualifiedReason: { startsWith: UNPROVEN_REFERRAL_NOTE_START } } }],
} satisfies Prisma.ReferralWhereInput;

/** The note added to commission already paid out when its referral is disqualified, as for a refund. */
export function commissionReviewNote(reason: string, now: Date): string {
  return `REVIEW ${now.toISOString().slice(0, 10)}: ${reason} after this commission was paid out.`;
}

/** Of these referrals, the ones held for a check. */
export async function referralsHeldForCheck(referralIds: string[]): Promise<Set<string>> {
  if (referralIds.length === 0) return new Set();
  const held = await prisma.referral.findMany({
    where: { id: { in: referralIds }, ...HELD_FOR_CHECK_WHERE },
    select: { id: true },
  });
  return new Set(held.map((r) => r.id));
}

/** The reason a referral disqualified after a person's check is given. */
export const CHECKED_AND_DISQUALIFIED_REASON =
  "Disqualified by hand: a person checked this referral after its email address was first proven by a password reset.";
const NOT_WAITING_MESSAGE = "This referral isn't waiting for a check any more. Refresh the page to see where it stands.";

export type HeldReferralDecision = "clear" | "disqualify";
export type HeldReferralResult =
  | { ok: true; decision: "cleared" | "disqualified" }
  | { ok: false; error: string; status: number };

/**
 * A person's decision on a referral held for a check (the admin referrals
 * and partners pages).
 *
 * "clear" (Looks fine) takes the note off and changes nothing else, so the
 * referral earns as usual from then on: the next qualification run makes
 * its reward if it still meets the rules, and its commission can be paid.
 *
 * "disqualify" goes the way a refund's disqualification does
 * (disqualifyReferral): the status, the reason and any reward voided. Its
 * commission that is earned but not yet paid out is voided too, since that
 * is what the hold was keeping back. Commission already paid stays paid,
 * with a REVIEW note as a refund leaves. Both apply only while it's still
 * held, so two people deciding at once can't both succeed.
 */
export async function decideHeldReferral(
  referralId: string,
  decision: HeldReferralDecision,
  now: Date = new Date()
): Promise<HeldReferralResult> {
  const referral = await prisma.referral.findUnique({ where: { id: referralId } });
  if (!referral) return { ok: false, error: "Referral not found.", status: 404 };
  if (!isHeldForCheck(referral)) return { ok: false, error: NOT_WAITING_MESSAGE, status: 409 };

  if (decision === "clear") {
    // Guarded, so it can't undo a decision made at the same moment elsewhere.
    const cleared = await prisma.referral.updateMany({
      where: { id: referral.id, ...HELD_FOR_CHECK_WHERE },
      data: { disqualifiedReason: null },
    });
    return cleared.count > 0 ? { ok: true, decision: "cleared" } : { ok: false, error: NOT_WAITING_MESSAGE, status: 409 };
  }

  const done = await disqualify(referral, CHECKED_AND_DISQUALIFIED_REASON, now, { byHandAfterCheck: true });
  return done ? { ok: true, decision: "disqualified" } : { ok: false, error: NOT_WAITING_MESSAGE, status: 409 };
}

/** The referral that brought this account in, if any. */
export async function getReferralForUser(userId: string) {
  return prisma.referral.findUnique({ where: { referredUserId: userId } });
}

// --- Lifecycle transitions ----------------------------------------------

/**
 * Marks a referral as converted the first time the referred customer pays.
 * Only moves a referral forward from "signed_up", and only sets firstPaidAt
 * once, so replaying an invoice event is a no-op.
 */
export async function markReferralPaid(
  referredUserId: string,
  paidAt: Date
): Promise<Referral | null> {
  const referral = await prisma.referral.findUnique({ where: { referredUserId } });
  if (!referral) return null;
  if (referral.firstPaidAt) return referral;
  if (referral.status === "disqualified") return referral;

  return prisma.referral.update({
    where: { id: referral.id },
    data: { status: "paid", firstPaidAt: paidAt },
  });
}

/**
 * Refund / chargeback handling. Disqualifies the referral and voids an
 * already-earned reward. If the reward had already been credited in Stripe,
 * the credit is deliberately NOT clawed back automatically - reversing money
 * on a customer's balance without a human looking at it is the kind of
 * action that turns one billing dispute into two. The reward is marked
 * voided so it shows in the admin view for a decision.
 */
export async function disqualifyReferral(
  referredUserId: string,
  reason: string,
  now: Date = new Date()
): Promise<void> {
  const referral = await prisma.referral.findUnique({ where: { referredUserId } });
  if (!referral || referral.status === "disqualified") return;
  await disqualify(referral, reason, now);
}

/** What commission already paid out on a referral disqualified by hand is flagged with. */
const CHECKED_COMMISSION_REVIEW_REASON = "Referral disqualified by hand on a check";

/**
 * The disqualification itself, shared by disqualifyReferral and a person's
 * decision on a held referral (decideHeldReferral). Returns false, having
 * changed nothing, when the referral wasn't in the state the caller decided
 * on by the time of the write.
 *
 * A decision after a check (byHandAfterCheck) applies only while the
 * referral is still held: "Looks fine" at the same moment in another tab
 * could otherwise be followed by this, and both report success. It also
 * voids the commission the hold kept back, and flags commission already
 * paid out on the referral for review, the way a refund does
 * (flagPaidCommissionsForReview in partners.ts).
 */
async function disqualify(
  referral: Referral,
  reason: string,
  now: Date,
  opts: { byHandAfterCheck?: boolean } = {}
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const changed = await tx.referral.updateMany({
      where: { id: referral.id, ...(opts.byHandAfterCheck ? HELD_FOR_CHECK_WHERE : { status: { not: "disqualified" } }) },
      data: { status: "disqualified", disqualifiedAt: now, disqualifiedReason: reason },
    });
    if (changed.count === 0) return false;

    const reward = await tx.referralReward.findUnique({ where: { referralId: referral.id } });
    if (reward && reward.status !== "voided") {
      await tx.referralReward.update({
        where: { id: reward.id },
        data: { status: "voided", voidedAt: now, voidReason: reason },
      });
    }

    if (opts.byHandAfterCheck) {
      await tx.partnerCommission.updateMany({
        where: { referralId: referral.id, status: "earned" },
        data: { status: "voided", voidedAt: now, voidReason: reason },
      });
      const paidOut = await tx.partnerCommission.findMany({
        where: { referralId: referral.id, status: "paid" },
        select: { id: true, paidNote: true },
      });
      const note = commissionReviewNote(CHECKED_COMMISSION_REVIEW_REASON, now);
      for (const row of paidOut) {
        await tx.partnerCommission.update({
          where: { id: row.id },
          data: { paidNote: row.paidNote ? `${row.paidNote}\n${note}` : note },
        });
      }
    }
    return true;
  });
}

// --- Qualification and rewards ------------------------------------------

/**
 * A referral reward: one month of the referrer's plan, but never more than
 * the referred account actually paid. Pure, for tests.
 */
export function cappedRewardCents(referrerMonthCents: number, referredPaidCents: number): number {
  return Math.max(0, Math.min(Math.round(referrerMonthCents), Math.floor(referredPaidCents)));
}

/**
 * Whether the referred account has paid for its first renewal: at least two
 * subscription invoices paid and kept (the first month and a renewal), one
 * of them a renewal. Two invoices alone could be the first month and a
 * mid-month plan change. Pure, for tests.
 */
export function renewalPaid(paid: Pick<PaidSubscriptionHistory, "paidInvoices" | "paidRenewals">): boolean {
  return paid.paidInvoices >= 2 && paid.paidRenewals >= 1;
}

export interface QualifyResult {
  referralId: string;
  rewardId: string;
  referrerUserId: string;
  amountCents: number;
  plan: string;
  creditApplied: boolean;
}

/**
 * Finds customer referrals that have now been paid for 30 days and issues
 * the referrer's reward. Safe to run on every cron tick.
 *
 * Runs as: create the reward row first (the @unique on referralId is what
 * makes this exactly-once), THEN call Stripe. Deliberately not the other way
 * around and deliberately not inside a transaction - a Stripe call inside a
 * database transaction holds a connection open across a network round trip,
 * and a crash between the two would leave money moved with no record of it.
 * This ordering can only ever fail "safe": a reward row with no credit yet,
 * which the next run picks up.
 */
export async function qualifyDueReferrals(now: Date = new Date()): Promise<QualifyResult[]> {
  const cutoff = new Date(now.getTime() - REFERRAL_QUALIFY_DAYS * 86_400_000);

  const due = await prisma.referral.findMany({
    where: {
      kind: "customer",
      status: "paid",
      firstPaidAt: { not: null, lte: cutoff },
      qualifiedAt: null,
      reward: null,
      referrerUserId: { not: null },
      // Not while it's held for a person's check (isHeldForCheck). Left out
      // of the query, not skipped after it, so held ones can't fill the 200
      // and keep others waiting. Once cleared it qualifies on a later run if
      // it still meets the rules.
      ...WITHOUT_CHECK_NOTE_WHERE,
    },
    take: 200,
  });

  const results: QualifyResult[] = [];

  for (const referral of due) {
    try {
      // Re-check that the referred customer is STILL paying. Someone who
      // subscribed and cancelled inside the 30-day window shouldn't earn
      // anyone a free month. A missing referredUserId means that account was
      // deleted, which is likewise not a qualifying outcome.
      const referredSubscription = referral.referredUserId
        ? await prisma.subscription.findUnique({
            where: { userId: referral.referredUserId },
            select: { status: true, cancelAtPeriodEnd: true, stripeCustomerId: true },
          })
        : null;
      const referredStatus = referredSubscription?.status;

      // past_due is deliberately neither a qualification nor a
      // disqualification. The referred customer's card has failed and Stripe
      // is still retrying; issuing a free month worth $149-$299 off a payment
      // that is currently failing is wrong, and so is destroying the referral
      // over a card that expired. The referral stays "paid" with qualifiedAt
      // null, so it is still matched by the `due` query above and re-checked
      // on the next run. If the retries never succeed, Stripe moves the
      // subscription to unpaid or canceled and the branch below ends it then.
      if (referredStatus === "past_due") continue;

      // Still "active" but already set to cancel: not a qualification yet,
      // and not a disqualification. Re-checked each run; if the subscription
      // ends, the branch below disqualifies it.
      if (referredStatus === "active" && referredSubscription?.cancelAtPeriodEnd) continue;

      if (referredStatus !== "active") {
        await prisma.referral.update({
          where: { id: referral.id },
          data: {
            status: "disqualified",
            disqualifiedAt: now,
            disqualifiedReason: `Referred account was ${referredStatus ?? "not subscribed"} at the 30-day qualification check.`,
          },
        });
        continue;
      }

      const referrerUserId = referral.referrerUserId!;
      const referrerSub = await prisma.subscription.findUnique({
        where: { userId: referrerUserId },
      });

      // The reward is one month of the referrer's CURRENT plan, priced at
      // the moment it qualifies and then frozen on the reward row.
      const plan = referrerSub?.plan ?? "profit_intelligence";
      // Firm: a month at its minimum, whatever the firm is billed. A reward
      // that grew with a large firm's bill would make fake referrals pay.
      // And never more than the referred account has actually paid: a fake
      // $149 referral that renews once pays $298, and a Firm referrer's
      // month is $316, so without the cap it turned a profit. A Stripe error
      // here throws, and the referral is simply tried again next run.
      const paid: PaidSubscriptionHistory = referredSubscription?.stripeCustomerId
        ? await paidSubscriptionHistory(referredSubscription.stripeCustomerId)
        : { revenueCents: 0, paidInvoices: 0, paidRenewals: 0 };

      // Not past a PAID first renewal yet: wait, re-checked each run. The
      // credit is a month of the REFERRER's plan, so a $299 customer could
      // otherwise refer an account of their own at $149, cancel it at once,
      // and be credited $299 when it's still "active" at day 30. Waiting for
      // the first renewal to be paid means that costs at least as much as it
      // earns ($298 paid for a $299 credit), so it no longer pays. The
      // subscription's period end can't show this: Stripe moves it when it
      // creates the renewal invoice, before the card is charged, so a renewal
      // that then fails looked renewed and the cap came out at one month.
      if (paid.revenueCents > 0 && !renewalPaid(paid)) continue;

      const amountCents = cappedRewardCents(monthlyPriceCents(plan, null), paid.revenueCents);
      if (amountCents <= 0) {
        // Every payment was covered by credits or refunded: nothing was paid
        // to share. Ended rather than retried, so it can't sit at the front
        // of this query forever.
        await prisma.referral.update({
          where: { id: referral.id },
          data: {
            status: "disqualified",
            disqualifiedAt: now,
            disqualifiedReason: "Referred account had paid nothing at the qualification check (all credits or refunds).",
          },
        });
        continue;
      }

      const reward = await prisma.$transaction(async (tx) => {
        const created = await tx.referralReward.create({
          data: {
            referralId: referral.id,
            referrerUserId,
            amountCents,
            plan,
            status: "pending",
          },
        });
        await tx.referral.update({
          where: { id: referral.id },
          data: { status: "qualified", qualifiedAt: now },
        });
        return created;
      });

      const creditApplied = await tryApplyReward(reward.id);

      results.push({
        referralId: referral.id,
        rewardId: reward.id,
        referrerUserId,
        amountCents,
        plan,
        creditApplied,
      });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") continue; // already rewarded
      console.error(
        `referrals: qualification failed for referral ${referral.id}:`,
        err instanceof Error ? err.message : "Unknown error"
      );
    }
  }

  return results;
}

/**
 * Pushes a pending reward onto the referrer's Stripe customer balance.
 *
 * Returns false (rather than throwing) when the referrer has no Stripe
 * customer yet - a trialing customer can absolutely earn a referral reward
 * before they ever subscribe, and it should sit waiting for them rather than
 * being lost. applyPendingRewardsForUser() below picks those up at checkout.
 *
 * Double-crediting is prevented in two layers, because one is not enough.
 * The Stripe idempotency key is the reward id, which covers a retry inside
 * 24 hours. Past that Stripe forgets the key, so this first asks Stripe
 * whether a credit carrying this reward id is already on the customer's
 * balance. That is the case that actually bites: the credit succeeds, the
 * database write that follows it fails, the reward stays "pending", and the
 * retry lands days later - a window the idempotency key alone does not
 * cover. The row is repaired from the existing transaction instead.
 */
export async function tryApplyReward(rewardId: string): Promise<boolean> {
  const reward = await prisma.referralReward.findUnique({ where: { id: rewardId } });
  if (!reward || reward.status !== "pending") return false;

  // No credit while its referral is held for a person's check (a reward
  // made before the flag, say). It stays pending, and retryPendingRewards
  // or the next checkout applies it once the referral is cleared.
  const referral = await prisma.referral.findUnique({
    where: { id: reward.referralId },
    select: { status: true, disqualifiedReason: true },
  });
  if (referral && isHeldForCheck(referral)) return false;

  const referrerSubscription = await prisma.subscription.findUnique({
    where: { userId: reward.referrerUserId },
    select: { stripeCustomerId: true },
  });
  const customerId = referrerSubscription?.stripeCustomerId;
  if (!customerId) return false; // stays pending until they have a Stripe customer

  try {
    const existing = await findCreditByRewardId(customerId, reward.id);
    if (existing) {
      await prisma.referralReward.update({
        where: { id: reward.id },
        data: {
          status: "applied",
          appliedAt: reward.appliedAt ?? new Date(),
          stripeBalanceTxnId: existing.id,
        },
      });
      return true;
    }

    const txn = await applyCustomerCredit({
      customerId,
      amountCents: reward.amountCents,
      description: "JobProfitAI referral credit",
      idempotencyKey: `referral-reward:${reward.id}`,
      metadata: { rewardId: reward.id, referralId: reward.referralId },
    });

    await prisma.referralReward.update({
      where: { id: reward.id },
      data: { status: "applied", appliedAt: new Date(), stripeBalanceTxnId: txn.id },
    });
    return true;
  } catch (err) {
    console.error(
      `referrals: could not apply credit for reward ${rewardId}:`,
      err instanceof Error ? err.message : "Unknown error"
    );
    return false; // left pending; retried on the next cron run
  }
}

/**
 * Retries every reward still sitting at "pending", whatever stranded it.
 *
 * qualifyDueReferrals() only ever looks at referrals with no reward row at
 * all (`reward: null`), so once a reward exists it is invisible to that
 * sweep. A reward left pending by a Stripe outage, or by a referrer who had
 * no Stripe customer at the time, was therefore never retried by anything -
 * despite tryApplyReward's own comment promising it would be. The only path
 * that picked those up was checkout, which a referrer who is already
 * subscribed never walks again. That is a credit someone earned and would
 * simply never receive.
 *
 * Cheap to run on every tick: a pending reward whose referrer still has no
 * Stripe customer costs one indexed query and returns before touching Stripe.
 *
 * The referral is re-checked per reward rather than filtered in the query.
 * disqualifyReferral marks the reward "voided" so those are already out, but
 * a referral disqualified by some future path that forgets to void must not
 * quietly pay out here, and this is money.
 */
export async function retryPendingRewards(limit = 200): Promise<number> {
  // Rewards whose referral is held for a check are left out of the query,
  // not skipped after it, so they can't fill the batch and keep others
  // waiting (audit Oct 27, B3 review). They're picked up once cleared.
  const held = await prisma.referral.findMany({ where: HELD_FOR_CHECK_WHERE, select: { id: true } });
  const pending = await prisma.referralReward.findMany({
    where: { status: "pending", ...(held.length > 0 ? { referralId: { notIn: held.map((r) => r.id) } } : {}) },
    select: { id: true, referralId: true },
    take: limit,
  });

  let applied = 0;
  for (const reward of pending) {
    try {
      const referral = await prisma.referral.findUnique({
        where: { id: reward.referralId },
        select: { status: true },
      });
      if (referral?.status === "disqualified") continue;

      if (await tryApplyReward(reward.id)) applied++;
    } catch (err) {
      console.error(
        `referrals: retry failed for reward ${reward.id}:`,
        err instanceof Error ? err.message : "Unknown error"
      );
    }
  }
  return applied;
}

/**
 * Applies any rewards that were earned while the referrer had no Stripe
 * customer. Called right after a successful checkout, so credits earned
 * during someone's trial land on their very first invoice.
 */
export async function applyPendingRewardsForUser(userId: string): Promise<number> {
  const pending = await prisma.referralReward.findMany({
    where: { referrerUserId: userId, status: "pending" },
    select: { id: true },
  });

  let applied = 0;
  for (const reward of pending) {
    if (await tryApplyReward(reward.id)) applied++;
  }
  return applied;
}

// --- Reporting -----------------------------------------------------------

export interface ReferralSummary {
  code: string;
  url: string;
  signedUp: number;
  paying: number;
  qualified: number;
  pendingRewardCents: number;
  appliedRewardCents: number;
  totalEarnedCents: number;
}

/** Everything the in-app referral dashboard needs, for one customer. */
export async function getReferralSummary(userId: string): Promise<ReferralSummary> {
  const code = await getOrCreateCustomerReferralCode(userId);

  const [referrals, allRewards] = await Promise.all([
    prisma.referral.findMany({
      where: { referrerUserId: userId },
      select: { id: true, status: true, disqualifiedReason: true },
    }),
    prisma.referralReward.findMany({
      where: { referrerUserId: userId },
      select: { status: true, amountCents: true, referralId: true },
    }),
  ]);

  // A reward on a referral held for a check isn't counted as earned or
  // waiting: the page says it applies automatically, and it won't until the
  // check is done. Its history row says it's being checked (audit Oct 27, B3).
  const held = new Set(referrals.filter(isHeldForCheck).map((r) => r.id));
  const rewards = allRewards.filter((r) => !held.has(r.referralId));
  const sum = (status: string) =>
    rewards.filter((r) => r.status === status).reduce((t, r) => t + r.amountCents, 0);

  return {
    code,
    url: referralUrl(code),
    signedUp: referrals.length,
    paying: referrals.filter((r) => r.status === "paid" || r.status === "qualified").length,
    qualified: referrals.filter((r) => r.status === "qualified").length,
    pendingRewardCents: sum("pending"),
    appliedRewardCents: sum("applied"),
    totalEarnedCents: sum("pending") + sum("applied"),
  };
}

/**
 * Referral history rows for the dashboard.
 *
 * PRIVACY: deliberately returns no identifying detail about the referred
 * business - no name, no email, no company. A referrer is entitled to know
 * their link converted and that they earned a credit; they are not entitled
 * to another contractor's account details just because they shared a link.
 */
export async function getReferralHistory(userId: string) {
  const referrals = await prisma.referral.findMany({
    where: { referrerUserId: userId },
    orderBy: { signedUpAt: "desc" },
    take: 100,
  });

  const rewards = await prisma.referralReward.findMany({
    where: { referralId: { in: referrals.map((r) => r.id) } },
  });
  const rewardByReferral = new Map(rewards.map((reward) => [reward.referralId, reward]));

  return referrals.map((r) => {
    const reward = rewardByReferral.get(r.id);
    return {
      id: r.id,
      status: r.status,
      signedUpAt: r.signedUpAt,
      firstPaidAt: r.firstPaidAt,
      qualifiedAt: r.qualifiedAt,
      rewardStatus: reward?.status ?? null,
      rewardAmountCents: reward?.amountCents ?? null,
      rewardAppliedAt: reward?.appliedAt ?? null,
      // Two cases the page words for itself, without saying why: nothing
      // was refunded or reversed in either (audit Oct 27, B3 review).
      beingChecked: isHeldForCheck(r),
      disqualifiedAfterCheck: r.status === "disqualified" && r.disqualifiedReason === CHECKED_AND_DISQUALIFIED_REASON,
    };
  });
}
