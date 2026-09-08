import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { PLANS, type PlanId } from "@/lib/plans";
import { ensureSubscription } from "@/lib/trial";
import { appUrl, getStripe, requirePriceIdForPlan } from "./client";

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

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
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
  return `${PLANS[plan].name} (${PLANS[plan].priceLabel}/month)`;
}
