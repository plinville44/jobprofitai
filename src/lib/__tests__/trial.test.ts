import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

// The trial module reaches the database through "@/lib/prisma"; everything
// else about it is pure date arithmetic on a Subscription row.
const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));

import {
  TRIAL_EXTENSION_GRACE_DAYS,
  addDays,
  computeTrialState,
  ensureSubscription,
  expireFinishedTrials,
  extendTrialWithFeedback,
  markFirstAnalysis,
  markQuickBooksConnected,
} from "../trial";

const DAY = 86_400_000;
const START = new Date("2026-03-01T09:00:00Z");

/**
 * A trialing subscription always has a trialEndsAt, but the column is nullable
 * in the schema because an account that converted to paying no longer has one.
 * This narrows the type and fails with a readable message if that invariant is
 * ever broken, which a bare `!` would quietly hide behind a
 * "cannot read properties of null" further down the test.
 */
function trialEnd(sub: { trialEndsAt: Date | null }): Date {
  if (!sub.trialEndsAt) throw new Error("expected this subscription to have a trialEndsAt");
  return sub.trialEndsAt;
}

/** A trialing subscription row, `daysAgo` into its 14-day trial. */
function trialSub(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    userId: "user_1",
    status: "trialing",
    plan: "profit_intelligence",
    trialStartedAt: START,
    trialEndsAt: addDays(START, 14),
    trialExtendedAt: null,
    activatedAt: new Date(START.getTime() + DAY),
    quickbooksConnectedAt: new Date(START.getTime() + DAY),
    firstAnalysisAt: new Date(START.getTime() + DAY),
    createdAt: START,
    cancelAtPeriodEnd: false,
    ...overrides,
  } as never;
}

beforeEach(() => {
  fake.client = createFakePrisma();
});

describe("trial state", () => {
  it("gives a new account exactly 14 days", async () => {
    await fake.client.user.create({ data: { id: "u1", email: "a@b.com" } });
    const sub = await ensureSubscription("u1", START);

    expect(sub.status).toBe("trialing");
    expect(trialEnd(sub).getTime() - START.getTime()).toBe(14 * DAY);
    // No card, no Stripe object exists at signup.
    expect(sub.stripeCustomerId).toBeNull();
    expect(sub.stripeSubscriptionId).toBeNull();
  });

  it("is idempotent - a second call returns the same trial, not a new one", async () => {
    await fake.client.user.create({ data: { id: "u1", email: "a@b.com" } });
    const first = await ensureSubscription("u1", START);
    const second = await ensureSubscription("u1", new Date(START.getTime() + 5 * DAY));

    expect(second.id).toBe(first.id);
    expect(trialEnd(second).getTime()).toBe(trialEnd(first).getTime());
    expect(await fake.client.subscription.count()).toBe(1);
  });

  it("counts days remaining and reports expiry", () => {
    const onDay3 = computeTrialState(trialSub(), new Date(START.getTime() + 3 * DAY));
    expect(onDay3.onTrial).toBe(true);
    expect(onDay3.expired).toBe(false);
    expect(onDay3.daysRemaining).toBe(11);
    expect(onDay3.dayNumber).toBe(3);

    const afterEnd = computeTrialState(trialSub(), new Date(START.getTime() + 15 * DAY));
    expect(afterEnd.onTrial).toBe(false);
    expect(afterEnd.expired).toBe(true);
    expect(afterEnd.daysRemaining).toBe(0);
  });
});

describe("the extension offer window", () => {
  const at = (day: number) => new Date(START.getTime() + day * DAY);

  it("is closed before day 12", () => {
    const state = computeTrialState(trialSub(), at(11));
    expect(state.extensionOffered).toBe(false);
    expect(state.extensionBlockedReason).toMatch(/day 12/);
  });

  it("opens on day 12 for an activated account", () => {
    const state = computeTrialState(trialSub(), at(12));
    expect(state.extensionOffered).toBe(true);
    expect(state.extensionBlockedReason).toBeNull();
  });

  /**
   * The anti-abuse rule that matters: signing up and immediately farming the
   * survey is blocked by requiring real product usage first.
   */
  it("stays closed for an account that never activated", () => {
    const state = computeTrialState(
      trialSub({ activatedAt: null, quickbooksConnectedAt: null, firstAnalysisAt: null }),
      at(13)
    );
    expect(state.extensionOffered).toBe(false);
    expect(state.extensionBlockedReason).toMatch(/Connect QuickBooks/);
  });

  it("stays closed once the extension has been used", () => {
    const state = computeTrialState(trialSub({ trialExtendedAt: at(12) }), at(13));
    expect(state.extensionOffered).toBe(false);
    expect(state.extensionBlockedReason).toMatch(/already been used/);
  });

  it("remains claimable during the grace period, then closes", () => {
    const justInside = at(14 + TRIAL_EXTENSION_GRACE_DAYS - 1);
    const justOutside = at(14 + TRIAL_EXTENSION_GRACE_DAYS + 1);
    expect(computeTrialState(trialSub(), justInside).extensionOffered).toBe(true);
    expect(computeTrialState(trialSub(), justOutside).extensionOffered).toBe(false);
  });

  it("still reports an expired trial after the cron flips its status", () => {
    // Before the fix this returned expired:false once status became
    // "trial_expired", which silently made the trial-expired email
    // unretryable and closed the grace window early.
    const state = computeTrialState(
      trialSub({ status: "trial_expired" }),
      at(16)
    );
    expect(state.expired).toBe(true);
    expect(state.onTrial).toBe(false);
    expect(state.extensionOffered).toBe(true); // still inside the grace window
  });

  it("extends the ORIGINAL end date, not the submission date", () => {
    // Claiming late must not manufacture extra trial time.
    const state = computeTrialState(trialSub(), at(13));
    expect(state.extensionWouldEndAt?.getTime()).toBe(addDays(START, 28).getTime());
  });
});

describe("claiming the extension", () => {
  async function seedEligibleUser() {
    await fake.client.user.create({ data: { id: "u1", email: "a@b.com" } });
    await fake.client.subscription.create({
      data: {
        userId: "u1",
        status: "trialing",
        plan: "profit_intelligence",
        trialStartedAt: START,
        trialEndsAt: addDays(START, 14),
        activatedAt: new Date(START.getTime() + DAY),
        quickbooksConnectedAt: new Date(START.getTime() + DAY),
        firstAnalysisAt: new Date(START.getTime() + DAY),
        createdAt: START,
      },
    });
  }

  const answers = {
    mostValuable: "Seeing margin per job.",
    confusing: "Setting the target margin.",
    wishItShowed: "Labor hours per job.",
    worthPayingFor: "Catching overruns sooner.",
  };

  it("adds exactly 14 days and records the feedback", async () => {
    await seedEligibleUser();
    const now = new Date(START.getTime() + 12 * DAY);

    const result = await extendTrialWithFeedback("u1", answers, now);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.daysGranted).toBe(14);
    expect(result.newTrialEndsAt.getTime()).toBe(addDays(START, 28).getTime());

    const sub = await fake.client.subscription.findUnique({ where: { userId: "u1" } });
    expect(sub.trialEndsAt.getTime()).toBe(addDays(START, 28).getTime());
    expect(sub.trialExtendedAt).not.toBeNull();
    expect(await fake.client.trialFeedback.count()).toBe(1);
  });

  it("can only ever be claimed once", async () => {
    await seedEligibleUser();
    const now = new Date(START.getTime() + 12 * DAY);

    const first = await extendTrialWithFeedback("u1", answers, now);
    const second = await extendTrialWithFeedback("u1", answers, now);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already/i);

    const sub = await fake.client.subscription.findUnique({ where: { userId: "u1" } });
    // 28 days, not 42 - the second submission changed nothing.
    expect(sub.trialEndsAt.getTime()).toBe(addDays(START, 28).getTime());
    expect(await fake.client.trialFeedback.count()).toBe(1);
  });

  it("cannot be farmed by repeated submissions", async () => {
    await seedEligibleUser();
    const now = new Date(START.getTime() + 12 * DAY);

    for (let i = 0; i < 5; i++) {
      await extendTrialWithFeedback("u1", answers, now);
    }

    const sub = await fake.client.subscription.findUnique({ where: { userId: "u1" } });
    expect(sub.trialEndsAt.getTime()).toBe(addDays(START, 28).getTime());
    expect(await fake.client.trialFeedback.count()).toBe(1);
  });

  it("is refused before the offer window opens", async () => {
    await seedEligibleUser();
    const tooEarly = new Date(START.getTime() + 5 * DAY);

    const result = await extendTrialWithFeedback("u1", answers, tooEarly);

    expect(result.ok).toBe(false);
    expect(await fake.client.trialFeedback.count()).toBe(0);
    const sub = await fake.client.subscription.findUnique({ where: { userId: "u1" } });
    expect(sub.trialEndsAt.getTime()).toBe(addDays(START, 14).getTime());
  });

  /**
   * Regression: the expiry cron flips trialing -> trial_expired as
   * bookkeeping. Someone claiming inside the grace window must still get
   * their extension AND be put back on an active trial - moving the date on
   * a row the entitlement layer still reads as lapsed would grant nothing.
   */
  it("still works inside the grace window after the status flipped to expired", async () => {
    await seedEligibleUser();
    await fake.client.subscription.update({
      where: { userId: "u1" },
      data: { status: "trial_expired" },
    });

    const inGrace = new Date(START.getTime() + 16 * DAY);
    const result = await extendTrialWithFeedback("u1", answers, inGrace);

    expect(result.ok).toBe(true);
    const sub = await fake.client.subscription.findUnique({ where: { userId: "u1" } });
    expect(sub.status).toBe("trialing"); // access actually restored
    expect(sub.trialEndsAt.getTime()).toBe(addDays(START, 28).getTime());
  });

  it("is refused for an unactivated account", async () => {
    await fake.client.user.create({ data: { id: "u2", email: "c@d.com" } });
    await fake.client.subscription.create({
      data: {
        userId: "u2",
        status: "trialing",
        plan: "profit_intelligence",
        trialStartedAt: START,
        trialEndsAt: addDays(START, 14),
        createdAt: START,
      },
    });

    const result = await extendTrialWithFeedback("u2", answers, new Date(START.getTime() + 13 * DAY));

    expect(result.ok).toBe(false);
    expect(await fake.client.trialFeedback.count()).toBe(0);
  });
});

describe("activation tracking", () => {
  beforeEach(async () => {
    await fake.client.user.create({ data: { id: "u1", email: "a@b.com" } });
    await ensureSubscription("u1", START);
  });

  it("requires BOTH a QuickBooks connection and a first analysis", async () => {
    await markQuickBooksConnected("u1", new Date(START.getTime() + DAY));
    let sub = await fake.client.subscription.findUnique({ where: { userId: "u1" } });
    expect(sub.quickbooksConnectedAt).not.toBeNull();
    expect(sub.activatedAt).toBeNull(); // not activated on one half alone

    await markFirstAnalysis("u1", new Date(START.getTime() + 2 * DAY));
    sub = await fake.client.subscription.findUnique({ where: { userId: "u1" } });
    expect(sub.firstAnalysisAt).not.toBeNull();
    expect(sub.activatedAt).not.toBeNull();
  });

  it("activates regardless of which half happens first", async () => {
    await markFirstAnalysis("u1", new Date(START.getTime() + DAY));
    expect((await fake.client.subscription.findUnique({ where: { userId: "u1" } })).activatedAt).toBeNull();

    await markQuickBooksConnected("u1", new Date(START.getTime() + 2 * DAY));
    expect(
      (await fake.client.subscription.findUnique({ where: { userId: "u1" } })).activatedAt
    ).not.toBeNull();
  });

  it("only records the first occurrence of each", async () => {
    const firstTime = new Date(START.getTime() + DAY);
    await markQuickBooksConnected("u1", firstTime);
    await markQuickBooksConnected("u1", new Date(START.getTime() + 9 * DAY));

    const sub = await fake.client.subscription.findUnique({ where: { userId: "u1" } });
    expect(sub.quickbooksConnectedAt.getTime()).toBe(firstTime.getTime());
  });
});

describe("expiring finished trials", () => {
  it("moves only past-due trials, and is safe to re-run", async () => {
    await fake.client.subscription.create({
      data: { userId: "live", status: "trialing", trialEndsAt: addDays(START, 14) },
    });
    await fake.client.subscription.create({
      data: { userId: "done", status: "trialing", trialEndsAt: addDays(START, 2) },
    });
    await fake.client.subscription.create({
      data: { userId: "paying", status: "active", trialEndsAt: addDays(START, 2) },
    });

    const now = new Date(START.getTime() + 5 * DAY);
    expect(await expireFinishedTrials(now)).toBe(1);
    // Re-running finds nothing left to do.
    expect(await expireFinishedTrials(now)).toBe(0);

    expect((await fake.client.subscription.findUnique({ where: { userId: "done" } })).status).toBe(
      "trial_expired"
    );
    expect((await fake.client.subscription.findUnique({ where: { userId: "live" } })).status).toBe(
      "trialing"
    );
    expect((await fake.client.subscription.findUnique({ where: { userId: "paying" } })).status).toBe(
      "active"
    );
  });
});
