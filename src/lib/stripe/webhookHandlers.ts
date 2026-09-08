import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { PLANS, partnerTierFor } from "@/lib/plans";
import { getStripe, planForPriceId } from "./client";
import { priceIdFromSubscription } from "./billing";
import {
  applyPendingRewardsForUser,
  disqualifyReferral,
  markReferralPaid,
} from "@/lib/referrals";
import {
  countPayingClients,
  recordCommissionForInvoice,
  voidCommissionForInvoice,
} from "@/lib/partners";
import {
  sendPartnerCommissionEarned,
  sendPartnerNewPayingClient,
  sendPaymentFailed,
  sendReferralConverted,
  sendSubscriptionCanceled,
  sendSubscriptionConfirmed,
} from "@/lib/email/lifecycle";

// Stripe webhook processing.
//
// IDEMPOTENCY, which is the whole point of this file, works at two levels
// and deliberately does not depend on either one alone:
//
//   Level 1 - the event claim. processStripeEvent() inserts a StripeEvent row
//   keyed by Stripe's own event id BEFORE doing any work. A redelivery of the
//   same event hits the primary-key constraint and is skipped. If the handler
//   then throws, the claim row is deleted so Stripe's retry can genuinely
//   re-run it rather than being permanently swallowed.
//
//   Level 2 - every individual side effect is independently idempotent, so
//   even a retry that re-runs a half-finished handler cannot duplicate
//   anything: PartnerCommission.stripeInvoiceId is unique,
//   ReferralReward.referralId is unique, EmailEvent.dedupeKey is unique, and
//   Stripe credits are issued with an idempotency key derived from the reward
//   id. Level 1 makes the common case cheap; level 2 is what makes it correct.
//
// Stripe is the source of truth for billing state. The local Subscription row
// is a cache that exists so entitlement checks don't have to make a network
// call on every page load - it is only ever written FROM these events.

export interface WebhookResult {
  handled: boolean;
  duplicate?: boolean;
  detail?: string;
}

const HANDLED_EVENTS = new Set<string>([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
]);

/**
 * Entry point called by the webhook route once the signature is verified.
 */
export async function processStripeEvent(event: Stripe.Event): Promise<WebhookResult> {
  if (!HANDLED_EVENTS.has(event.type)) {
    return { handled: false, detail: `Ignored event type ${event.type}` };
  }

  // Claim the event. A duplicate delivery stops right here.
  try {
    await prisma.stripeEvent.create({
      data: {
        id: event.id,
        type: event.type,
        apiVersion: event.api_version ?? null,
      },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      return { handled: true, duplicate: true, detail: "Already processed" };
    }
    throw err;
  }

  try {
    const detail = await dispatch(event);
    return { handled: true, detail };
  } catch (err) {
    // Release the claim so Stripe's retry actually re-runs this event.
    // Without this, one transient database blip would permanently lose a
    // subscription state change.
    await prisma.stripeEvent.delete({ where: { id: event.id } }).catch(() => {});
    throw err;
  }
}

async function dispatch(event: Stripe.Event): Promise<string> {
  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return handleSubscriptionUpsert(event.data.object as Stripe.Subscription);
    case "customer.subscription.deleted":
      return handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
    case "invoice.paid":
      return handleInvoicePaid(event.data.object as Stripe.Invoice);
    case "invoice.payment_failed":
      return handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
    case "charge.refunded":
      return handleChargeRefunded(event.data.object as Stripe.Charge);
    case "charge.dispute.created":
      return handleDisputeCreated(event.data.object as Stripe.Dispute);
    default:
      return `Unhandled ${event.type}`;
  }
}

// --- Account resolution --------------------------------------------------

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

/**
 * The invoice -> subscription link, read in a way that survives Stripe's API
 * version change.
 *
 * Through 2024-06-20 an Invoice carried `subscription` and
 * `subscription_details` at the top level. From the 2025 versions onward both
 * moved under `parent.subscription_details`. Which shape arrives is decided by
 * the API version set on the WEBHOOK ENDPOINT - a dropdown in the Stripe
 * dashboard, not anything in this repository.
 *
 * That matters more than it looks. If only the old shape were read and a newer
 * payload arrived, these would return null, the handler would return early,
 * and the payment would still succeed - so a customer gets charged while the
 * referral reward and partner commission for that payment silently never fire.
 * No error, no alert, just money owed to someone that never gets recorded.
 *
 * Reading both shapes costs a few lines and removes the dependency on a
 * setting nobody in this codebase controls. The cast is needed because
 * stripe-node 16.x only types the older shape.
 */
interface InvoiceParentShape {
  parent?: {
    subscription_details?: {
      subscription?: string | { id: string } | null;
      metadata?: Record<string, string> | null;
    } | null;
  } | null;
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const legacy = idOf(invoice.subscription);
  if (legacy) return legacy;
  const nested = (invoice as Stripe.Invoice & InvoiceParentShape).parent?.subscription_details
    ?.subscription;
  return idOf(nested ?? null);
}

/**
 * Subscription period end, read across API versions.
 *
 * `current_period_end` sat on the Subscription through 2024-06-20. The 2025
 * versions moved it onto each subscription ITEM, since a subscription can now
 * carry items on different billing cycles. Stripe no longer offers 2024-06-20
 * to new accounts, so the newer shape is what actually arrives.
 *
 * This one is not cosmetic. Reading only the old field yields undefined,
 * `new Date(undefined * 1000)` is an Invalid Date, and Prisma rejects that on
 * a DateTime column. Every customer.subscription.* event would throw, the
 * event claim would be released, Stripe would retry forever, and a customer
 * who just paid would never have their account flipped to active.
 *
 * This product sells single-item subscriptions, so the item's period end is
 * the subscription's period end. max() is used so that a future multi-item
 * subscription reports the furthest date rather than an arbitrary one.
 */
function subscriptionPeriodEnd(subscription: Stripe.Subscription): Date | null {
  const legacy = (subscription as Stripe.Subscription & { current_period_end?: number })
    .current_period_end;
  if (typeof legacy === "number" && Number.isFinite(legacy)) return new Date(legacy * 1000);

  const itemEnds = (subscription.items?.data ?? [])
    .map((item) => (item as { current_period_end?: number }).current_period_end)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  return itemEnds.length ? new Date(Math.max(...itemEnds) * 1000) : null;
}

function invoiceMetadataUserId(invoice: Stripe.Invoice): string | null {
  const legacy = invoice.subscription_details?.metadata?.jobprofitaiUserId;
  if (legacy) return legacy;
  const nested = (invoice as Stripe.Invoice & InvoiceParentShape).parent?.subscription_details
    ?.metadata?.jobprofitaiUserId;
  return nested ?? null;
}

/**
 * Maps a Stripe object back to a JobProfitAI account.
 *
 * Prefers the stored stripeCustomerId (authoritative, set when we created
 * the customer) and falls back to the metadata we stamp on every customer,
 * checkout session and subscription. Returns null rather than guessing - a
 * webhook for an unknown customer is logged and ignored, never applied to
 * some other account.
 */
async function resolveUserId(params: {
  customerId?: string | null;
  metadataUserId?: string | null;
}): Promise<string | null> {
  if (params.customerId) {
    const sub = await prisma.subscription.findUnique({
      where: { stripeCustomerId: params.customerId },
      select: { userId: true },
    });
    if (sub) return sub.userId;
  }

  if (params.metadataUserId) {
    const user = await prisma.user.findUnique({
      where: { id: params.metadataUserId },
      select: { id: true },
    });
    if (user) return user.id;
  }

  return null;
}

// --- Handlers ------------------------------------------------------------

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<string> {
  const customerId = idOf(session.customer);
  const userId = await resolveUserId({
    customerId,
    metadataUserId: session.metadata?.jobprofitaiUserId ?? session.client_reference_id ?? null,
  });
  if (!userId) return "No matching account for checkout session";

  // Make sure the customer id is stored even if this is the first we've seen
  // of it (e.g. a customer created directly in the Stripe dashboard).
  if (customerId) {
    await prisma.subscription.updateMany({
      where: { userId, stripeCustomerId: null },
      data: { stripeCustomerId: customerId },
    });
  }

  const subscriptionId = idOf(session.subscription);
  if (subscriptionId) {
    // Pull the full subscription rather than trusting the slim session copy,
    // then run it through the same upsert path every subscription event uses,
    // so there is exactly one place that maps Stripe state to our columns.
    const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
    await handleSubscriptionUpsert(subscription);
  }

  // Referral credits earned while this person was still on a free trial had
  // nowhere to go (no Stripe customer existed yet). Now there is one.
  const applied = await applyPendingRewardsForUser(userId);

  return `Checkout completed for user ${userId}${applied ? `, applied ${applied} pending credit(s)` : ""}`;
}

async function handleSubscriptionUpsert(subscription: Stripe.Subscription): Promise<string> {
  const customerId = idOf(subscription.customer);
  const userId = await resolveUserId({
    customerId,
    metadataUserId: subscription.metadata?.jobprofitaiUserId ?? null,
  });
  if (!userId) return "No matching account for subscription";

  const priceId = priceIdFromSubscription(subscription);
  const plan = planForPriceId(priceId);

  const existing = await prisma.subscription.findUnique({ where: { userId } });

  const data: Record<string, unknown> = {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: priceId,
    status: subscription.status,
    currentPeriodEnd: subscriptionPeriodEnd(subscription),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
  };

  // An unrecognized price leaves `plan` untouched rather than guessing.
  // A price created by hand in the Stripe dashboard must never silently
  // grant Pro entitlements.
  if (plan) data.plan = plan;

  await prisma.subscription.update({ where: { userId }, data });

  // First transition into a live paid subscription - send the welcome.
  const becameActive = subscription.status === "active" && existing?.status !== "active";
  if (becameActive) {
    await sendSubscriptionConfirmed(userId, plan ?? existing?.plan ?? "profit_intelligence", subscription.id);
  }

  return `Subscription ${subscription.id} -> ${subscription.status} for user ${userId}`;
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<string> {
  const userId = await resolveUserId({
    customerId: idOf(subscription.customer),
    metadataUserId: subscription.metadata?.jobprofitaiUserId ?? null,
  });
  if (!userId) return "No matching account for deleted subscription";

  const endedAt = subscription.ended_at ? new Date(subscription.ended_at * 1000) : new Date();

  await prisma.subscription.update({
    where: { userId },
    data: {
      status: "canceled",
      canceledAt: endedAt,
      cancelAtPeriodEnd: false,
      // The subscription id is deliberately retained for reconciliation and
      // history; entitlement is decided by `status`, not by its presence.
    },
  });

  await sendSubscriptionCanceled(userId, subscription.id, null);

  return `Subscription ${subscription.id} canceled for user ${userId}`;
}

/**
 * The money event. Everything downstream of "a contractor actually paid" -
 * referral progress, partner commission - hangs off this one handler, so
 * that no reward can ever be generated by anything other than a real,
 * successful payment.
 */
async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<string> {
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) return "Not a subscription invoice - ignored";
  if ((invoice.amount_paid ?? 0) <= 0) return "Zero-value invoice - no commission or reward";

  const userId = await resolveUserId({
    customerId: idOf(invoice.customer),
    metadataUserId: invoiceMetadataUserId(invoice),
  });
  if (!userId) return "No matching account for paid invoice";

  const paidAt = invoice.status_transitions?.paid_at
    ? new Date(invoice.status_transitions.paid_at * 1000)
    : new Date();

  const notes: string[] = [];

  // Record the very first successful payment - this is the clock the
  // referral program's 30-day qualification runs on.
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  if (sub && !sub.firstPaidAt) {
    await prisma.subscription.update({ where: { userId }, data: { firstPaidAt: paidAt } });
    notes.push("recorded first payment");
  }

  // --- Referral / partner attribution ---
  const referral = await prisma.referral.findUnique({ where: { referredUserId: userId } });

  // Loaded separately rather than via `include`: this row decides whether a
  // partner gets paid, so the lookup is explicit and obvious at the call site.
  const partner = referral?.partnerId
    ? await prisma.partner.findUnique({
        where: { id: referral.partnerId },
        select: { id: true, userId: true, status: true },
      })
    : null;

  if (referral && referral.status !== "disqualified") {
    const wasAlreadyPaid = referral.firstPaidAt != null;
    await markReferralPaid(userId, paidAt);

    if (!wasAlreadyPaid) {
      if (referral.kind === "customer" && referral.referrerUserId) {
        // The referrer is told their referral converted. The free month
        // itself is NOT granted here - it's earned only after 30 days of
        // sustained payment, by qualifyDueReferrals().
        await sendReferralConverted(referral.referrerUserId, referral.id);
        notes.push("notified customer referrer of conversion");
      }

      if (referral.kind === "partner" && partner?.status === "approved") {
        const payingClients = await countPayingClients(partner.id);
        await sendPartnerNewPayingClient({
          partnerUserId: partner.userId,
          referralId: referral.id,
          payingClients,
          ratePct: partnerTierFor(payingClients).ratePct,
        });
        notes.push("notified partner of new paying client");
      }
    }

    // --- Partner commission, on every qualifying paid invoice ---
    if (referral.kind === "partner" && referral.partnerId && partner?.status === "approved") {
      const commission = await recordCommissionForInvoice({
        invoice,
        referralId: referral.id,
        partnerId: referral.partnerId,
        referredUserId: userId,
        paidAt,
      });

      if (commission) {
        await sendPartnerCommissionEarned({
          partnerUserId: partner.userId,
          stripeInvoiceId: invoice.id,
          amountCents: commission.commissionCents,
          monthNumber: commission.monthNumber,
        });
        notes.push(
          `commission ${commission.commissionCents}c at ${commission.rateBps / 100}% (month ${commission.monthNumber})`
        );
      } else {
        notes.push("no commission due (past 12 months, not approved, or nothing collected)");
      }
    }
  }

  return `Invoice ${invoice.id} paid for user ${userId}${notes.length ? `: ${notes.join("; ")}` : ""}`;
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<string> {
  const userId = await resolveUserId({
    customerId: idOf(invoice.customer),
    metadataUserId: invoiceMetadataUserId(invoice),
  });
  if (!userId) return "No matching account for failed invoice";

  const sub = await prisma.subscription.findUnique({ where: { userId } });

  // Don't force the status - Stripe's own subscription.updated event is
  // authoritative about whether this moved the subscription to past_due.
  // This handler exists to notify the customer, not to guess at state.
  await sendPaymentFailed(userId, sub?.plan ?? "profit_intelligence", invoice.id);

  return `Payment failed notice sent for user ${userId}`;
}

/**
 * A refund invalidates the money the reward/commission was based on, so both
 * are reversed. Partial refunds are treated the same as full ones here:
 * anything less than "they paid and kept it" is not a qualifying payment.
 */
async function handleChargeRefunded(charge: Stripe.Charge): Promise<string> {
  const invoiceId = idOf(charge.invoice);
  const notes: string[] = [];

  if (invoiceId) {
    const voided = await voidCommissionForInvoice(invoiceId, "Payment refunded");
    if (voided) notes.push("voided partner commission");
  }

  const userId = await resolveUserId({ customerId: idOf(charge.customer) });
  if (userId) {
    await disqualifyReferral(userId, "Referred customer's payment was refunded");
    notes.push("disqualified referral");
  }

  return `Refund handled${notes.length ? `: ${notes.join("; ")}` : " (nothing to reverse)"}`;
}

async function handleDisputeCreated(dispute: Stripe.Dispute): Promise<string> {
  const chargeId = idOf(dispute.charge);
  const notes: string[] = [];

  if (chargeId) {
    const charge = await getStripe().charges.retrieve(chargeId);
    const invoiceId = idOf(charge.invoice);
    if (invoiceId) {
      const voided = await voidCommissionForInvoice(invoiceId, "Payment disputed (chargeback)");
      if (voided) notes.push("voided partner commission");
    }
    const userId = await resolveUserId({ customerId: idOf(charge.customer) });
    if (userId) {
      await disqualifyReferral(userId, "Referred customer's payment was disputed");
      notes.push("disqualified referral");
    }
  }

  return `Dispute handled${notes.length ? `: ${notes.join("; ")}` : ""}`;
}

export { PLANS };
