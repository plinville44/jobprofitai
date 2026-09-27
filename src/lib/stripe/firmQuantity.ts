import { prisma } from "@/lib/prisma";
import { firmBillableCompanies } from "@/lib/plans";
import { needsReconnect } from "@/lib/quickbooks";
import { getStripe, priceIdForPlan } from "./client";

/**
 * Keeps a Firm subscription's quantity equal to the companies it covers:
 * the connected QuickBooks companies, never below the four-company minimum.
 *
 * Called when a company is connected or disconnected, after checkout, and
 * once a night for every Firm account (src/app/api/cron/lifecycle), so a
 * change that failed to reach Stripe the first time is put right the next
 * night rather than billed wrong for a month.
 *
 * Stripe prorates the change: a company connected mid-month is charged for
 * the rest of that month on the next invoice, and one disconnected is
 * credited. Setting a quantity is idempotent by nature, so no idempotency
 * key is used; a key would make a later change back to the same number
 * return the earlier response and do nothing.
 *
 * A company whose QuickBooks access was revoked (it's waiting to be
 * reconnected) and that hasn't synced for RECONNECT_GRACE_DAYS stops
 * counting: a contractor who left the firm and cut the app off in
 * QuickBooks shouldn't keep costing it. Counted from the last successful
 * sync. Reconnecting brings it back onto the bill.
 *
 * Any other plan is billed for one: a subscription moved off Firm (by
 * Stripe's portal or by hand) is set back to a quantity of 1.
 */

export const RECONNECT_GRACE_DAYS = 7;

/** Whether a connected company counts toward the Firm bill. Pure, for tests. */
export function isBillableCompany(
  c: { disconnectedAt: Date | null; lastSyncError: string | null; lastSyncedAt: Date | null; connectedAt: Date },
  now: Date
): boolean {
  if (c.disconnectedAt) return false;
  if (!needsReconnect(c.lastSyncError)) return true;
  const since = (c.lastSyncedAt ?? c.connectedAt).getTime();
  return now.getTime() - since <= RECONNECT_GRACE_DAYS * 86_400_000;
}

/** Companies a Firm account is billed for right now (before the minimum). */
export async function billableCompanyCount(ownerId: string, now = new Date()): Promise<number> {
  const companies = await prisma.quickBooksConnection.findMany({
    where: { userId: ownerId, disconnectedAt: null },
    select: { disconnectedAt: true, lastSyncError: true, lastSyncedAt: true, connectedAt: true },
  });
  return companies.filter((c) => isBillableCompany(c, now)).length;
}

/** The quantity to set, or null when it's already right. Pure, for tests. */
export function firmQuantityChange(currentQuantity: number | null | undefined, connectedCompanies: number): number | null {
  const desired = firmBillableCompanies(connectedCompanies);
  return currentQuantity === desired ? null : desired;
}

export type FirmQuantityResult =
  | { status: "not_firm" }
  | { status: "unchanged"; quantity: number }
  | { status: "updated"; from: number | null; quantity: number }
  | { status: "error"; message: string };

export async function syncFirmQuantity(ownerId: string): Promise<FirmQuantityResult> {
  try {
    const subscription = await prisma.subscription.findUnique({
      where: { userId: ownerId },
      select: { plan: true, status: true, stripeSubscriptionId: true, quantity: true },
    });
    if (
      !subscription ||
      !subscription.stripeSubscriptionId ||
      (subscription.status !== "active" && subscription.status !== "past_due")
    ) {
      return { status: "not_firm" };
    }
    const firm = subscription.plan === "firm";
    // Not Firm and not known to be billed for more than one: nothing to do,
    // and no call to Stripe.
    if (!firm && (subscription.quantity == null || subscription.quantity <= 1)) return { status: "not_firm" };

    const stripe = getStripe();
    const live = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
    const firmPrice = priceIdForPlan("firm");
    const items: { id: string; quantity?: number | null; price?: { id?: string } | null }[] = live.items.data;
    const item = (firm ? items.find((i) => i.price?.id === firmPrice) : null) ?? items[0];
    if (!item) return { status: "error", message: `Subscription ${live.id} has no items` };

    const change = firm
      ? firmQuantityChange(item.quantity ?? null, await billableCompanyCount(ownerId))
      : (item.quantity ?? 1) === 1
        ? null
        : 1;
    if (change == null) {
      await prisma.subscription.update({ where: { userId: ownerId }, data: { quantity: item.quantity ?? null } });
      return { status: "unchanged", quantity: item.quantity ?? 0 };
    }
    await stripe.subscriptions.update(live.id, {
      items: [{ id: item.id, quantity: change }],
      proration_behavior: "create_prorations",
    });
    await prisma.subscription.update({ where: { userId: ownerId }, data: { quantity: change } });
    return { status: "updated", from: item.quantity ?? null, quantity: change };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`firmQuantity: sync failed for ${ownerId}:`, message);
    return { status: "error", message };
  }
}

/** Every Firm account with a live subscription, for the nightly check. */
export async function syncAllFirmQuantities(): Promise<{ checked: number; updated: number; errors: number }> {
  // Firm subscriptions, and any other plan still billed for more than one
  // (a reset to one that failed when the plan changed).
  const firms = await prisma.subscription.findMany({
    where: {
      stripeSubscriptionId: { not: null },
      status: { in: ["active", "past_due"] },
      OR: [{ plan: "firm" }, { quantity: { gt: 1 } }],
    },
    select: { userId: true },
  });
  let updated = 0;
  let errors = 0;
  for (const f of firms) {
    const r = await syncFirmQuantity(f.userId);
    if (r.status === "updated") updated++;
    if (r.status === "error") errors++;
  }
  return { checked: firms.length, updated, errors };
}
