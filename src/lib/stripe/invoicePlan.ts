import type Stripe from "stripe";
import type { PlanId } from "@/lib/plans";
import { planForPriceId } from "./client";

// Which plan a Stripe invoice charges for, read from the invoice itself.
//
// Partner commission is never paid on the Firm plan (see partners.ts), and
// the plan on the account's Subscription row can't decide that alone: Stripe
// doesn't deliver events in order, so an invoice for a plan change can arrive
// before the subscription update that records the new plan.

/**
 * A line's Stripe price id, across API versions. Through 2024-06-20 a line
 * carried a `price` object (and the older `plan`); the 2025 versions moved it
 * to `pricing.price_details.price`, a plain id.
 */
interface InvoiceLinePriceCompat {
  amount?: number | null;
  price?: { id?: string | null } | string | null;
  plan?: { id?: string | null } | null;
  pricing?: { price_details?: { price?: string | { id?: string | null } | null } | null } | null;
}

export function linePriceId(line: InvoiceLinePriceCompat): string | null {
  const price = line.price;
  if (typeof price === "string" && price) return price;
  if (price && typeof price === "object" && price.id) return price.id;
  if (line.plan?.id) return line.plan.id;
  const nested = line.pricing?.price_details?.price;
  if (typeof nested === "string" && nested) return nested;
  if (nested && typeof nested === "object" && nested.id) return nested.id;
  return null;
}

/**
 * The plans an invoice charges for, from the prices on its positive lines.
 * Negative lines are credits for unused time on a plan being left, so a
 * move from Pro to Firm reads as Firm and a move off Firm doesn't. Prices
 * this app doesn't sell are left out. Pure, for tests.
 */
export function invoicePlanIds(invoice: Stripe.Invoice): PlanId[] {
  const lines: InvoiceLinePriceCompat[] = invoice?.lines?.data ?? [];
  const plans = new Set<PlanId>();
  for (const line of lines) {
    if ((line.amount ?? 0) <= 0) continue;
    const plan = planForPriceId(linePriceId(line));
    if (plan) plans.add(plan);
  }
  return Array.from(plans);
}

/**
 * Whether an invoice is for the Firm plan. The invoice's own lines decide
 * when they name a price we sell; otherwise the plan on file does. Pure
 * apart from reading the configured price ids.
 */
export function isFirmInvoice(invoice: Stripe.Invoice, storedPlan: string | null | undefined): boolean {
  const plans = invoicePlanIds(invoice);
  if (plans.length > 0) return plans.includes("firm");
  return storedPlan === "firm";
}
