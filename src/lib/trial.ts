import type { Prisma, Subscription } from "@prisma/client";
import { prisma } from "./prisma";
import { TRIAL_DAYS, TRIAL_EXTENSION_DAYS, TRIAL_EXTENSION_OFFER_DAY } from "./plans";

// The trial lifecycle, entirely server-side.
//
// Nothing here ever reads a date from the client. Trial start, expiry,
// activation and the one-time extension all live on the Subscription row and
// are only ever computed from `new Date()` on the server, because a trial
// boundary is an authorization decision - a client-supplied date would be a
// straightforward way to grant yourself unlimited free access.

/**
 * How long after the trial expires the feedback-for-extension offer can
 * still be claimed. Bounded deliberately: the extension always adds 14 days
 * to the ORIGINAL expiry (never "14 days from whenever you got around to
 * it"), so an unbounded grace window would let someone claim months later
 * and receive an already-expired extension - confusing rather than generous.
 * At 7 days, the worst case still leaves a full week of usable trial.
 */
export const TRIAL_EXTENSION_GRACE_DAYS = 7;

const DAY_MS = 86_400_000;

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Whole days elapsed since `start`, floored (day 0 is the signup day). */
export function daysSince(start: Date, now: Date): number {
  return Math.floor((now.getTime() - start.getTime()) / DAY_MS);
}

/** Whole days remaining until `end`, ceilinged and never negative. */
export function daysUntil(end: Date, now: Date): number {
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY_MS));
}

/**
 * The Subscription row every account needs. Created idempotently so a user
 * who predates the billing system (or whose signup half-failed) gets a
 * correct trial row the first time anything asks, instead of a crash.
 *
 * Uses the unique constraint on Subscription.userId for the idempotency
 * rather than a read-then-write, so two concurrent requests can't both
 * decide the row is missing and create it.
 */
export async function ensureSubscription(
  userId: string,
  now: Date = new Date()
): Promise<Subscription> {
  const existing = await prisma.subscription.findUnique({ where: { userId } });
  if (existing) return existing;

  try {
    return await prisma.subscription.create({
      data: {
        userId,
        status: "trialing",
        trialStartedAt: now,
        trialEndsAt: addDays(now, TRIAL_DAYS),
      },
    });
  } catch {
    // Lost a race with a concurrent create - the other one won, use it.
    const row = await prisma.subscription.findUnique({ where: { userId } });
    if (!row) throw new Error("Could not create or load the subscription record.");
    return row;
  }
}

/**
 * Data for a brand-new account's trial, used inline in the signup
 * transaction so the user and their trial are created atomically. No credit
 * card is involved anywhere in this path - there is no Stripe object at all
 * until the customer actually chooses a plan.
 */
export function newTrialSubscriptionData(now: Date = new Date()): Prisma.SubscriptionCreateWithoutUserInput {
  return {
    status: "trialing",
    trialStartedAt: now,
    trialEndsAt: addDays(now, TRIAL_DAYS),
  };
}

// --- Activation ----------------------------------------------------------

/**
 * "Activated" means the account reached the point where JobProfitAI is
 * actually doing its job: QuickBooks is connected AND at least one
 * profitability analysis has been produced. Both halves are tracked
 * separately because they need different nudges - someone who connected but
 * never ran an analysis needs a different email than someone who never
 * connected at all.
 *
 * Both of these are called from the real product events (the OAuth callback
 * and the analysis/digest routes), never from the client.
 */
export async function markQuickBooksConnected(
  userId: string,
  now: Date = new Date()
): Promise<void> {
  const sub = await ensureSubscription(userId, now);
  if (sub.quickbooksConnectedAt) return; // first connection only

  await prisma.subscription.update({
    where: { userId },
    data: {
      quickbooksConnectedAt: now,
      // Only complete activation if the other half already happened.
      activatedAt: sub.activatedAt ?? (sub.firstAnalysisAt ? now : null),
    },
  });
}

export async function markFirstAnalysis(userId: string, now: Date = new Date()): Promise<void> {
  const sub = await ensureSubscription(userId, now);
  if (sub.firstAnalysisAt) return; // first analysis only

  await prisma.subscription.update({
    where: { userId },
    data: {
      firstAnalysisAt: now,
      activatedAt: sub.activatedAt ?? (sub.quickbooksConnectedAt ? now : null),
    },
  });
}

/**
 * Best-effort activation tracking for routes whose primary job is something
 * else. A failure to record a growth metric must never fail the customer's
 * actual request (generating their analysis), so this swallows and logs.
 */
export async function tryMarkFirstAnalysis(userId: string): Promise<void> {
  try {
    await markFirstAnalysis(userId);
  } catch (err) {
    console.error(
      "trial: could not record first analysis:",
      err instanceof Error ? err.message : "Unknown error"
    );
  }
}

export async function tryMarkQuickBooksConnected(userId: string): Promise<void> {
  try {
    await markQuickBooksConnected(userId);
  } catch (err) {
    console.error(
      "trial: could not record QuickBooks connection:",
      err instanceof Error ? err.message : "Unknown error"
    );
  }
}

// --- Trial state ---------------------------------------------------------

export interface TrialState {
  onTrial: boolean;
  expired: boolean;
  /** Null for accounts that have converted to paid. */
  trialEndsAt: Date | null;
  trialStartedAt: Date;
  daysRemaining: number;
  dayNumber: number;
  activated: boolean;
  quickbooksConnected: boolean;
  hasRunAnalysis: boolean;
  extensionClaimed: boolean;
  /** True when the "another 14 days for 5 minutes of feedback" offer applies. */
  extensionOffered: boolean;
  /** Why the offer isn't showing, for admin/debug clarity. Null when it is. */
  extensionBlockedReason: string | null;
  /** What the new expiry would be if they claimed right now. */
  extensionWouldEndAt: Date | null;
}

export function computeTrialState(sub: Subscription, now: Date = new Date()): TrialState {
  const trialStartedAt = sub.trialStartedAt ?? sub.createdAt;
  const trialEndsAt = sub.trialEndsAt ?? null;

  // Both statuses count as "on the trial track". Including "trial_expired"
  // matters for two reasons:
  //   1. The expiry cron flips trialing -> trial_expired as bookkeeping. If
  //      only "trialing" counted, `expired` would flip back to false the
  //      moment that ran, and the trial-expired email could never be retried
  //      after a failed send - correctness would depend on two cron stages
  //      running in a particular order on a particular tick.
  //   2. The extension grace window is explicitly meant to stay claimable
  //      for a few days AFTER the trial ends. That's impossible if an
  //      expired trial is treated as "not a trial at all".
  const isTrialStatus = sub.status === "trialing" || sub.status === "trial_expired";
  const expired = isTrialStatus && trialEndsAt != null && trialEndsAt.getTime() <= now.getTime();
  const onTrial = isTrialStatus && !expired;

  const activated = sub.activatedAt != null;
  const extensionClaimed = sub.trialExtendedAt != null;
  const dayNumber = daysSince(trialStartedAt, now);

  const extensionWouldEndAt = trialEndsAt ? addDays(trialEndsAt, TRIAL_EXTENSION_DAYS) : null;

  let extensionBlockedReason: string | null = null;
  if (!isTrialStatus) {
    extensionBlockedReason = "This account isn't on a trial.";
  } else if (extensionClaimed) {
    extensionBlockedReason = "The trial extension has already been used.";
  } else if (!activated) {
    // Guards against a signup-and-immediately-farm-the-survey loop: you have
    // to have actually connected QuickBooks and run an analysis to be
    // offered more time to evaluate.
    extensionBlockedReason =
      "Connect QuickBooks and run your first analysis to unlock the extension offer.";
  } else if (!trialEndsAt) {
    extensionBlockedReason = "This trial has no end date.";
  } else if (dayNumber < TRIAL_EXTENSION_OFFER_DAY) {
    extensionBlockedReason = `The offer opens on day ${TRIAL_EXTENSION_OFFER_DAY} of your trial.`;
  } else if (now.getTime() > addDays(trialEndsAt, TRIAL_EXTENSION_GRACE_DAYS).getTime()) {
    extensionBlockedReason = "The extension offer has closed for this account.";
  }

  return {
    onTrial,
    expired,
    trialEndsAt,
    trialStartedAt,
    daysRemaining: trialEndsAt ? daysUntil(trialEndsAt, now) : 0,
    dayNumber,
    activated,
    quickbooksConnected: sub.quickbooksConnectedAt != null,
    hasRunAnalysis: sub.firstAnalysisAt != null,
    extensionClaimed,
    extensionOffered: extensionBlockedReason === null,
    extensionBlockedReason,
    extensionWouldEndAt,
  };
}

export async function getTrialState(userId: string, now: Date = new Date()): Promise<TrialState> {
  const sub = await ensureSubscription(userId, now);
  return computeTrialState(sub, now);
}

// --- The one-time feedback extension ------------------------------------

export interface TrialFeedbackAnswers {
  mostValuable: string;
  confusing: string;
  wishItShowed: string;
  worthPayingFor: string;
  anythingElse?: string;
}

export type ExtendTrialResult =
  | { ok: true; newTrialEndsAt: Date; daysGranted: number }
  | { ok: false; error: string };

/**
 * Records the feedback survey and extends the trial by exactly 14 days,
 * once per account, ever.
 *
 * Three separate things make this un-farmable:
 *   1. Eligibility is re-checked here against server-side state, not trusted
 *      from whatever the client thought when it rendered the offer.
 *   2. The write happens in a transaction, so the feedback row and the
 *      extension are all-or-nothing.
 *   3. TrialFeedback.userId is @unique at the database level - two
 *      simultaneous submissions cannot both insert, so even a race can only
 *      ever produce one extension. The unique violation is what we catch
 *      below, rather than relying on the read-side check winning the race.
 *
 * The new expiry is the ORIGINAL expiry plus 14 days, not "now plus 14
 * days" - submitting late doesn't manufacture extra trial time.
 */
export async function extendTrialWithFeedback(
  userId: string,
  answers: TrialFeedbackAnswers,
  now: Date = new Date()
): Promise<ExtendTrialResult> {
  const sub = await ensureSubscription(userId, now);
  const state = computeTrialState(sub, now);

  if (!state.extensionOffered || !state.extensionWouldEndAt) {
    return { ok: false, error: state.extensionBlockedReason ?? "You're not eligible for the trial extension." };
  }

  const newTrialEndsAt = state.extensionWouldEndAt;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.trialFeedback.create({
        data: {
          userId,
          mostValuable: answers.mostValuable,
          confusing: answers.confusing,
          wishItShowed: answers.wishItShowed,
          worthPayingFor: answers.worthPayingFor,
          anythingElse: answers.anythingElse?.trim() ? answers.anythingElse.trim() : null,
          daysGranted: TRIAL_EXTENSION_DAYS,
          newTrialEndsAt,
        },
      });

      // updateMany with a trialExtendedAt: null guard is a second, independent
      // safety net: even if the TrialFeedback insert somehow succeeded twice,
      // this can only move the date once.
      //
      // `status` is set back to "trialing" because someone claiming inside
      // the grace window may already have been flipped to "trial_expired" by
      // the expiry cron - extending their trial has to actually restore
      // access, not just move a date on a row the entitlement layer still
      // reads as lapsed.
      const updated = await tx.subscription.updateMany({
        where: {
          userId,
          trialExtendedAt: null,
          status: { in: ["trialing", "trial_expired"] },
        },
        data: { trialEndsAt: newTrialEndsAt, trialExtendedAt: now, status: "trialing" },
      });

      if (updated.count !== 1) {
        throw new Error("TRIAL_ALREADY_EXTENDED");
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message === "TRIAL_ALREADY_EXTENDED") {
      return { ok: false, error: "This trial has already been extended." };
    }
    // Prisma unique-constraint violation on TrialFeedback.userId.
    if (message.includes("Unique constraint") || (err as { code?: string })?.code === "P2002") {
      return { ok: false, error: "You've already submitted feedback and extended your trial." };
    }
    console.error(
      "trial: extension failed:",
      err instanceof Error ? err.message : "Unknown error"
    );
    return { ok: false, error: "Couldn't extend your trial. Please try again." };
  }

  return { ok: true, newTrialEndsAt, daysGranted: TRIAL_EXTENSION_DAYS };
}

/**
 * Moves trials whose end date has passed into the explicit "trial_expired"
 * status. Entitlement checks already treat a past trialEndsAt as expired
 * regardless (see getEntitlements), so this is bookkeeping that keeps admin
 * views and email targeting honest, not the thing enforcing access.
 * Safe to run repeatedly - it only ever touches rows still marked trialing.
 */
export async function expireFinishedTrials(now: Date = new Date()): Promise<number> {
  const result = await prisma.subscription.updateMany({
    where: { status: "trialing", trialEndsAt: { lt: now } },
    data: { status: "trial_expired" },
  });
  return result.count;
}
