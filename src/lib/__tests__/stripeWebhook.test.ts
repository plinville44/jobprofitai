import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));

vi.mock("stripe", () => ({ default: class {} }));

// The webhook handler's collaborators are mocked so these tests are about
// event dispatch and idempotency specifically - the commission and referral
// rules themselves have their own suites.
const calls = {
  commissions: [] as string[],
  voided: [] as string[],
  disqualified: [] as string[],
  emails: [] as string[],
  pendingRewardsApplied: 0,
};

vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    subscriptions: { retrieve: vi.fn() },
    charges: { retrieve: vi.fn() },
  }),
  planForPriceId: (priceId: string | null) =>
    priceId === "price_149"
      ? "profit_intelligence"
      : priceId === "price_299"
        ? "profit_intelligence_pro"
        : null,
}));

vi.mock("@/lib/stripe/billing", () => ({
  priceIdFromSubscription: (sub: any) => sub.items?.data?.[0]?.price?.id ?? null,
  subscriptionRevenueCents: (invoice: any) => invoice.amount_paid ?? 0,
}));

vi.mock("@/lib/referrals", () => ({
  applyPendingRewardsForUser: vi.fn(async () => {
    calls.pendingRewardsApplied += 1;
    return 1;
  }),
  disqualifyReferral: vi.fn(async (userId: string) => {
    calls.disqualified.push(userId);
  }),
  markReferralPaid: vi.fn(async () => null),
}));

vi.mock("@/lib/partners", () => ({
  countPayingClients: vi.fn(async () => 3),
  recordCommissionForInvoice: vi.fn(async ({ invoice }: any) => {
    calls.commissions.push(invoice.id);
    return { commissionCents: 2980, monthNumber: 1, rateBps: 2000 };
  }),
  voidCommissionForInvoice: vi.fn(async (invoiceId: string) => {
    calls.voided.push(invoiceId);
    return true;
  }),
}));

vi.mock("@/lib/email/lifecycle", () => ({
  sendPartnerCommissionEarned: vi.fn(async () => {
    calls.emails.push("partner_commission");
    return { ok: true };
  }),
  sendPartnerNewPayingClient: vi.fn(async () => {
    calls.emails.push("partner_new_paying");
    return { ok: true };
  }),
  sendPaymentFailed: vi.fn(async () => {
    calls.emails.push("payment_failed");
    return { ok: true };
  }),
  sendReferralConverted: vi.fn(async () => {
    calls.emails.push("referral_converted");
    return { ok: true };
  }),
  sendSubscriptionCanceled: vi.fn(async () => {
    calls.emails.push("subscription_canceled");
    return { ok: true };
  }),
  sendSubscriptionConfirmed: vi.fn(async () => {
    calls.emails.push("subscription_confirmed");
    return { ok: true };
  }),
}));

import { processStripeEvent } from "../stripe/webhookHandlers";

function subscriptionEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_sub_1",
    type: "customer.subscription.updated",
    api_version: "2024-06-20",
    data: {
      object: {
        id: "sub_abc",
        customer: "cus_1",
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 2_592_000,
        cancel_at_period_end: false,
        canceled_at: null,
        items: { data: [{ price: { id: "price_149" } }] },
        metadata: { jobprofitaiUserId: "u1" },
        ...overrides,
      },
    },
  } as never;
}

async function seedAccount(subscription: Record<string, unknown> = {}) {
  await fake.client.user.create({ data: { id: "u1", email: "owner@example.com" } });
  await fake.client.subscription.create({
    data: {
      userId: "u1",
      status: "trialing",
      plan: "profit_intelligence",
      stripeCustomerId: "cus_1",
      ...subscription,
    },
  });
}

beforeEach(() => {
  fake.client = createFakePrisma();
  calls.commissions.length = 0;
  calls.voided.length = 0;
  calls.disqualified.length = 0;
  calls.emails.length = 0;
  calls.pendingRewardsApplied = 0;
});

describe("event idempotency", () => {
  it("processes an event once and marks repeats as duplicates", async () => {
    await seedAccount();
    const event = subscriptionEvent();

    const first = await processStripeEvent(event);
    const second = await processStripeEvent(event);
    const third = await processStripeEvent(event);

    expect(first.handled).toBe(true);
    expect(first.duplicate).toBeUndefined();
    expect(second.duplicate).toBe(true);
    expect(third.duplicate).toBe(true);
    expect(await fake.client.stripeEvent.count()).toBe(1);
  });

  it("only sends the subscription welcome once across redeliveries", async () => {
    await seedAccount();
    const event = subscriptionEvent();

    await processStripeEvent(event);
    await processStripeEvent(event);
    await processStripeEvent(event);

    expect(calls.emails.filter((e) => e === "subscription_confirmed")).toHaveLength(1);
  });

  it("only records commission once for a redelivered invoice.paid", async () => {
    await seedAccount({ status: "active" });
    await fake.client.referral.create({
      data: {
        referralCodeId: "rc_1",
        kind: "partner",
        partnerId: "p1",
        referredUserId: "u1",
        status: "paid",
        firstPaidAt: new Date(),
      },
    });
    await fake.client.user.create({ data: { id: "firm", email: "firm@example.com" } });
    await fake.client.partner.create({
      data: { id: "p1", userId: "firm", firmName: "Ledger", contactName: "Sam", status: "approved" },
    });

    const event = {
      id: "evt_invoice_1",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_1",
          customer: "cus_1",
          subscription: "sub_abc",
          amount_paid: 14_900,
          status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
          lines: { data: [] },
        },
      },
    } as never;

    await processStripeEvent(event);
    await processStripeEvent(event);

    expect(calls.commissions).toEqual(["in_1"]);
  });

  /**
   * Stripe moved `subscription` and `subscription_details` from the top of the
   * Invoice object into `parent.subscription_details` in the 2025 API
   * versions. Which shape arrives depends on the API version set on the
   * webhook endpoint in the Stripe dashboard, which is not under this repo's
   * control and can be changed by anyone with dashboard access.
   *
   * If the newer shape were unhandled, the failure would be silent and
   * expensive: the charge succeeds, the customer is billed, and the partner's
   * commission for that payment is simply never recorded. So the nested shape
   * gets its own test rather than being trusted to a code comment.
   */
  it("records commission when the invoice uses the newer nested shape", async () => {
    await seedAccount({ status: "active" });
    await fake.client.referral.create({
      data: {
        referralCodeId: "rc_1",
        kind: "partner",
        partnerId: "p1",
        referredUserId: "u1",
        status: "paid",
        firstPaidAt: new Date(),
      },
    });
    await fake.client.user.create({ data: { id: "firm", email: "firm@example.com" } });
    await fake.client.partner.create({
      data: { id: "p1", userId: "firm", firmName: "Ledger", contactName: "Sam", status: "approved" },
    });

    const event = {
      id: "evt_invoice_nested",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_nested",
          customer: "cus_1",
          // No top-level `subscription` - exactly what a 2025+ payload looks like.
          parent: {
            subscription_details: {
              subscription: "sub_abc",
              metadata: { jobprofitaiUserId: "u1" },
            },
          },
          amount_paid: 14_900,
          status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
          lines: { data: [] },
        },
      },
    } as never;

    await processStripeEvent(event);

    expect(calls.commissions).toEqual(["in_nested"]);
  });

  /**
   * A failing handler must RELEASE its event claim, or Stripe's retry would
   * be swallowed as a duplicate and the state change lost forever.
   */
  it("releases the claim when the handler throws, so a retry can re-run", async () => {
    // No account seeded and no subscription row - the update inside the
    // handler throws on a missing record.
    await fake.client.user.create({ data: { id: "u1", email: "owner@example.com" } });
    await fake.client.subscription.create({
      data: { userId: "u1", status: "trialing", stripeCustomerId: "cus_1" },
    });
    await fake.client.subscription.deleteMany({});

    const event = subscriptionEvent();
    // resolveUserId falls back to metadata, then update() fails on no row.
    await expect(processStripeEvent(event)).rejects.toBeTruthy();

    expect(await fake.client.stripeEvent.count()).toBe(0);
  });
});

describe("subscription state is mirrored from Stripe", () => {
  it("records plan, status and period end from the event", async () => {
    await seedAccount();

    await processStripeEvent(subscriptionEvent());

    const sub = await fake.client.subscription.findUnique({ where: { userId: "u1" } });
    expect(sub.status).toBe("active");
    expect(sub.plan).toBe("profit_intelligence");
    expect(sub.stripeSubscriptionId).toBe("sub_abc");
    expect(sub.currentPeriodEnd).toBeInstanceOf(Date);
  });

  /**
   * Stripe moved current_period_end off the Subscription and onto each
   * subscription ITEM in the 2025 API versions, and no longer offers
   * 2024-06-20 to new accounts, so this is the shape production actually
   * receives.
   *
   * Getting it wrong is fatal rather than cosmetic: the old read yields
   * undefined, `new Date(undefined * 1000)` is an Invalid Date, Prisma rejects
   * it, the handler throws, and a customer who has just paid never gets their
   * account flipped to active. The assertion checks a real date came through,
   * not merely that the field is a Date, because an Invalid Date is also a
   * Date instance.
   */
  it("reads period end from the subscription item on newer API versions", async () => {
    await seedAccount();
    const itemPeriodEnd = Math.floor(Date.now() / 1000) + 2_592_000;

    await processStripeEvent(
      subscriptionEvent({
        // No top-level current_period_end - exactly what a 2025+ payload sends.
        current_period_end: undefined,
        items: { data: [{ price: { id: "price_149" }, current_period_end: itemPeriodEnd }] },
      })
    );

    const sub = await fake.client.subscription.findUnique({ where: { userId: "u1" } });
    expect(sub.status).toBe("active");
    expect(sub.currentPeriodEnd).toBeInstanceOf(Date);
    expect(Number.isNaN(sub.currentPeriodEnd.getTime())).toBe(false);
    expect(sub.currentPeriodEnd.getTime()).toBe(itemPeriodEnd * 1000);
  });

  it("upgrades the stored plan when the price changes", async () => {
    await seedAccount({ status: "active", plan: "profit_intelligence" });

    await processStripeEvent(
      subscriptionEvent({ items: { data: [{ price: { id: "price_299" } }] } })
    );

    const sub = await fake.client.subscription.findUnique({ where: { userId: "u1" } });
    expect(sub.plan).toBe("profit_intelligence_pro");
  });

  /**
   * A price nobody configured must not confer entitlements. The handler
   * leaves the plan alone rather than guessing at one.
   */
  it("leaves the plan untouched for an unrecognized price", async () => {
    await seedAccount({ status: "active", plan: "profit_intelligence" });

    await processStripeEvent(
      subscriptionEvent({ items: { data: [{ price: { id: "price_made_up" } }] } })
    );

    const sub = await fake.client.subscription.findUnique({ where: { userId: "u1" } });
    expect(sub.plan).toBe("profit_intelligence");
    expect(sub.status).toBe("active");
  });

  it("marks the subscription canceled on deletion", async () => {
    await seedAccount({ status: "active" });

    await processStripeEvent({
      id: "evt_del_1",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_abc",
          customer: "cus_1",
          ended_at: Math.floor(Date.now() / 1000),
          metadata: { jobprofitaiUserId: "u1" },
        },
      },
    } as never);

    const sub = await fake.client.subscription.findUnique({ where: { userId: "u1" } });
    expect(sub.status).toBe("canceled");
    expect(sub.canceledAt).toBeInstanceOf(Date);
    expect(calls.emails).toContain("subscription_canceled");
  });
});

describe("ignored and unmatched events", () => {
  it("ignores event types it doesn't handle, without claiming them", async () => {
    const result = await processStripeEvent({
      id: "evt_other",
      type: "customer.updated",
      data: { object: {} },
    } as never);

    expect(result.handled).toBe(false);
    expect(await fake.client.stripeEvent.count()).toBe(0);
  });

  it("ignores an event for a customer that doesn't map to an account", async () => {
    const result = await processStripeEvent(
      subscriptionEvent({ customer: "cus_unknown", metadata: {} })
    );

    expect(result.handled).toBe(true);
    expect(result.detail).toMatch(/No matching account/);
  });
});

describe("refunds", () => {
  it("voids commission and disqualifies the referral", async () => {
    await seedAccount({ status: "active" });

    await processStripeEvent({
      id: "evt_refund_1",
      type: "charge.refunded",
      data: { object: { id: "ch_1", invoice: "in_1", customer: "cus_1" } },
    } as never);

    expect(calls.voided).toEqual(["in_1"]);
    expect(calls.disqualified).toEqual(["u1"]);
  });
});
