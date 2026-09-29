// One subscription per account, kept that way at both ends of checkout.
//
// Checkout refuses when the account already has a live subscription, but the
// local row only learns about a payment from Stripe's webhook, a few seconds
// later. Two checkouts opened side by side (two tabs, or a double click on
// two plans during the trial) could both be paid, and the second then
// overwrote the first on file while the first kept charging with no record
// in the app.
//
// Before a checkout starts (src/lib/stripe/billing.ts), Stripe itself is
// asked about the customer: a live subscription or a checkout completed in
// the last hour refuses the new one, and any still-open checkout is closed so
// only the newest can be paid. That narrows the window but can't close it
// (two requests at the same instant both see nothing), so the webhook
// (checkout.session.completed in webhookHandlers.ts) is the backstop: when a
// checkout creates a subscription while an older one is live, the new one is
// cancelled and its first payment refunded, the original is kept, and the
// admin is emailed.
//
// The functions here are the pure decisions, so they can be tested without
// Stripe.

/** Stripe statuses that mean a subscription is charging or about to. */
export const LIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"] as const;

export function isLiveSubscriptionStatus(status: string | null | undefined): boolean {
  return (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status ?? "");
}

/** Metadata stamped on a subscription cancelled as a duplicate: the id of the one kept. */
export const DUPLICATE_OF_METADATA_KEY = "jobprofitaiDuplicateOf";
/** Metadata stamped on the refund of a duplicate's first payment: the duplicate's id. */
export const DUPLICATE_REFUND_METADATA_KEY = "jobprofitaiDuplicateSubscription";

export interface SubscriptionSummary {
  id: string;
  status: string;
  /** Stripe's `created`, in seconds. */
  created: number;
}

function olderFirst(a: SubscriptionSummary, b: SubscriptionSummary): number {
  return a.created - b.created || a.id.localeCompare(b.id);
}

/**
 * The subscription to keep when `created` (the one a checkout just made) is
 * a duplicate, or null when it stands.
 *
 * The original is the OLDEST live subscription the account has. Deciding by
 * age rather than by which checkout's webhook arrived first means the answer
 * is the same whatever order Stripe delivers events in: of two paid
 * checkouts, the later one is always the one cancelled, and each checkout's
 * own event reaches the same verdict. `created` itself is judged whatever its
 * status: an older live subscription means this one should not exist.
 */
export function originalSubscriptionFor(
  created: SubscriptionSummary,
  others: SubscriptionSummary[]
): SubscriptionSummary | null {
  const older = others
    .filter((s) => s.id !== created.id && isLiveSubscriptionStatus(s.status))
    .filter((s) => olderFirst(s, created) < 0)
    .sort(olderFirst);
  return older[0] ?? null;
}

export interface CheckoutSessionSummary {
  id: string;
  status: string | null;
  /** Stripe's `created`, in seconds. */
  created: number;
  subscriptionId: string | null;
}

/** How far back a completed or open checkout counts as "the one just started". */
export const RECENT_CHECKOUT_SECONDS = 3600;

export type SecondCheckoutDecision =
  | { block: true; message: string }
  | { block: false; expireSessionIds: string[] };

export const ALREADY_SUBSCRIBED_MESSAGE =
  "You already have a subscription. Use Manage Billing to switch plans. If you just paid, give it a minute and refresh this page.";
export const PAYMENT_BEING_CONFIRMED_MESSAGE =
  "We've just received a payment from you and are still turning your plan on. Refresh this page in a minute.";

/**
 * Whether a new checkout may start for this customer, from what Stripe says
 * about them: refused while any subscription is live, or while a checkout
 * completed in the last hour hasn't yet shown up as a finished (cancelled)
 * subscription. Otherwise it may start, and any checkout still open from the
 * last hour is closed first, so only the newest can be paid. Pure.
 */
export function secondCheckoutDecision(
  subscriptions: SubscriptionSummary[],
  sessions: CheckoutSessionSummary[],
  nowSeconds: number
): SecondCheckoutDecision {
  if (subscriptions.some((s) => isLiveSubscriptionStatus(s.status))) {
    return { block: true, message: ALREADY_SUBSCRIBED_MESSAGE };
  }
  const recent = sessions.filter((s) => nowSeconds - s.created <= RECENT_CHECKOUT_SECONDS);
  const paidAndPending = recent.some((s) => {
    if (s.status !== "complete") return false;
    const sub = s.subscriptionId ? subscriptions.find((x) => x.id === s.subscriptionId) : null;
    // Not listed yet, or still settling: the payment is on its way.
    return !sub || sub.status === "incomplete";
  });
  if (paidAndPending) return { block: true, message: PAYMENT_BEING_CONFIRMED_MESSAGE };
  return { block: false, expireSessionIds: recent.filter((s) => s.status === "open").map((s) => s.id) };
}
