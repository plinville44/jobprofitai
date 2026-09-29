import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { PLANS, firmBillableCompanies, planPriceText, type PlanId } from "@/lib/plans";
import { ensureSubscription } from "@/lib/trial";
import { appUrl, getStripe, requirePriceIdForPlan } from "./client";
import {
  PAYMENT_BEING_CONFIRMED_MESSAGE,
  RECENT_CHECKOUT_SECONDS,
  secondCheckoutDecision,
  type SubscriptionSummary,
} from "./duplicateSubscription";

// Everything that talks to Stripe on behalf of a signed-in user: customer
// creation, Checkout, and the Billing Portal.
//
// JobProfitAI never sees or stores a card number. Checkout and the Billing
// Portal are both Stripe-hosted pages; card details are entered on Stripe's
// domain and we only ever receive identifiers (customer / subscription /
// invoice ids) back.

/**
 * Returns this account's Stripe Customer id, creating the customer the first
 * time it's needed.
 *
 * Idempotency has two layers. The stored id short-circuits the common case,
 * and the create call passes an idempotency key derived from the user id, so
 * two concurrent checkout attempts by the same user produce one customer in
 * Stripe rather than two.
 */
export async function getOrCreateStripeCustomer(userId: string): Promise<string> {
  const subscription = await ensureSubscription(userId);
  if (subscription.stripeCustomerId) return subscription.stripeCustomerId;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true },
  });
  if (!user) throw new Error("User not found.");

  const stripe = getStripe();
  const customer = await stripe.customers.create(
    {
      email: user.email,
      name: user.name ?? undefined,
      // The link back from any Stripe object to the JobProfitAI account.
      // Webhook handlers prefer looking the account up by stored customer id,
      // but this metadata is the fallback that makes manual reconciliation
      // possible if a row ever goes missing.
      metadata: { jobprofitaiUserId: userId },
    },
    { idempotencyKey: `customer:${userId}` }
  );

  await prisma.subscription.update({
    where: { userId },
    data: { stripeCustomerId: customer.id },
  });

  return customer.id;
}

export interface CheckoutSessionResult {
  url: string;
  sessionId: string;
}

/** A checkout refused because this customer already has one paid or on its way. The message is for the customer. */
export class CheckoutBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutBlockedError";
  }
}

interface ListedSubscription {
  id: string;
  status: string;
  created: number;
}
interface ListedCheckoutSession {
  id: string;
  status: string | null;
  created: number;
  subscription?: string | { id: string } | null;
}

/**
 * Stops a second checkout for a customer who already has a subscription or
 * a payment on its way, and closes any checkout still open from the last
 * hour so only the one being started now can be paid. See
 * duplicateSubscription.ts for why, and for the webhook backstop that
 * catches what this can't (two clicks at the same instant). Throws
 * CheckoutBlockedError with a message for the customer.
 *
 * Stripe's list filters are used as documented for API 2024-06-20; not
 * verified against live Stripe. An open session that can't be closed is
 * checked again, since it may have just been paid.
 */
async function refuseSecondCheckout(stripe: Stripe, customerId: string, now: Date = new Date()): Promise<void> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const [subscriptions, sessions] = await Promise.all([
    stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 }),
    stripe.checkout.sessions.list({
      customer: customerId,
      created: { gte: nowSeconds - RECENT_CHECKOUT_SECONDS },
      limit: 20,
    }),
  ]);
  const subs: SubscriptionSummary[] = (subscriptions.data as ListedSubscription[]).map((s) => ({
    id: s.id,
    status: s.status,
    created: s.created,
  }));
  const decision = secondCheckoutDecision(
    subs,
    (sessions.data as ListedCheckoutSession[]).map((s) => ({
      id: s.id,
      status: s.status,
      created: s.created,
      subscriptionId: s.subscription == null ? null : typeof s.subscription === "string" ? s.subscription : s.subscription.id,
    })),
    nowSeconds
  );
  if (decision.block) throw new CheckoutBlockedError(decision.message);

  for (const sessionId of decision.expireSessionIds) {
    try {
      await stripe.checkout.sessions.expire(sessionId);
    } catch {
      const again: { status?: string | null } = await stripe.checkout.sessions.retrieve(sessionId);
      if (again.status === "complete") throw new CheckoutBlockedError(PAYMENT_BEING_CONFIRMED_MESSAGE);
      // Already expired by someone else: nothing left to close.
    }
  }
}

/**
 * Creates a Stripe-hosted Checkout session for a monthly subscription.
 *
 * Note there is no Stripe trial configured here on purpose: the 14-day
 * JobProfitAI trial is card-free and lives entirely in our own database, so
 * by the time someone reaches Checkout they are choosing to start paying.
 * Adding `trial_period_days` here would silently hand out a second trial.
 */
export async function createCheckoutSession(
  userId: string,
  plan: PlanId,
  opts: { successPath?: string; cancelPath?: string } = {}
): Promise<CheckoutSessionResult> {
  const stripe = getStripe();
  const priceId = requirePriceIdForPlan(plan);
  const customerId = await getOrCreateStripeCustomer(userId);
  await refuseSecondCheckout(stripe, customerId);

  // Firm is billed per connected company, four at least. The quantity is
  // kept in step afterwards as companies are connected and disconnected
  // (src/lib/stripe/firmQuantity.ts).
  const firm = plan === "firm";
  const quantity = firm
    ? firmBillableCompanies(await prisma.quickBooksConnection.count({ where: { userId, disconnectedAt: null } }))
    : 1;
  const renewal = firm
    ? `${PLANS.firm.priceLabel} per connected QuickBooks company (${PLANS.firm.perCompany!.minCompanies} minimum; ${quantity} to start, ${formatUsd(PLANS.firm.priceCents * quantity)}), adjusted as you connect or disconnect companies,`
    : planPriceText(plan).replace("/month", "");

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity }],
    // Lets a referred/partner-sourced customer redeem a Stripe coupon if one
    // is ever issued, without needing a code change.
    allow_promotion_codes: true,
    client_reference_id: userId,
    // Duplicated onto the session AND the subscription: the session metadata
    // is what checkout.session.completed sees, the subscription metadata is
    // what every later subscription.* and invoice.* event sees.
    metadata: { jobprofitaiUserId: userId, plan },
    subscription_data: {
      metadata: { jobprofitaiUserId: userId, plan },
    },
    // Automatic-renewal disclosure, shown directly above the pay button so
    // the price, the monthly renewal and how to cancel are in front of the
    // customer at the moment they agree to pay.
    custom_text: {
      submit: {
        message: `Your ${PLANS[plan].name} subscription renews automatically every month at ${renewal} plus any applicable tax until you cancel. You can cancel anytime from Billing in your JobProfitAI account, and cancellation takes effect at the end of the month you have already paid for. By subscribing you agree to the JobProfitAI Terms of Service at ${appUrl("/terms")}.`,
      },
    },
    success_url: appUrl(
      opts.successPath ?? "/dashboard/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}"
    ),
    cancel_url: appUrl(opts.cancelPath ?? "/dashboard/billing?checkout=canceled"),
  });

  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL.");
  }
  return { url: session.url, sessionId: session.id };
}

/**
 * Stripe-hosted Billing Portal: update card, view invoices, change plan,
 * cancel. Using Stripe's portal rather than building these flows ourselves
 * is what keeps card data entirely off our infrastructure, and it's why
 * "cancel anytime" on the pricing page is a real, self-serve capability
 * rather than an email request.
 */
export async function createBillingPortalSession(
  userId: string,
  returnPath = "/dashboard/billing"
): Promise<string> {
  const stripe = getStripe();
  const customerId = await getOrCreateStripeCustomer(userId);

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: appUrl(returnPath),
  });

  return session.url;
}

/**
 * Applies a credit to a customer's Stripe balance. A NEGATIVE amount is a
 * credit in Stripe's model - it reduces what the customer owes on future
 * invoices, and multiple credits simply accumulate on the balance, which is
 * exactly the stacking behaviour the referral program needs (three qualified
 * referrals from a $149 subscriber leave a -$447 balance that draws down
 * across the next three invoices).
 *
 * The idempotency key is supplied by the caller and derived from the reward
 * id, so a webhook retry that re-runs this cannot double-credit.
 */
export async function applyCustomerCredit(params: {
  customerId: string;
  amountCents: number;
  description: string;
  idempotencyKey: string;
  metadata?: Record<string, string>;
}): Promise<Stripe.CustomerBalanceTransaction> {
  const stripe = getStripe();
  return stripe.customers.createBalanceTransaction(
    params.customerId,
    {
      amount: -Math.abs(params.amountCents), // negative = credit
      currency: "usd",
      description: params.description,
      metadata: params.metadata,
    },
    { idempotencyKey: params.idempotencyKey }
  );
}

/**
 * Finds a credit already on this customer's balance carrying a given reward
 * id in its metadata, or null.
 *
 * This exists because Stripe idempotency keys expire after 24 hours, and the
 * one place that matters is a referral reward whose credit succeeded at
 * Stripe but whose database write did not. The reward row stays "pending",
 * gets retried, and by then the idempotency key is long gone - so without
 * this lookup the referrer is credited twice for one referral.
 *
 * Scans the most recent 100 balance transactions rather than paginating.
 * A credit that has fallen further back than that is months old on any real
 * account, and the retry path that calls this runs within days.
 */
export async function findCreditByRewardId(
  customerId: string,
  rewardId: string
): Promise<Stripe.CustomerBalanceTransaction | null> {
  const stripe = getStripe();
  const page = await stripe.customers.listBalanceTransactions(customerId, { limit: 100 });
  return page.data.find((txn) => txn.metadata?.rewardId === rewardId) ?? null;
}

/** Current Stripe customer balance in cents (negative = credit available). */
export async function getCustomerBalanceCents(customerId: string): Promise<number> {
  const stripe = getStripe();
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return 0;
  return customer.balance ?? 0;
}

/**
 * The subscription revenue on an invoice, in cents, excluding sales tax.
 *
 * Taken from the subscription LINE ITEMS rather than `amount_paid`, because
 * line amounts are pre-tax by definition - that's what makes "we don't pay
 * commission on sales tax" true rather than aspirational.
 *
 * It's then capped at `amount_paid` so that an invoice largely or entirely
 * covered by a referral credit doesn't generate commission on money that was
 * never actually collected. In the ordinary case (no credit applied) the cap
 * is inactive and the pre-tax line total is what's used.
 */
export function subscriptionRevenueCents(invoice: Stripe.Invoice): number {
  const lineTotal = invoice.lines.data
    .filter(isSubscriptionLine)
    .reduce((sum, line) => sum + (line.amount ?? 0), 0);

  const collected = invoice.amount_paid ?? 0;
  return Math.max(0, Math.min(lineTotal, collected));
}

/**
 * What a customer has actually paid for their subscription so far, in cents:
 * each paid invoice's subscription revenue (pre-tax, and never more than was
 * collected, see subscriptionRevenueCents) less anything refunded on it.
 *
 * Used to cap a referral reward at what the referred account paid, so a
 * referral can never earn more credit than it brought in. Reads the 100 most
 * recent paid invoices, far more than the few months a referral takes to
 * qualify. The charge is expanded to see refunds (API 2024-06-20, which the
 * client is pinned to, still puts `charge` on the invoice). Not verified
 * against live Stripe.
 */
export async function paidSubscriptionRevenueCents(customerId: string): Promise<number> {
  return (await paidSubscriptionHistory(customerId)).revenueCents;
}

/** What a customer has paid for their subscription so far. See paidSubscriptionHistoryFrom. */
export interface PaidSubscriptionHistory {
  /** Subscription revenue kept, net of refunds (see netPaidRevenueCents). */
  revenueCents: number;
  /** Invoices on which some subscription revenue was paid and not refunded. */
  paidInvoices: number;
  /** How many of those were renewals (billing_reason "subscription_cycle"). */
  paidRenewals: number;
}

/**
 * The same paid invoice list as paidSubscriptionRevenueCents, also counting
 * the invoices that were actually paid. A referral qualifies on these
 * counts rather than on the subscription's period end, because Stripe moves
 * the period end when it CREATES the renewal invoice, which is before the
 * card is charged. Only a paid, unrefunded renewal invoice shows the renewal
 * was paid. Not verified against live Stripe.
 */
export async function paidSubscriptionHistory(customerId: string): Promise<PaidSubscriptionHistory> {
  const stripe = getStripe();
  const page = await stripe.invoices.list({
    customer: customerId,
    status: "paid",
    limit: 100,
    expand: ["data.charge"],
  });
  return paidSubscriptionHistoryFrom(page.data);
}

/** The refunded amount on an invoice's charge, when the charge was expanded. */
function refundedCents(invoice: Stripe.Invoice): number {
  const charge: { amount_refunded?: number | null } | string | null | undefined = invoice.charge;
  return charge && typeof charge === "object" ? charge.amount_refunded ?? 0 : 0;
}

/**
 * Pure, for tests. An invoice counts as paid only when some subscription
 * revenue on it was collected and kept: one fully covered by account credit
 * ($0 collected) or fully refunded is "paid" to Stripe but brought nothing in.
 */
export function paidSubscriptionHistoryFrom(invoices: Stripe.Invoice[]): PaidSubscriptionHistory {
  let revenueCents = 0;
  let paidInvoices = 0;
  let paidRenewals = 0;
  for (const invoice of invoices) {
    const kept = Math.max(0, subscriptionRevenueCents(invoice) - refundedCents(invoice));
    revenueCents += kept;
    if (kept <= 0) continue;
    paidInvoices++;
    if (invoice.billing_reason === "subscription_cycle") paidRenewals++;
  }
  return { revenueCents, paidInvoices, paidRenewals };
}

/** Subscription revenue kept across these invoices, net of refunds. Pure, for tests. */
export function netPaidRevenueCents(invoices: Stripe.Invoice[]): number {
  return paidSubscriptionHistoryFrom(invoices).revenueCents;
}

/**
 * Is this invoice line subscription revenue, across Stripe API versions?
 *
 * Through 2024-06-20 a line carried `type: "subscription"` and a `price`
 * object. The 2025 versions removed `type` outright and replaced `price` with
 * `pricing`, moving the subscription link to
 * `parent.subscription_item_details`. New Stripe accounts can no longer select
 * 2024-06-20, so the newer shape is what production receives.
 *
 * Checking only the old fields would quietly match nothing. lineTotal would be
 * 0, subscriptionRevenueCents would return 0, and every partner commission
 * would be calculated as 20% of nothing. The invoice still pays, the
 * commission row is still written, it is just written for $0 - which is the
 * kind of bug you discover from an angry email rather than an error log.
 *
 * `amount` is pre-tax in both shapes, which is what keeps "no commission on
 * sales tax" true.
 */
interface InvoiceLineCompat {
  type?: string;
  price?: { type?: string } | null;
  parent?: { type?: string; subscription_item_details?: unknown } | null;
}

function isSubscriptionLine(line: Stripe.InvoiceLineItem): boolean {
  const compat = line as Stripe.InvoiceLineItem & InvoiceLineCompat;

  if (compat.type === "subscription") return true;
  if (compat.price?.type === "recurring") return true;

  return (
    compat.parent?.type === "subscription_item_details" ||
    compat.parent?.subscription_item_details != null
  );
}

/** The plan a subscription is currently on, from its first recurring price. */
export function priceIdFromSubscription(subscription: Stripe.Subscription): string | null {
  return subscription.items.data[0]?.price?.id ?? null;
}

/** Human label for a plan id, for emails and the billing UI. */
export function planLabel(plan: PlanId): string {
  return `${PLANS[plan].name} (${planPriceText(plan)})`;
}

function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
