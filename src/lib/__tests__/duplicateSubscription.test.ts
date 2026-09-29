import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));

vi.mock("stripe", () => ({ default: class {} }));

// A small stand-in for Stripe that keeps state, so a retried event can be
// checked against what the first run already did (cancelled, refunded).
type Obj = Record<string, any>;
const stripeState = {
  subscriptions: new Map<string, Obj>(),
  invoices: new Map<string, Obj>(),
  charges: new Map<string, Obj>(),
  refunds: [] as Obj[],
  calls: [] as string[],
};
const copy = <T>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)));
const fakeStripe = {
  subscriptions: {
    retrieve: vi.fn(async (id: string) => copy(stripeState.subscriptions.get(id))),
    list: vi.fn(async ({ customer }: Obj) => ({
      data: Array.from(stripeState.subscriptions.values())
        .filter((s) => s.customer === customer)
        .map(copy),
    })),
    update: vi.fn(async (id: string, params: Obj) => {
      const s = stripeState.subscriptions.get(id)!;
      s.metadata = { ...s.metadata, ...(params.metadata ?? {}) };
      stripeState.calls.push(`update:${id}`);
      return copy(s);
    }),
    cancel: vi.fn(async (id: string, _params: Obj, opts: Obj) => {
      const s = stripeState.subscriptions.get(id)!;
      if (s.status === "canceled") throw new Error("already canceled");
      s.status = "canceled";
      stripeState.calls.push(`cancel:${id}:${opts?.idempotencyKey}`);
      return copy(s);
    }),
  },
  invoices: {
    retrieve: vi.fn(async (id: string) => copy(stripeState.invoices.get(id))),
    voidInvoice: vi.fn(async (id: string) => {
      stripeState.invoices.get(id)!.status = "void";
      stripeState.calls.push(`void:${id}`);
    }),
  },
  charges: { retrieve: vi.fn(async (id: string) => copy(stripeState.charges.get(id))) },
  refunds: {
    create: vi.fn(async (params: Obj, opts: Obj) => {
      const charge = stripeState.charges.get(params.charge)!;
      charge.refunded = true;
      charge.amount_refunded = charge.amount;
      stripeState.refunds.push({ ...params, idempotencyKey: opts?.idempotencyKey });
      stripeState.calls.push(`refund:${params.charge}`);
      return { id: `re_${stripeState.refunds.length}`, amount: charge.amount };
    }),
    list: vi.fn(async ({ charge }: Obj) => ({
      data: stripeState.refunds.filter((r) => r.charge === charge).map((r) => ({ metadata: r.metadata })),
    })),
  },
};

vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => fakeStripe,
  planForPriceId: (priceId: string | null) =>
    priceId === "price_149" ? "profit_intelligence" : priceId === "price_299" ? "profit_intelligence_pro" : null,
}));

vi.mock("@/lib/stripe/billing", () => ({
  priceIdFromSubscription: (sub: any) => sub.items?.data?.[0]?.price?.id ?? null,
  subscriptionRevenueCents: (invoice: any) => invoice.amount_paid ?? 0,
}));

const calls = { disqualified: [] as string[], emails: [] as string[] };
vi.mock("@/lib/referrals", () => ({
  applyPendingRewardsForUser: vi.fn(async () => 0),
  disqualifyReferral: vi.fn(async (userId: string) => {
    calls.disqualified.push(userId);
  }),
  markReferralPaid: vi.fn(async () => null),
}));

vi.mock("@/lib/partners", () => ({
  countPayingClients: vi.fn(async () => 0),
  recordCommissionForInvoice: vi.fn(async () => null),
  voidCommissionForInvoice: vi.fn(async () => false),
  flagPaidCommissionsForReview: vi.fn(async () => 0),
}));

vi.mock("@/lib/email/lifecycle", () => {
  const record = (name: string) =>
    vi.fn(async () => {
      calls.emails.push(name);
      return { ok: true };
    });
  return {
    sendPartnerCommissionEarned: record("partner_commission"),
    sendPartnerNewPayingClient: record("partner_new_paying"),
    sendPartnerTierUpgrade: record("partner_tier"),
    sendPaymentFailed: record("payment_failed"),
    sendReferralConverted: record("referral_converted"),
    sendSubscriptionCanceled: record("subscription_canceled"),
    sendSubscriptionConfirmed: record("subscription_confirmed"),
  };
});

// Admin notices go through the send-once helper; its dedupe is mirrored.
const adminEmails: { dedupeKey: string; to: string; subject: string; text: string }[] = [];
vi.mock("@/lib/email/client", () => ({
  SUPPORT_EMAIL: "support@jobprofitai.com",
  sendLifecycleEmail: vi.fn(async (input: any) => {
    if (adminEmails.some((e) => e.dedupeKey === input.dedupeKey)) return { ok: true, skipped: true };
    adminEmails.push({ dedupeKey: input.dedupeKey, to: input.to, subject: input.subject, text: input.text });
    return { ok: true };
  }),
}));

vi.mock("@/lib/planLimits", () => ({ overLimitConnectionIds: vi.fn(async () => new Set<string>()) }));

import { processStripeEvent } from "../stripe/webhookHandlers";
import {
  ALREADY_SUBSCRIBED_MESSAGE,
  PAYMENT_BEING_CONFIRMED_MESSAGE,
  originalSubscriptionFor,
  secondCheckoutDecision,
} from "../stripe/duplicateSubscription";

const T0 = 1_790_000_000; // seconds

function stripeSub(id: string, created: number, price = "price_149", status = "active") {
  return {
    id,
    customer: "cus_1",
    status,
    created,
    current_period_end: created + 2_592_000,
    cancel_at_period_end: false,
    canceled_at: null,
    items: { data: [{ price: { id: price }, quantity: 1 }] },
    metadata: { jobprofitaiUserId: "u1" },
    latest_invoice: `in_${id}`,
  };
}

/** A paid subscription in Stripe, with its first invoice and charge. */
function seedStripeSub(id: string, created: number, price = "price_149", amount = 14_900) {
  stripeState.subscriptions.set(id, stripeSub(id, created, price));
  stripeState.invoices.set(`in_${id}`, { id: `in_${id}`, status: "paid", amount_paid: amount, charge: `ch_${id}`, payment_intent: `pi_${id}` });
  stripeState.charges.set(`ch_${id}`, { id: `ch_${id}`, amount, amount_refunded: 0, refunded: false, customer: "cus_1", invoice: `in_${id}` });
}

function checkoutCompleted(subscriptionId: string, eventId = `evt_co_${subscriptionId}`) {
  return {
    id: eventId,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_${subscriptionId}`,
        customer: "cus_1",
        subscription: subscriptionId,
        client_reference_id: "u1",
        metadata: { jobprofitaiUserId: "u1", plan: "profit_intelligence" },
      },
    },
  } as never;
}

async function seedAccount(onFile: Record<string, unknown>) {
  await fake.client.user.create({ data: { id: "u1", email: "owner@example.com" } });
  await fake.client.subscription.create({
    data: { userId: "u1", plan: "profit_intelligence", stripeCustomerId: "cus_1", ...onFile },
  });
}

beforeEach(() => {
  fake.client = createFakePrisma();
  stripeState.subscriptions.clear();
  stripeState.invoices.clear();
  stripeState.charges.clear();
  stripeState.refunds.length = 0;
  stripeState.calls.length = 0;
  calls.disqualified.length = 0;
  calls.emails.length = 0;
  adminEmails.length = 0;
  process.env.CONTACT_TO_EMAIL = "";
});

describe("which subscription is the duplicate", () => {
  const sub = (id: string, created: number, status = "active") => ({ id, created, status });

  it("keeps the oldest live subscription and marks the newer one", () => {
    expect(originalSubscriptionFor(sub("B", 200), [sub("A", 100), sub("B", 200)])?.id).toBe("A");
    // The older one's own event: it stands.
    expect(originalSubscriptionFor(sub("A", 100), [sub("A", 100), sub("B", 200)])).toBeNull();
  });

  it("ignores subscriptions that aren't live", () => {
    expect(originalSubscriptionFor(sub("B", 200), [sub("A", 100, "canceled")])).toBeNull();
    expect(originalSubscriptionFor(sub("B", 200), [sub("A", 100, "incomplete_expired")])).toBeNull();
    expect(originalSubscriptionFor(sub("B", 200), [sub("A", 100, "past_due")])?.id).toBe("A");
    expect(originalSubscriptionFor(sub("B", 200), [sub("A", 100, "trialing")])?.id).toBe("A");
  });

  it("breaks a same-second tie the same way from either side", () => {
    expect(originalSubscriptionFor(sub("sub_b", 100), [sub("sub_a", 100)])?.id).toBe("sub_a");
    expect(originalSubscriptionFor(sub("sub_a", 100), [sub("sub_b", 100)])).toBeNull();
  });
});

describe("refusing a second checkout before it starts", () => {
  const now = T0;

  it("refuses while any subscription is live", () => {
    const d = secondCheckoutDecision([{ id: "A", status: "active", created: now - 50 }], [], now);
    expect(d).toEqual({ block: true, message: ALREADY_SUBSCRIBED_MESSAGE });
  });

  it("refuses while a checkout paid in the last hour hasn't shown up yet", () => {
    const d = secondCheckoutDecision([], [{ id: "cs_1", status: "complete", created: now - 30, subscriptionId: "A" }], now);
    expect(d).toEqual({ block: true, message: PAYMENT_BEING_CONFIRMED_MESSAGE });
  });

  it("doesn't hold up a new checkout for a paid one whose subscription has since ended", () => {
    const d = secondCheckoutDecision(
      [{ id: "A", status: "canceled", created: now - 600 }],
      [{ id: "cs_1", status: "complete", created: now - 600, subscriptionId: "A" }],
      now
    );
    expect(d).toEqual({ block: false, expireSessionIds: [] });
  });

  it("closes checkouts still open from the last hour, so only the new one can be paid", () => {
    const d = secondCheckoutDecision(
      [],
      [
        { id: "cs_open", status: "open", created: now - 120, subscriptionId: null },
        { id: "cs_old", status: "open", created: now - 7200, subscriptionId: null },
        { id: "cs_gone", status: "expired", created: now - 60, subscriptionId: null },
      ],
      now
    );
    expect(d).toEqual({ block: false, expireSessionIds: ["cs_open"] });
  });
});

describe("a second paid checkout, in the webhook", () => {
  it("cancels the new subscription, refunds its first payment, keeps the original and tells the admin", async () => {
    await seedAccount({ status: "active", stripeSubscriptionId: "sub_A", stripePriceId: "price_149" });
    seedStripeSub("sub_A", T0);
    seedStripeSub("sub_B", T0 + 5, "price_299", 29_900);

    const result = await processStripeEvent(checkoutCompleted("sub_B"));

    expect(result.detail).toMatch(/Duplicate subscription sub_B cancelled/);
    expect(stripeState.subscriptions.get("sub_B")!.status).toBe("canceled");
    expect(stripeState.subscriptions.get("sub_B")!.metadata.jobprofitaiDuplicateOf).toBe("sub_A");
    expect(stripeState.subscriptions.get("sub_A")!.status).toBe("active");
    expect(stripeState.refunds).toHaveLength(1);
    expect(stripeState.refunds[0]).toMatchObject({
      charge: "ch_sub_B",
      idempotencyKey: "duplicate-refund:sub_B",
      metadata: { jobprofitaiDuplicateSubscription: "sub_B" },
    });

    const row = await fake.client.subscription.findUnique({ where: { userId: "u1" } });
    expect(row.stripeSubscriptionId).toBe("sub_A");
    expect(row.status).toBe("active");
    expect(row.plan).toBe("profit_intelligence");

    expect(adminEmails).toHaveLength(1);
    expect(adminEmails[0].to).toBe("support@jobprofitai.com");
    expect(adminEmails[0].subject).toMatch(/cancelled and refunded/);
    expect(adminEmails[0].text).toContain("owner@example.com");
    expect(adminEmails[0].text).toContain("sub_A");
    // No welcome for a subscription that was never kept.
    expect(calls.emails).not.toContain("subscription_confirmed");
  });

  it("does nothing twice when the event is processed again", async () => {
    await seedAccount({ status: "active", stripeSubscriptionId: "sub_A" });
    seedStripeSub("sub_A", T0);
    seedStripeSub("sub_B", T0 + 5);

    await processStripeEvent(checkoutCompleted("sub_B", "evt_first"));
    // A Stripe retry after a failure elsewhere arrives as a fresh delivery.
    await processStripeEvent(checkoutCompleted("sub_B", "evt_retry"));

    expect(stripeState.calls.filter((c) => c.startsWith("cancel:"))).toEqual(["cancel:sub_B:duplicate-cancel:sub_B"]);
    expect(stripeState.refunds).toHaveLength(1);
    expect(adminEmails).toHaveLength(1);
  });

  it("puts the original back on file when the duplicate's own events got there first", async () => {
    // The second subscription's "updated, active" event already replaced the first on file.
    await seedAccount({ status: "active", stripeSubscriptionId: "sub_B" });
    seedStripeSub("sub_A", T0);
    seedStripeSub("sub_B", T0 + 5);

    await processStripeEvent(checkoutCompleted("sub_B"));

    const row = await fake.client.subscription.findUnique({ where: { userId: "u1" } });
    expect(row.stripeSubscriptionId).toBe("sub_A");

    // Stripe then reports the duplicate deleted: access must not end.
    const deleted = {
      id: "evt_del_B",
      type: "customer.subscription.deleted",
      created: T0 + 100,
      data: { object: copy(stripeState.subscriptions.get("sub_B")) },
    } as never;
    await processStripeEvent(deleted);
    const after = await fake.client.subscription.findUnique({ where: { userId: "u1" } });
    expect(after.status).toBe("active");
    expect(after.stripeSubscriptionId).toBe("sub_A");
    expect(calls.emails).not.toContain("subscription_canceled");
  });

  it("leaves the original alone when its own checkout event arrives late", async () => {
    await seedAccount({ status: "trialing" });
    seedStripeSub("sub_A", T0);
    seedStripeSub("sub_B", T0 + 5);

    // The later checkout's event first: the later subscription goes.
    await processStripeEvent(checkoutCompleted("sub_B"));
    // Then the earlier checkout's event: nothing more is cancelled.
    const result = await processStripeEvent(checkoutCompleted("sub_A"));

    expect(result.detail).toMatch(/Checkout completed/);
    expect(stripeState.subscriptions.get("sub_A")!.status).toBe("active");
    expect(stripeState.calls.filter((c) => c.startsWith("cancel:"))).toHaveLength(1);
    const row = await fake.client.subscription.findUnique({ where: { userId: "u1" } });
    expect(row.stripeSubscriptionId).toBe("sub_A");
  });

  it("is an ordinary checkout when there's no other live subscription", async () => {
    await seedAccount({ status: "trialing" });
    stripeState.subscriptions.set("sub_old", { ...stripeSub("sub_old", T0 - 9_000_000), status: "canceled" });
    seedStripeSub("sub_A", T0);

    await processStripeEvent(checkoutCompleted("sub_A"));

    expect(stripeState.calls).toEqual([]);
    expect(adminEmails).toHaveLength(0);
    const row = await fake.client.subscription.findUnique({ where: { userId: "u1" } });
    expect(row.stripeSubscriptionId).toBe("sub_A");
    expect(row.status).toBe("active");
  });

  it("doesn't end the customer's referral over the duplicate's refund", async () => {
    await seedAccount({ status: "active", stripeSubscriptionId: "sub_A" });
    seedStripeSub("sub_A", T0);
    seedStripeSub("sub_B", T0 + 5);
    await processStripeEvent(checkoutCompleted("sub_B"));

    const refunded = {
      id: "evt_refund_B",
      type: "charge.refunded",
      data: { object: copy(stripeState.charges.get("ch_sub_B")) },
    } as never;
    await processStripeEvent(refunded);
    expect(calls.disqualified).toEqual([]);

    // A refund of the kept subscription's payment still does.
    stripeState.charges.get("ch_sub_A")!.refunded = true;
    await processStripeEvent({
      id: "evt_refund_A",
      type: "charge.refunded",
      data: { object: copy(stripeState.charges.get("ch_sub_A")) },
    } as never);
    expect(calls.disqualified).toEqual(["u1"]);
  });
});
