import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));

// Stripe is mocked at the billing-module boundary so these tests exercise the
// referral rules, not the network. `applyCustomerCredit` records what it was
// asked to do, including the idempotency key.
const creditCalls: { customerId: string; amountCents: number; idempotencyKey: string }[] = [];
let creditShouldFail = false;
vi.mock("@/lib/stripe/billing", () => ({
  applyCustomerCredit: vi.fn(async (params: any) => {
    if (creditShouldFail) throw new Error("stripe unavailable");
    creditCalls.push({
      customerId: params.customerId,
      amountCents: params.amountCents,
      idempotencyKey: params.idempotencyKey,
    });
    return { id: `txn_${creditCalls.length}` };
  }),
}));

import {
  attributeReferral,
  disqualifyReferral,
  getOrCreateCustomerReferralCode,
  getReferralSummary,
  markReferralPaid,
  normalizeCode,
  qualifyDueReferrals,
  referralUrl,
} from "../referrals";

const NOW = new Date("2026-06-01T12:00:00Z");
const DAY = 86_400_000;

async function makeUser(id: string, plan = "profit_intelligence", status = "active") {
  await fake.client.user.create({ data: { id, email: `${id}@example.com` } });
  await fake.client.subscription.create({
    data: {
      userId: id,
      status,
      plan,
      stripeCustomerId: status === "active" ? `cus_${id}` : null,
    },
  });
}

beforeEach(() => {
  fake.client = createFakePrisma();
  creditCalls.length = 0;
  creditShouldFail = false;
  process.env.APP_URL = "https://jobprofitai.com";
});

describe("referral codes", () => {
  it("issues one stable code per customer", async () => {
    await makeUser("alice");
    const first = await getOrCreateCustomerReferralCode("alice");
    const second = await getOrCreateCustomerReferralCode("alice");

    expect(first).toBe(second);
    expect(await fake.client.referralCode.count()).toBe(1);
  });

  it("uses an unambiguous alphabet and case-insensitive matching", async () => {
    await makeUser("alice");
    const code = await getOrCreateCustomerReferralCode("alice");

    // No 0/O/1/I/L - these get read aloud and hand-typed.
    expect(code).toMatch(/^[23456789BCDFGHJKMNPQRSTVWXYZ]{7}$/);
    expect(normalizeCode(code.toLowerCase())).toBe(code);
    expect(referralUrl(code)).toBe(`https://jobprofitai.com/r/${code}`);
  });
});

describe("attribution", () => {
  it("records a referral when a new account signs up with a code", async () => {
    await makeUser("alice");
    await makeUser("bob", "profit_intelligence", "trialing");
    const code = await getOrCreateCustomerReferralCode("alice");

    const result = await attributeReferral("bob", code);

    expect(result.attributed).toBe(true);
    if (!result.attributed) return;
    expect(result.referral.referrerUserId).toBe("alice");
    expect(result.referral.kind).toBe("customer");
  });

  it("rejects self-referral", async () => {
    await makeUser("alice");
    const code = await getOrCreateCustomerReferralCode("alice");

    const result = await attributeReferral("alice", code);

    expect(result.attributed).toBe(false);
    if (result.attributed) return;
    expect(result.reason).toMatch(/refer yourself/i);
    expect(await fake.client.referral.count()).toBe(0);
  });

  /** One referred account can only ever be credited to a single referrer. */
  it("refuses to attribute the same account twice", async () => {
    await makeUser("alice");
    await makeUser("carol");
    await makeUser("bob", "profit_intelligence", "trialing");

    const aliceCode = await getOrCreateCustomerReferralCode("alice");
    const carolCode = await getOrCreateCustomerReferralCode("carol");

    expect((await attributeReferral("bob", aliceCode)).attributed).toBe(true);
    const second = await attributeReferral("bob", carolCode);

    expect(second.attributed).toBe(false);
    expect(await fake.client.referral.count()).toBe(1);
  });

  it("ignores unknown codes without failing the signup", async () => {
    await makeUser("bob", "profit_intelligence", "trialing");
    const result = await attributeReferral("bob", "NOTACODE");
    expect(result.attributed).toBe(false);
    expect(await fake.client.referral.count()).toBe(0);
  });

  it("won't attribute to a partner code that isn't approved", async () => {
    await makeUser("firm");
    await makeUser("bob", "profit_intelligence", "trialing");
    const partner = await fake.client.partner.create({
      data: { userId: "firm", firmName: "Ledger Co", contactName: "Sam", status: "pending" },
    });
    await fake.client.referralCode.create({
      data: { code: "PARTNR1", kind: "partner", partnerId: partner.id },
    });

    const result = await attributeReferral("bob", "PARTNR1");

    expect(result.attributed).toBe(false);
  });
});

describe("reward qualification", () => {
  async function setUpConvertedReferral(referrerPlan: string, paidDaysAgo: number) {
    await makeUser("alice", referrerPlan, "active");
    await makeUser("bob", "profit_intelligence", "active");
    const code = await getOrCreateCustomerReferralCode("alice");
    await attributeReferral("bob", code);
    await markReferralPaid("bob", new Date(NOW.getTime() - paidDaysAgo * DAY));
  }

  it("does NOT grant a credit the moment a referral converts", async () => {
    await setUpConvertedReferral("profit_intelligence", 1);

    const results = await qualifyDueReferrals(NOW);

    expect(results).toHaveLength(0);
    expect(await fake.client.referralReward.count()).toBe(0);
    expect(creditCalls).toHaveLength(0);
  });

  it("grants the credit after 30 days of sustained payment", async () => {
    await setUpConvertedReferral("profit_intelligence", 31);

    const results = await qualifyDueReferrals(NOW);

    expect(results).toHaveLength(1);
    expect(results[0].amountCents).toBe(14_900);
    expect(results[0].creditApplied).toBe(true);
    expect(creditCalls[0].customerId).toBe("cus_alice");
    expect(creditCalls[0].amountCents).toBe(14_900);
  });

  it("sizes the reward from the referrer's own plan", async () => {
    await setUpConvertedReferral("profit_intelligence_pro", 31);

    const results = await qualifyDueReferrals(NOW);

    expect(results[0].amountCents).toBe(29_900);
    expect(creditCalls[0].amountCents).toBe(29_900);
  });

  it("issues one reward per referral, no matter how often qualification runs", async () => {
    await setUpConvertedReferral("profit_intelligence", 31);

    await qualifyDueReferrals(NOW);
    await qualifyDueReferrals(NOW);
    await qualifyDueReferrals(NOW);

    expect(await fake.client.referralReward.count()).toBe(1);
    expect(creditCalls).toHaveLength(1);
    // The Stripe idempotency key is derived from the reward, so even a
    // repeated call could not double-credit at Stripe's end either.
    expect(creditCalls[0].idempotencyKey).toMatch(/^referral-reward:/);
  });

  it("stacks credits across multiple qualified referrals", async () => {
    await makeUser("alice", "profit_intelligence", "active");
    const code = await getOrCreateCustomerReferralCode("alice");

    for (const name of ["bob", "carol", "dave"]) {
      await makeUser(name, "profit_intelligence", "active");
      await attributeReferral(name, code);
      await markReferralPaid(name, new Date(NOW.getTime() - 31 * DAY));
    }

    const results = await qualifyDueReferrals(NOW);

    expect(results).toHaveLength(3);
    const total = results.reduce((t, r) => t + r.amountCents, 0);
    expect(total).toBe(44_700); // 3 x $149
    expect(creditCalls.reduce((t, c) => t + c.amountCents, 0)).toBe(44_700);

    const summary = await getReferralSummary("alice");
    expect(summary.qualified).toBe(3);
    expect(summary.totalEarnedCents).toBe(44_700);
  });

  it("does not reward a referral whose subscription lapsed inside the window", async () => {
    await makeUser("alice", "profit_intelligence", "active");
    await makeUser("bob", "profit_intelligence", "canceled");
    const code = await getOrCreateCustomerReferralCode("alice");
    await attributeReferral("bob", code);
    await markReferralPaid("bob", new Date(NOW.getTime() - 31 * DAY));

    const results = await qualifyDueReferrals(NOW);

    expect(results).toHaveLength(0);
    expect(await fake.client.referralReward.count()).toBe(0);
    const referral = await fake.client.referral.findUnique({ where: { referredUserId: "bob" } });
    expect(referral.status).toBe("disqualified");
  });

  /**
   * A Stripe outage must leave the reward recoverable, not lost - the row
   * stays pending and the next cron run retries it.
   */
  it("keeps a reward pending when the credit call fails, and applies it later", async () => {
    await setUpConvertedReferral("profit_intelligence", 31);
    creditShouldFail = true;

    const first = await qualifyDueReferrals(NOW);
    expect(first[0].creditApplied).toBe(false);
    const reward = (await fake.client.referralReward.findMany())[0];
    expect(reward.status).toBe("pending");

    // Later run, Stripe healthy again.
    creditShouldFail = false;
    const { tryApplyReward } = await import("../referrals");
    expect(await tryApplyReward(reward.id)).toBe(true);
    expect(
      (await fake.client.referralReward.findUnique({ where: { id: reward.id } })).status
    ).toBe("applied");
  });

  it("leaves a reward pending when the referrer has no Stripe customer yet", async () => {
    // Someone still on a free trial can earn a credit; it waits for them.
    await makeUser("alice", "profit_intelligence", "trialing");
    await makeUser("bob", "profit_intelligence", "active");
    const code = await getOrCreateCustomerReferralCode("alice");
    await attributeReferral("bob", code);
    await markReferralPaid("bob", new Date(NOW.getTime() - 31 * DAY));

    const results = await qualifyDueReferrals(NOW);

    expect(results).toHaveLength(1);
    expect(results[0].creditApplied).toBe(false);
    expect(creditCalls).toHaveLength(0);
    expect((await fake.client.referralReward.findMany())[0].status).toBe("pending");
  });
});

describe("refunds and chargebacks", () => {
  it("disqualifies the referral and voids an earned reward", async () => {
    await makeUser("alice", "profit_intelligence", "active");
    await makeUser("bob", "profit_intelligence", "active");
    const code = await getOrCreateCustomerReferralCode("alice");
    await attributeReferral("bob", code);
    await markReferralPaid("bob", new Date(NOW.getTime() - 31 * DAY));
    await qualifyDueReferrals(NOW);

    await disqualifyReferral("bob", "Payment refunded", NOW);

    const referral = await fake.client.referral.findUnique({ where: { referredUserId: "bob" } });
    expect(referral.status).toBe("disqualified");
    const reward = (await fake.client.referralReward.findMany())[0];
    expect(reward.status).toBe("voided");
    expect(reward.voidReason).toBe("Payment refunded");
  });
});

describe("referrer privacy", () => {
  it("never exposes the referred account's identity in the summary", async () => {
    await makeUser("alice", "profit_intelligence", "active");
    await makeUser("bob", "profit_intelligence", "active");
    const code = await getOrCreateCustomerReferralCode("alice");
    await attributeReferral("bob", code);

    const summary = await getReferralSummary("alice");

    expect(summary.signedUp).toBe(1);
    expect(JSON.stringify(summary)).not.toContain("bob");
    expect(JSON.stringify(summary)).not.toContain("bob@example.com");
  });
});
