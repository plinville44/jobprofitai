import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));

import { PLANS } from "../plans";
import { canConnectAnotherCompany } from "../entitlements";
import {
  joinNames,
  overLimitConnectionIds,
  pausedCompaniesMessage,
  pausedCompanySummary,
  pausedConnectionIds,
  planFit,
} from "../planLimits";
import { SYNC_COOLDOWN_SECONDS, syncCooldownMessage, syncCooldownSecondsLeft } from "../syncCooldown";

const NOW = new Date("2026-09-28T12:00:00Z");
const DAY = 86_400_000;

async function seedAccount(subscription: Record<string, unknown>, companies: string[]) {
  await fake.client.user.create({ data: { id: "u1", email: "owner@example.com" } });
  await fake.client.subscription.create({ data: { userId: "u1", ...subscription } });
  for (const [i, name] of companies.entries()) {
    await fake.client.quickBooksConnection.create({
      data: { id: `c${i + 1}`, userId: "u1", realmIdHash: `h${i + 1}`, companyName: name, connectedAt: new Date(NOW.getTime() - (10 - i) * DAY) },
    });
  }
}

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  fake.client = createFakePrisma();
  for (const key of ["STRIPE_SECRET_KEY", "STRIPE_PRICE_FIRM_MONTHLY"]) savedEnv[key] = process.env[key];
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("paused companies", () => {
  it("pauses the newest companies past the limit", () => {
    const companies = [
      { id: "b", connectedAt: new Date(NOW.getTime() - 2 * DAY) },
      { id: "a", connectedAt: new Date(NOW.getTime() - 5 * DAY) },
      { id: "c", connectedAt: new Date(NOW.getTime() - 1 * DAY) },
    ];
    expect(Array.from(pausedConnectionIds(companies, 1)).sort()).toEqual(["b", "c"]);
    expect(pausedConnectionIds(companies, 3).size).toBe(0);
  });

  it("pauses the two newest when a Pro account with 3 companies moves to the $149 plan", async () => {
    await seedAccount({ status: "active", plan: "profit_intelligence" }, ["Acme Roofing", "Beta Builders", "Cole Electric"]);

    expect(Array.from(await overLimitConnectionIds("u1")).sort()).toEqual(["c2", "c3"]);
    const summary = await pausedCompanySummary("u1");
    expect(summary.maxConnections).toBe(1);
    expect(summary.connected).toBe(3);
    expect(summary.paused.map((c) => c.name)).toEqual(["Beta Builders", "Cole Electric"]);
  });

  it("says which are paused and what to do, in plain words", () => {
    expect(pausedCompaniesMessage(["Beta Builders", "Cole Electric"], 1)).toBe(
      "Your plan covers 1 QuickBooks company. Beta Builders and Cole Electric are paused until you disconnect some companies or choose a plan that covers them all."
    );
    expect(pausedCompaniesMessage(["Beta"], 3)).toMatch(/covers 3 QuickBooks companies\. Beta is paused/);
    expect(pausedCompaniesMessage([], 1)).toBe("");
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
  });
});

describe("the plan chooser", () => {
  it("disables a plan that can't cover the companies already connected, with the reason", () => {
    const fit = planFit(PLANS.profit_intelligence, { connections: 3, activeJobs: 40 });
    expect(fit.fits).toBe(false);
    expect(fit.reason).toMatch(/covers 1 QuickBooks company and you have 3 connected\. Disconnect 2/);
    expect(planFit(PLANS.profit_intelligence_pro, { connections: 3, activeJobs: 40 }).fits).toBe(true);
  });

  it("only warns about open jobs past the $149 plan's 100, since that isn't enforced", () => {
    const fit = planFit(PLANS.profit_intelligence, { connections: 1, activeJobs: 500 });
    expect(fit.fits).toBe(true);
    expect(fit.reason).toBeNull();
    expect(fit.warning).toMatch(/up to 100 open jobs and you have 500/);
    expect(planFit(PLANS.profit_intelligence_pro, { connections: 1, activeJobs: 500 }).warning).toBeNull();
  });
});

describe("company-limit messages", () => {
  it("doesn't send a trial to Pro for more companies, and says Firm starts billing that day", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_PRICE_FIRM_MONTHLY = "price_firm";
    await seedAccount({ status: "trialing", trialEndsAt: new Date(Date.now() + 5 * DAY) }, ["A", "B", "C"]);

    const result = await canConnectAnotherCompany("u1");

    expect(result.allowed).toBe(false);
    expect(result.reason).not.toMatch(/Pro covers/);
    expect(result.reason).toMatch(/Firm plan covers up to 100/);
    expect(result.reason).toMatch(/during your trial starts billing that day/);
  });

  it("never offers Firm when its Stripe price isn't set", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test";
    delete process.env.STRIPE_PRICE_FIRM_MONTHLY;
    await seedAccount({ status: "active", plan: "profit_intelligence" }, ["A"]);

    const result = await canConnectAnotherCompany("u1");

    expect(result.reason).toMatch(/Pro covers up to 3 companies\./);
    expect(result.reason).not.toMatch(/Firm/);
  });

  it("points a trial at support rather than Firm when Firm isn't offered", async () => {
    delete process.env.STRIPE_PRICE_FIRM_MONTHLY;
    await seedAccount({ status: "trialing", trialEndsAt: new Date(Date.now() + 5 * DAY) }, ["A", "B", "C"]);

    const result = await canConnectAnotherCompany("u1");

    expect(result.reason).not.toMatch(/Firm|Pro covers/);
    expect(result.reason).toMatch(/support@jobprofitai\.com/);
  });
});

describe("Sync now cooldown", () => {
  it("waits a short while after any finished sync", () => {
    const justNow = { lastSyncAttemptAt: new Date(NOW.getTime() - 10_000), lastSyncStatus: "success" };
    expect(syncCooldownSecondsLeft(justNow, NOW)).toBe(SYNC_COOLDOWN_SECONDS - 10);
    expect(syncCooldownSecondsLeft({ ...justNow, lastSyncStatus: "error" }, NOW)).toBe(SYNC_COOLDOWN_SECONDS - 10);
    expect(syncCooldownMessage(50)).toBe("This company finished syncing less than a minute ago. Try again in 50 seconds.");
  });

  it("lets a sync run once the cooldown has passed, for a first sync, and leaves a running one to the lock", () => {
    expect(syncCooldownSecondsLeft({ lastSyncAttemptAt: new Date(NOW.getTime() - 61_000), lastSyncStatus: "success" }, NOW)).toBe(0);
    expect(syncCooldownSecondsLeft({ lastSyncAttemptAt: null, lastSyncStatus: null }, NOW)).toBe(0);
    expect(syncCooldownSecondsLeft({ lastSyncAttemptAt: new Date(NOW.getTime() - 5_000), lastSyncStatus: "in_progress" }, NOW)).toBe(0);
  });
});
