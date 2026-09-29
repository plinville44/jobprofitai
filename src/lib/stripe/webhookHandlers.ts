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
  flagPaidCommissionsForReview,
  recordCommissionForInvoice,
  voidCommissionForInvoice,
} from "@/lib/partners";
import {
  sendPartnerCommissionEarned,
  sendPartnerNewPayingClient,
  sendPartnerTierUpgrade,
  sendPaymentFailed,
  sendReferralConverted,
  sendSubscriptionCanceled,
  sendSubscriptionConfirmed,
} from "@/lib/email/lifecycle";
import { SUPPORT_EMAIL, sendLifecycleEmail } from "@/lib/email/client";
import { overLimitConnectionIds } from "@/lib/planLimits";
import {
  DUPLICATE_OF_METADATA_KEY,
  DUPLICATE_REFUND_METADATA_KEY,
  isLiveSubscriptionStatus,
  originalSubscriptionFor,
  type SubscriptionSummary,
} from "./duplicateSubscription";
import { isFirmInvoice } from "./invoicePlan";

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
      return handleSubscriptionUpsert(event.data.object as Stripe.Subscription, event.created);
    case "customer.subscription.deleted":
      return handleSubscriptionDeleted(event.data.object as Stripe.Subscription, event.created);
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

    // A second checkout that got paid while another subscription was
    // already live (two tabs, a double click on two plans). The older one is
    // kept and this one is cancelled and refunded. See duplicateSubscription.ts.
    const original = await findOriginalSubscription(userId, customerId ?? idOf(subscription.customer), subscription);
    if (original) return cancelDuplicateSubscription(userId, subscription, original);

    // Just retrieved, so it is newer than any event still in flight.
    await handleSubscriptionUpsert(subscription, Math.floor(Date.now() / 1000));
  }

  // A Firm subscription starts at the companies connected when checkout
  // began; put it right if one was connected or disconnected since.
  if (subscriptionId && session.metadata?.plan === "firm") {
    const { syncFirmQuantity } = await import("./firmQuantity");
    await syncFirmQuantity(userId);
  }

  // Referral credits earned while this person was still on a free trial had
  // nowhere to go (no Stripe customer existed yet). Now there is one.
  const applied = await applyPendingRewardsForUser(userId);

  // The company limit was checked when checkout started, but companies can
  // be connected while the checkout page is open. Nothing needs storing:
  // the newest ones past the limit are paused from here on (planLimits.ts)
  // and Billing says so. Noted here so it shows in Stripe's webhook log.
  const paused = await pausedNote(userId);

  return `Checkout completed for user ${userId}${applied ? `, applied ${applied} pending credit(s)` : ""}${paused}`;
}

/** ", N companies paused (past the plan's limit)", or "" when none are. */
async function pausedNote(userId: string): Promise<string> {
  const paused = await overLimitConnectionIds(userId);
  return paused.size > 0 ? `, ${paused.size} compan${paused.size === 1 ? "y" : "ies"} paused (past the plan's limit)` : "";
}

// --- A second subscription from a duplicate checkout -----------------------

function summarize(subscription: Stripe.Subscription): SubscriptionSummary {
  return { id: subscription.id, status: subscription.status, created: subscription.created ?? 0 };
}

/**
 * The live subscription a just-completed checkout duplicates, or null when
 * the checkout's subscription stands. Asks Stripe for all of the customer's
 * subscriptions, since our own row may not have caught up (or may already
 * have been overwritten by the duplicate's own events), plus the one on file
 * in case it sits on another Stripe customer.
 */
async function findOriginalSubscription(
  userId: string,
  customerId: string | null,
  created: Stripe.Subscription
): Promise<Stripe.Subscription | null> {
  const stripe = getStripe();
  const candidates: Stripe.Subscription[] = [];
  if (customerId) {
    const page = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 });
    candidates.push(...(page.data as Stripe.Subscription[]));
  }
  const onFile = await prisma.subscription.findUnique({
    where: { userId },
    select: { stripeSubscriptionId: true, status: true },
  });
  if (
    onFile?.stripeSubscriptionId &&
    onFile.stripeSubscriptionId !== created.id &&
    isLiveSubscriptionStatus(onFile.status) &&
    !candidates.some((c: Stripe.Subscription) => c.id === onFile.stripeSubscriptionId)
  ) {
    candidates.push(await stripe.subscriptions.retrieve(onFile.stripeSubscriptionId));
  }
  const original = originalSubscriptionFor(summarize(created), candidates.map(summarize));
  return original ? candidates.find((c: Stripe.Subscription) => c.id === original.id) ?? null : null;
}

/**
 * Cancels a duplicate subscription at once, refunds its first payment, keeps
 * the original on file and emails the admin. Every step is safe to repeat,
 * because Stripe retries this event: a cancelled subscription isn't
 * cancelled again, a refunded charge isn't refunded again (checked, and an
 * idempotency key besides), and the admin email has a dedupe key.
 *
 * Throws only when the duplicate could not be cancelled, so Stripe retries
 * the event; the admin has been told either way. The Stripe calls follow
 * API 2024-06-20 and are not verified against live Stripe.
 */
async function cancelDuplicateSubscription(
  userId: string,
  duplicate: Stripe.Subscription,
  original: Stripe.Subscription
): Promise<string> {
  const stripe = getStripe();

  // The duplicate's own events may have replaced the original on file.
  // Put the original back first, so the duplicate's cancellation (and its
  // "subscription deleted" event) can't end the customer's access.
  await handleSubscriptionUpsert(original, Math.floor(Date.now() / 1000));

  let cancelled = duplicate.status === "canceled" || duplicate.status === "incomplete_expired";
  let cancelProblem: string | null = null;
  if (!cancelled) {
    try {
      // Marked first, so every later event about it says what it is.
      await stripe.subscriptions.update(duplicate.id, {
        metadata: { [DUPLICATE_OF_METADATA_KEY]: original.id },
      });
      await stripe.subscriptions.cancel(
        duplicate.id,
        { invoice_now: false, prorate: false, cancellation_details: { comment: `Duplicate of ${original.id}` } },
        { idempotencyKey: `duplicate-cancel:${duplicate.id}` }
      );
      cancelled = true;
    } catch (err) {
      const again: Stripe.Subscription | null = await stripe.subscriptions.retrieve(duplicate.id).catch(() => null);
      if (again?.status === "canceled") cancelled = true;
      else cancelProblem = err instanceof Error ? err.message : "Unknown error";
    }
  }

  let refund: { ok: boolean; note: string };
  try {
    refund = await refundFirstPayment(duplicate);
  } catch (err) {
    refund = { ok: false, note: `refund failed: ${err instanceof Error ? err.message : "Unknown error"}` };
  }

  await notifyAdminOfDuplicate({ userId, duplicate, original, cancelled, cancelProblem, refund });

  if (!cancelled) {
    throw new Error(`Duplicate subscription ${duplicate.id} could not be cancelled: ${cancelProblem}`);
  }
  return `Duplicate subscription ${duplicate.id} cancelled for user ${userId} (kept ${original.id}); ${refund.note}`;
}

/** Refunds a duplicate subscription's first invoice in full, once. */
async function refundFirstPayment(duplicate: Stripe.Subscription): Promise<{ ok: boolean; note: string }> {
  const stripe = getStripe();
  const invoiceId = idOf(duplicate.latest_invoice);
  if (!invoiceId) return { ok: true, note: "no invoice, nothing to refund" };

  const invoice: Stripe.Invoice = await stripe.invoices.retrieve(invoiceId);
  if (invoice.status === "open") {
    // Not paid yet (a payment still settling): make sure it never is.
    await stripe.invoices.voidInvoice(invoiceId);
    return { ok: true, note: `unpaid invoice ${invoiceId} voided` };
  }
  if ((invoice.amount_paid ?? 0) <= 0) return { ok: true, note: "nothing was paid" };

  const chargeId = idOf(invoice.charge);
  const paymentIntentId = idOf(invoice.payment_intent);
  if (!chargeId && !paymentIntentId) {
    return { ok: false, note: `no charge found on invoice ${invoiceId}; refund it by hand` };
  }
  if (chargeId) {
    const charge: Stripe.Charge = await stripe.charges.retrieve(chargeId);
    if (charge.refunded || (charge.amount_refunded ?? 0) >= (charge.amount ?? 0)) {
      return { ok: true, note: `charge ${chargeId} already refunded` };
    }
  }
  const refund = await stripe.refunds.create(
    {
      // Stripe's types take a string or nothing here, never null.
      ...(chargeId ? { charge: chargeId } : { payment_intent: paymentIntentId ?? undefined }),
      reason: "duplicate",
      metadata: { [DUPLICATE_REFUND_METADATA_KEY]: duplicate.id },
    },
    { idempotencyKey: `duplicate-refund:${duplicate.id}` }
  );
  return { ok: true, note: `refunded $${((refund.amount ?? invoice.amount_paid ?? 0) / 100).toFixed(2)}` };
}

/** Emails the admin about a duplicate subscription, once per outcome. Never throws. */
async function notifyAdminOfDuplicate(params: {
  userId: string;
  duplicate: Stripe.Subscription;
  original: Stripe.Subscription;
  cancelled: boolean;
  cancelProblem: string | null;
  refund: { ok: boolean; note: string };
}): Promise<void> {
  const { userId, duplicate, original, cancelled, cancelProblem, refund } = params;
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    const planOf = (s: Stripe.Subscription) => planForPriceId(priceIdFromSubscription(s)) ?? "unknown plan";
    const done = cancelled && refund.ok;
    const lines = [
      `Account: ${user?.email ?? userId}`,
      `Kept: ${original.id} (${planOf(original)}, ${original.status})`,
      `Second subscription: ${duplicate.id} (${planOf(duplicate)}), ${cancelled ? "cancelled" : `NOT cancelled: ${cancelProblem}`}`,
      `First payment: ${refund.note}`,
      "",
      done
        ? "Two checkouts were paid for this account. The second was cancelled and refunded automatically. You may want to let the customer know."
        : "Two checkouts were paid for this account and this couldn't be fully put right automatically. Please finish it in the Stripe dashboard.",
    ].join("\n");
    await sendLifecycleEmail({
      userId,
      emailType: "admin_duplicate_subscription",
      dedupeKey: `admin_duplicate_subscription:${duplicate.id}:${done ? "done" : "problem"}`,
      to: process.env.CONTACT_TO_EMAIL?.trim() || SUPPORT_EMAIL,
      replyTo: user?.email ?? SUPPORT_EMAIL,
      subject: `[Billing] Second subscription ${done ? "cancelled and refunded" : "needs attention"}: ${user?.email ?? userId}`,
      text: lines,
      html: `<pre style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;white-space:pre-wrap;">${lines
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</pre>`,
    });
  } catch (err) {
    console.error("stripe: duplicate subscription notice failed:", err instanceof Error ? err.message : "Unknown error");
  }
}

/**
 * Whether a refunded charge was refunded by cancelDuplicateSubscription.
 * The customer is still paying on the subscription that was kept, so that
 * refund must not end their referral. False when it can't be told.
 */
async function refundIsForDuplicate(charge: Stripe.Charge): Promise<boolean> {
  try {
    const listed = charge.refunds?.data;
    const refunds: { metadata?: Record<string, string> | null }[] = Array.isArray(listed)
      ? listed
      : (await getStripe().refunds.list({ charge: charge.id, limit: 10 })).data;
    return refunds.some((r) => Boolean(r?.metadata?.[DUPLICATE_REFUND_METADATA_KEY]));
  } catch {
    return false;
  }
}

/**
 * Stripe does not deliver events in order. Two guards keep a late event from
 * undoing a newer state:
 *   - an event created before the newest one already applied is ignored;
 *   - a subscription never goes from active back to incomplete, so an
 *     "incomplete" for the subscription already active on file (the
 *     created event, arriving after the updated one in the same second) is
 *     ignored.
 * `eventCreated` is Stripe's event.created (seconds).
 */
async function handleSubscriptionUpsert(subscription: Stripe.Subscription, eventCreated?: number): Promise<string> {
  const customerId = idOf(subscription.customer);
  const userId = await resolveUserId({
    customerId,
    metadataUserId: subscription.metadata?.jobprofitaiUserId ?? null,
  });
  if (!userId) return "No matching account for subscription";

  // A subscription cancelled as a second, duplicate checkout is never put
  // on file (see cancelDuplicateSubscription).
  const duplicateOf = subscription.metadata?.[DUPLICATE_OF_METADATA_KEY];
  if (duplicateOf) return `Event for ${subscription.id} ignored: cancelled as a duplicate of ${duplicateOf}`;

  const priceId = priceIdFromSubscription(subscription);
  const plan = planForPriceId(priceId);

  const existing = await prisma.subscription.findUnique({ where: { userId } });

  const eventAt = typeof eventCreated === "number" ? new Date(eventCreated * 1000) : null;
  if (eventAt && existing?.stripeEventAt && existing.stripeEventAt.getTime() > eventAt.getTime()) {
    return `Stale event for ${subscription.id} ignored (older than the state on file)`;
  }
  if (
    existing != null &&
    existing.stripeSubscriptionId === subscription.id &&
    existing.status === "active" &&
    (subscription.status === "incomplete" || subscription.status === "incomplete_expired")
  ) {
    return `Out-of-order ${subscription.status} for active ${subscription.id} ignored`;
  }
  // A canceled Stripe subscription never comes back: Stripe starts a new
  // one instead. A late or retried update for the same id must not revive
  // it (and send "subscription confirmed" again).
  if (
    existing != null &&
    existing.stripeSubscriptionId === subscription.id &&
    existing.status === "canceled" &&
    subscription.status !== "canceled"
  ) {
    return `Late ${subscription.status} for canceled ${subscription.id} ignored`;
  }
  // An event about some other subscription (an abandoned second checkout,
  // say) must not overwrite a live one.
  if (
    existing?.stripeSubscriptionId &&
    existing.stripeSubscriptionId !== subscription.id &&
    (existing.status === "active" || existing.status === "past_due") &&
    subscription.status !== "active"
  ) {
    return `Event for ${subscription.id} ignored: ${existing.stripeSubscriptionId} is the live subscription`;
  }

  const data: Record<string, unknown> = {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: priceId,
    status: subscription.status,
    // Firm is billed per company; the quantity shows on the Billing page.
    quantity: subscription.items.data[0]?.quantity ?? null,
    currentPeriodEnd: subscriptionPeriodEnd(subscription),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
    ...(eventAt ? { stripeEventAt: eventAt } : {}),
  };

  // An unrecognized price leaves `plan` untouched rather than guessing.
  // A price created by hand in the Stripe dashboard must never silently
  // grant Pro entitlements.
  if (plan) data.plan = plan;

  await prisma.subscription.update({ where: { userId }, data });

  // Firm is billed per company. A subscription that has just become Firm
  // (a plan change made in Stripe) is brought to the right quantity, and one
  // moved off Firm is set back to one.
  const quantity = subscription.items.data[0]?.quantity ?? null;
  const effectivePlan = plan ?? existing?.plan ?? null;
  if ((effectivePlan === "firm" && existing?.plan !== "firm") || (effectivePlan !== "firm" && quantity != null && quantity > 1)) {
    const { syncFirmQuantity } = await import("./firmQuantity");
    await syncFirmQuantity(userId);
  }

  // First transition into a live paid subscription - send the welcome.
  const becameActive = subscription.status === "active" && existing?.status !== "active";
  if (becameActive) {
    await sendSubscriptionConfirmed(userId, plan ?? existing?.plan ?? "profit_intelligence", subscription.id);
  }

  // A plan change (a move to the 1-company plan in Stripe's portal, say) can
  // leave more companies than the new plan covers. Nothing is stored: the
  // newest ones past the limit are paused from now on (planLimits.ts) and
  // Billing lists them. Noted so it shows in Stripe's webhook log.
  const paused = plan && existing?.plan && plan !== existing.plan ? await pausedNote(userId) : "";

  return `Subscription ${subscription.id} -> ${subscription.status} for user ${userId}${paused}`;
}

// The event time isn't recorded here: "canceled is final" (see
// handleSubscriptionUpsert) already stops a late update reviving this
// subscription, and recording it would make a genuinely newer
// subscription's slightly older events look stale.
async function handleSubscriptionDeleted(subscription: Stripe.Subscription, _eventCreated?: number): Promise<string> {
  const userId = await resolveUserId({
    customerId: idOf(subscription.customer),
    metadataUserId: subscription.metadata?.jobprofitaiUserId ?? null,
  });
  if (!userId) return "No matching account for deleted subscription";

  // A duplicate we cancelled ourselves: the customer keeps the original.
  const duplicateOf = subscription.metadata?.[DUPLICATE_OF_METADATA_KEY];
  if (duplicateOf) return `Deleted event for ${subscription.id} ignored: cancelled as a duplicate of ${duplicateOf}`;

  // Only the subscription on file ends access. A deleted event for another
  // one (an old subscription, a duplicate checkout) changes nothing.
  const current = await prisma.subscription.findUnique({ where: { userId }, select: { stripeSubscriptionId: true } });
  if (current?.stripeSubscriptionId && current.stripeSubscriptionId !== subscription.id) {
    return `Deleted event for ${subscription.id} ignored: ${current.stripeSubscriptionId} is the subscription on file`;
  }

  const endedAt = subscription.ended_at ? new Date(subscription.ended_at * 1000) : new Date();

  await prisma.subscription.update({
    where: { userId },
    data: {
      status: "canceled",
      canceledAt: endedAt,
      cancelAtPeriodEnd: false,
      // Recorded if missing, so a late update for this same subscription is
      // recognised as one for a canceled subscription.
      ...(current?.stripeSubscriptionId ? {} : { stripeSubscriptionId: subscription.id }),
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

  // Money that was handed back is not a payment: no referral progress, no
  // commission (which would also use up one of the partner's commission
  // months) and no partner emails.
  const reversed = await paymentGivenBack(invoice, subscriptionId);
  if (reversed) return `Invoice ${invoice.id} paid for user ${userId}, but ${reversed}: no commission or referral progress`;

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

  // The Firm plan earns a partner nothing (see partners.ts), so a Firm
  // account isn't announced to the partner as a paying client either.
  const firmInvoice = isFirmInvoice(invoice, sub?.plan);

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

      if (referral.kind === "partner" && partner?.status === "approved" && !firmInvoice) {
        const payingClients = await payingClientsIncluding(partner.id, userId);
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
    if (referral.kind === "partner" && firmInvoice) {
      notes.push("no commission: Firm plan");
    } else if (referral.kind === "partner" && referral.partnerId && partner?.status === "approved") {
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

        // Tell the partner when their rate goes up. Called on every
        // qualifying invoice rather than only when a threshold is detected as
        // crossed, because the dedupe key is
        // `partner_tier_upgrade:<partnerId>:<tierKey>` - the database makes
        // each tier announceable exactly once, so this cannot spam a partner
        // whose client count hovers around a boundary, and it cannot miss an
        // upgrade that happened while a webhook was being retried.
        const payingNow = await payingClientsIncluding(referral.partnerId, userId);
        const tierNow = partnerTierFor(payingNow);
        if (tierNow.minPayingClients > 1) {
          await sendPartnerTierUpgrade({
            partnerUserId: partner.userId,
            partnerId: referral.partnerId,
            tierKey: tierNow.key,
            ratePct: tierNow.ratePct,
            payingClients: payingNow,
          });
        }
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

/**
 * Why a paid invoice's money wasn't kept, or null when it was: its
 * subscription was cancelled as a duplicate checkout (whose first payment
 * cancelDuplicateSubscription refunds), or its charge was refunded in full.
 *
 * Stripe doesn't deliver events in order, so invoice.paid can arrive after
 * the refund. charge.refunded then found no commission to void, and this
 * handler would have recorded one afterwards. Asks Stripe for the current
 * subscription and charge, since the event's own copy can predate both.
 * Unlike isFullRefund, a charge that doesn't say it was refunded counts as
 * kept. A Stripe error throws, so the event is retried. Stripe calls follow
 * API 2024-06-20 (newer versions drop `invoice.charge`, and then only the
 * duplicate check applies); not verified against live Stripe.
 */
async function paymentGivenBack(invoice: Stripe.Invoice, subscriptionId: string): Promise<string | null> {
  const stripe = getStripe();
  const subscription: Stripe.Subscription | null | undefined = await stripe.subscriptions.retrieve(subscriptionId);
  if (subscription?.metadata?.[DUPLICATE_OF_METADATA_KEY]) return "it was a duplicate subscription, cancelled and refunded";

  const onInvoice: string | Stripe.Charge | null | undefined = invoice.charge;
  const charge: Stripe.Charge | null | undefined =
    typeof onInvoice === "string" ? await stripe.charges.retrieve(onInvoice) : onInvoice;
  if (charge && chargeRefundedInFull(charge)) return "its payment was refunded";
  return null;
}

/** Whether a charge says it was refunded in full. Unknown counts as not refunded. */
export function chargeRefundedInFull(charge: Pick<Stripe.Charge, "refunded" | "amount" | "amount_refunded">): boolean {
  if (charge.refunded === true) return true;
  const amount = charge.amount ?? 0;
  return amount > 0 && (charge.amount_refunded ?? 0) >= amount;
}

/**
 * The partner's paying-client count, counting the client whose invoice was
 * just paid even if their subscription row hasn't caught up yet.
 *
 * Stripe doesn't promise event order. When invoice.paid arrives before the
 * subscription update that marks the account active, the local row still
 * says "trialing", and the new client wasn't counted: "You now have 0 paying
 * clients" in the email announcing the first one.
 */
async function payingClientsIncluding(partnerId: string, userId: string): Promise<number> {
  const counted = await countPayingClients(partnerId);
  const sub = await prisma.subscription.findUnique({ where: { userId }, select: { status: true } });
  const alreadyCounted = sub?.status === "active" || sub?.status === "past_due";
  return alreadyCounted ? counted : counted + 1;
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
 * Whether a full refund or chargeback should end this customer's referral.
 *
 * Customer referrals: yes. The reward is one free month for a customer who
 * stayed paid, and a refunded payment means they didn't.
 *
 * Partner referrals: no. Partner commission is per invoice, so the refunded
 * invoice's commission is voided (above) and that is the whole remedy.
 * Disqualifying the referral as well meant one refunded month on a client who
 * kept paying ended every later month's commission, dropped the client out of
 * the partner's paying-client count, and could lower their rate on every
 * other client, which is the opposite of what the partner FAQ promises.
 */
async function disqualifiesOnRefund(userId: string): Promise<boolean> {
  const referral = await prisma.referral.findUnique({
    where: { referredUserId: userId },
    select: { kind: true },
  });
  return referral?.kind !== "partner";
}

/**
 * True when the whole charge came back, false for a partial refund.
 *
 * `charge.refunded` is Stripe's own full-refund flag; the amount comparison
 * is a belt-and-braces second reading. A charge object carrying neither
 * field - which in practice means a hand-built or trimmed payload - is
 * treated as a full refund, because the safe default when we cannot tell is
 * to reverse rather than to keep paying commission on money that is gone.
 */
function isFullRefund(charge: Stripe.Charge): boolean {
  if (charge.refunded === true) return true;
  const amount = charge.amount ?? 0;
  const refunded = charge.amount_refunded ?? 0;
  return refunded >= amount;
}

/**
 * A FULL refund invalidates the money the reward and commission were based
 * on, so both are reversed.
 *
 * A PARTIAL refund deliberately reverses nothing. The old behaviour treated
 * the two identically, which meant a $20 goodwill credit on a $299 invoice
 * destroyed the partner's entire commission for that month and permanently
 * disqualified the referral - including one that had already earned and
 * been credited its free month, possibly a year earlier. That is a large,
 * silent, irreversible penalty triggered by the smallest routine act of
 * customer service there is. The customer paid and kept the service; the
 * referral stands. If a partial refund ever does need to reverse something,
 * that is a decision for a person, and the event is in the Stripe log.
 */
async function handleChargeRefunded(charge: Stripe.Charge): Promise<string> {
  const invoiceId = idOf(charge.invoice);
  const notes: string[] = [];

  if (!isFullRefund(charge)) {
    return `Partial refund on charge ${charge.id}: nothing reversed (commission and referral stand)`;
  }

  if (invoiceId) {
    const voided = await voidCommissionForInvoice(invoiceId, "Payment refunded");
    if (voided) notes.push("voided partner commission");

    // Commission already paid out to the partner cannot be voided by an
    // update, so it is flagged instead of being left invisible.
    const flagged = await flagPaidCommissionsForReview(invoiceId, "Payment refunded");
    if (flagged) notes.push(`flagged ${flagged} already-paid commission for review`);
  }

  const userId = await resolveUserId({ customerId: idOf(charge.customer) });
  // Refunding a duplicate checkout's payment isn't the customer leaving:
  // they're still paying on the subscription that was kept.
  if (userId && (await disqualifiesOnRefund(userId)) && !(await refundIsForDuplicate(charge))) {
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

      const flagged = await flagPaidCommissionsForReview(
        invoiceId,
        "Payment disputed (chargeback)"
      );
      if (flagged) notes.push(`flagged ${flagged} already-paid commission for review`);
    }
    const userId = await resolveUserId({ customerId: idOf(charge.customer) });
    if (userId && (await disqualifiesOnRefund(userId))) {
      await disqualifyReferral(userId, "Referred customer's payment was disputed");
      notes.push("disqualified referral");
    }
  }

  return `Dispute handled${notes.length ? `: ${notes.join("; ")}` : ""}`;
}

export { PLANS };
