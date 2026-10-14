import type { Subscription } from "@prisma/client";
import { RETENTION_RULES_START } from "@/lib/legalVersion";

/**
 * How long a company's copied QuickBooks data is kept once it stops being
 * connected, and when an account that no longer has a trial or plan is
 * disconnected. Intuit's developer terms (section 12.2) say an app must
 * stop accessing and processing a user's QuickBooks data once they revoke
 * consent or stop using the app, and delete it when asked. So:
 *
 * - Disconnecting (here, or from Intuit: the Intuit-side disconnect page, or
 *   after REVOKED_GRANT_GRACE_DAYS of QuickBooks refusing our access) stops
 *   every sync, brief, alert, AI write-up and snapshot at once (disconnected
 *   companies are left out of every query that does that work), keeps the
 *   data untouched for DISCONNECTED_RETENTION_DAYS so reconnecting brings the
 *   history back, then deletes it.
 * - An account with no live trial or plan for LAPSED_DISCONNECT_DAYS has its
 *   QuickBooks companies disconnected, which starts the same clock.
 * - The owner can delete one company's data at any time (Settings), and
 *   deleting the account deletes all of it.
 *
 * The Terms (section 3), the Privacy Policy (sections 6 and 8) and the
 * emails in src/lib/email/templates.ts state these numbers, so change them
 * together.
 */
export const DISCONNECTED_RETENTION_DAYS = 30;
export const LAPSED_DISCONNECT_DAYS = 90;
/** The reminder before a disconnected company's data is deleted. */
export const DELETION_REMINDER_DAYS_BEFORE = 7;
/**
 * A company QuickBooks no longer lets us read (disconnected from the Intuit
 * side, say) that isn't reconnected within this many days is treated as
 * disconnected, which starts the 30 days.
 */
export const REVOKED_GRANT_GRACE_DAYS = 7;

export const DAY_MS = 86_400_000;

/**
 * The clocks never start before the day these rules took effect, so a
 * company disconnected, or an account that lapsed, before then gets the full
 * period from that day rather than being deleted on the first run.
 */
const RULES_START = new Date(`${RETENTION_RULES_START}T00:00:00Z`);
const notBeforeRules = (d: Date) => (d.getTime() < RULES_START.getTime() ? RULES_START : d);

/** When a disconnected company's data is deleted. */
export function deletionDueAt(disconnectedAt: Date): Date {
  return new Date(notBeforeRules(disconnectedAt).getTime() + DISCONNECTED_RETENTION_DAYS * DAY_MS);
}

/**
 * When an account stopped having a live trial or plan, or null while it still
 * has one (or while a failed payment is being retried). Pure, so it can be
 * tested; the caller has already ruled out complimentary access.
 */
export function accessEndedAt(
  sub: Pick<Subscription, "status" | "trialEndsAt" | "currentPeriodEnd" | "canceledAt" | "updatedAt"> | null,
  fallback: Date,
  now: Date
): Date | null {
  if (!sub) return fallback;
  switch (sub.status) {
    case "active":
    case "past_due":
      return null;
    case "trialing":
      if (sub.trialEndsAt && sub.trialEndsAt.getTime() <= now.getTime()) return sub.trialEndsAt;
      return null;
    case "trial_expired":
      return sub.trialEndsAt ?? sub.updatedAt;
    case "canceled":
      return sub.currentPeriodEnd ?? sub.canceledAt ?? sub.updatedAt;
    default:
      // "unpaid", "incomplete", "incomplete_expired", "none": no live access
      // since the row last changed.
      return sub.updatedAt;
  }
}

/** True once an account has gone LAPSED_DISCONNECT_DAYS without a trial or plan. */
export function lapsedLongEnough(ended: Date | null, now: Date): boolean {
  return ended != null && now.getTime() - notBeforeRules(ended).getTime() >= LAPSED_DISCONNECT_DAYS * DAY_MS;
}
