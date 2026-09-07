import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));

import { addDays } from "../trial";
import {
  canConnectAnotherCompany,
  getEntitlements,
  getUsageAgainstLimits,
  isAdminEmail,
  requireFeature,
} from "../entitlements";

const NOW = new Date("2026-03-15T12:00:00Z");

async function seed(subscription: Record<string, unknown>) {
  await fake.client.user.create({ data: { id: "u1", email: "owner@example.com" } });
  await fake.client.subscription.create({ data: { userId: "u1", ...subscription } });
}

beforeEach(() => {
  fake.client = createFakePrisma();
});

describe("entitlement resolution", () => {
  it("gives a live trial full Pro-level access", async () => {
    await seed({ status: "trialing", trialEndsAt: addDays(NOW, 5) });

    const ent = await getEntitlements("u1", NOW);

    expect(ent.access).toBe("trialing");
    expect(ent.active).toBe(true);
    expect(ent.trialing).toBe(true);
    expect(ent.trialDaysRemaining).toBe(5);
    // Full access means the forward-looking Pro features too.
    expect(ent.has("ai_insights")).toBe(true);
    expect(ent.has("forecast_at_completion")).toBe(true);
    expect(ent.has("profit_opportunities")).toBe(true);
    expect(ent.limits.maxActiveJobs).toBeNull();
  });

  it("revokes access when the trial end date has passed", async () => {
    // Status still says "trialing" - the DATE is what decides, so an account
    // the expiry cron hasn't reached yet is still correctly locked out.
    await seed({ status: "trialing", trialEndsAt: addDays(NOW, -1) });

    const ent = await getEntitlements("u1", NOW);

    expect(ent.access).toBe("trial_expired");
    expect(ent.active).toBe(false);
    expect(ent.has("dashboard")).toBe(false);
    expect(ent.has("ai_insights")).toBe(false);
  });

  it("gives the $149 plan the full intelligence promise, but not Pro analysis", async () => {
    await seed({ status: "active", plan: "profit_intelligence" });

    const ent = await getEntitlements("u1", NOW);

    expect(ent.access).toBe("active");
    expect(ent.has("dashboard")).toBe(true);
    // The core promise is NOT withheld from the entry plan.
    expect(ent.has("ai_insights")).toBe(true);
    expect(ent.has("margin_alerts")).toBe(true);
    // Pro-only additions.
    expect(ent.has("forecast_at_completion")).toBe(false);
    expect(ent.has("cross_job_benchmarking")).toBe(false);
    expect(ent.limits).toEqual({ maxConnections: 1, maxActiveJobs: 100 });
  });

  it("gives Pro everything plus its higher limits", async () => {
    await seed({ status: "active", plan: "profit_intelligence_pro" });

    const ent = await getEntitlements("u1", NOW);

    expect(ent.has("ai_insights")).toBe(true);
    expect(ent.has("forecast_at_completion")).toBe(true);
    expect(ent.has("cross_job_benchmarking")).toBe(true);
    expect(ent.limits).toEqual({ maxConnections: 3, maxActiveJobs: null });
  });

  it("keeps access during past_due but flags the payment problem", async () => {
    await seed({ status: "past_due", plan: "profit_intelligence" });

    const ent = await getEntitlements("u1", NOW);

    expect(ent.active).toBe(true);
    expect(ent.paymentIssue).toBe(true);
    expect(ent.has("ai_insights")).toBe(true);
  });

  it("denies access once canceled", async () => {
    await seed({ status: "canceled", plan: "profit_intelligence_pro" });

    const ent = await getEntitlements("u1", NOW);

    expect(ent.access).toBe("canceled");
    expect(ent.active).toBe(false);
    expect(ent.features.size).toBe(0);
  });

  /** A billing gate must fail closed, never open. */
  it("denies access for an unrecognized status", async () => {
    await seed({ status: "some_future_stripe_status", plan: "profit_intelligence_pro" });

    const ent = await getEntitlements("u1", NOW);

    expect(ent.active).toBe(false);
    expect(ent.has("dashboard")).toBe(false);
  });

  it("denies access when no subscription row exists at all", async () => {
    await fake.client.user.create({ data: { id: "u1", email: "owner@example.com" } });

    const ent = await getEntitlements("u1", NOW);

    expect(ent.access).toBe("none");
    expect(ent.active).toBe(false);
  });

  it("still keeps access while a cancellation is pending at period end", async () => {
    await seed({
      status: "active",
      plan: "profit_intelligence",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: addDays(NOW, 10),
    });

    const ent = await getEntitlements("u1", NOW);

    expect(ent.active).toBe(true);
    expect(ent.cancelAtPeriodEnd).toBe(true);
  });
});

describe("requireFeature", () => {
  it("returns null for a feature the plan doesn't include", async () => {
    await seed({ status: "active", plan: "profit_intelligence" });
    expect(await requireFeature("u1", "forecast_at_completion")).toBeNull();
    expect(await requireFeature("u1", "ai_insights")).not.toBeNull();
  });

  it("returns null for every feature once access has lapsed", async () => {
    await seed({ status: "canceled", plan: "profit_intelligence_pro" });
    expect(await requireFeature("u1", "dashboard")).toBeNull();
    expect(await requireFeature("u1", "ai_insights")).toBeNull();
  });
});

describe("plan limits", () => {
  it("reports usage against the plan without altering data", async () => {
    await seed({ status: "active", plan: "profit_intelligence" });
    await fake.client.quickBooksConnection.create({
      data: { id: "c1", userId: "u1", realmIdHash: "h1", disconnectedAt: null },
    });

    const usage = await getUsageAgainstLimits("u1");

    expect(usage.connections).toBe(1);
    expect(usage.maxConnections).toBe(1);
    expect(usage.overConnectionLimit).toBe(false);
  });

  it("refuses a second QuickBooks company on the $149 plan", async () => {
    await seed({ status: "active", plan: "profit_intelligence" });
    await fake.client.quickBooksConnection.create({
      data: { id: "c1", userId: "u1", realmIdHash: "h1", disconnectedAt: null },
    });

    const result = await canConnectAnotherCompany("u1");

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Pro covers up to 3/);
  });

  it("allows up to three companies on Pro", async () => {
    await seed({ status: "active", plan: "profit_intelligence_pro" });
    for (const id of ["c1", "c2"]) {
      await fake.client.quickBooksConnection.create({
        data: { id, userId: "u1", realmIdHash: id, disconnectedAt: null },
      });
    }

    expect((await canConnectAnotherCompany("u1")).allowed).toBe(true);

    await fake.client.quickBooksConnection.create({
      data: { id: "c3", userId: "u1", realmIdHash: "c3", disconnectedAt: null },
    });
    expect((await canConnectAnotherCompany("u1")).allowed).toBe(false);
  });

  it("refuses any new connection once the trial has expired", async () => {
    await seed({ status: "trialing", trialEndsAt: addDays(NOW, -2) });

    const result = await canConnectAnotherCompany("u1");

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/trial has ended/i);
  });
});

describe("admin allowlist", () => {
  it("grants nobody admin when ADMIN_EMAILS is unset", () => {
    delete process.env.ADMIN_EMAILS;
    expect(isAdminEmail("anyone@example.com")).toBe(false);
  });

  it("matches allowlisted addresses case-insensitively", () => {
    process.env.ADMIN_EMAILS = "boss@example.com, ops@example.com";
    expect(isAdminEmail("BOSS@Example.com")).toBe(true);
    expect(isAdminEmail("ops@example.com")).toBe(true);
    expect(isAdminEmail("intruder@example.com")).toBe(false);
    expect(isAdminEmail(null)).toBe(false);
    delete process.env.ADMIN_EMAILS;
  });
});
