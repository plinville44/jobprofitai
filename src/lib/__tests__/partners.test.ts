import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));

// partners.ts uses subscriptionRevenueCents from the billing module, and
// referralUrl/getOrCreatePartnerReferralCode from referrals. Only the Stripe
// side needs standing in for - the revenue calculation itself is the real
// implementation, re-declared here so these tests exercise it rather than a
// simplification of it.
vi.mock("@/lib/stripe/billing", () => ({
  subscriptionRevenueCents: (invoice: any) => {
    const lineTotal = invoice.lines.data
      .filter((l: any) => l.type === "subscription" || l.price?.type === "recurring")
      .reduce((sum: number, l: any) => sum + (l.amount ?? 0), 0);
    return Math.max(0, Math.min(lineTotal, invoice.amount_paid ?? 0));
  },
}));

import {
  approvePartner,
  countPayingClients,
  currentPartnerTier,
  getPartnerCommissionHistory,
  recordCommissionForInvoice,
  voidCommissionForInvoice,
} from "../partners";

const NOW = new Date("2026-07-01T10:00:00Z");

/** A Stripe invoice shaped the way the webhook handler receives one. */
function invoice({
  id,
  amountCents = 14_900,
  taxCents = 0,
  amountPaid,
}: {
  id: string;
  amountCents?: number;
  taxCents?: number;
  amountPaid?: number;
}) {
  return {
    id,
    // Line amounts are pre-tax by definition; the tax sits outside them.
    lines: { data: [{ type: "subscription", amount: amountCents, price: { type: "recurring" } }] },
    amount_paid: amountPaid ?? amountCents + taxCents,
    subscription: "sub_123",
    customer: "cus_123",
  } as never;
}

async function seedPartnerWithClients(payingClients: number) {
  await fake.client.user.create({ data: { id: "firm", email: "firm@example.com" } });
  const partner = await fake.client.partner.create({
    data: { userId: "firm", firmName: "Ledger Co", contactName: "Sam", status: "approved" },
  });

  const referralIds: string[] = [];
  for (let i = 0; i < payingClients; i++) {
    const clientId = `client_${i}`;
    await fake.client.user.create({ data: { id: clientId, email: `${clientId}@example.com` } });
    await fake.client.subscription.create({
      data: { userId: clientId, status: "active", plan: "profit_intelligence" },
    });
    const referral = await fake.client.referral.create({
      data: {
        referralCodeId: "rc_1",
        kind: "partner",
        partnerId: partner.id,
        referredUserId: clientId,
        status: "paid",
      },
    });
    referralIds.push(referral.id);
  }

  return { partner, referralIds };
}

beforeEach(() => {
  fake.client = createFakePrisma();
});

describe("commission rate tiers", () => {
  it("pays 20% with a handful of clients", async () => {
    const { partner, referralIds } = await seedPartnerWithClients(3);

    const result = await recordCommissionForInvoice({
      invoice: invoice({ id: "in_1" }),
      referralId: referralIds[0],
      partnerId: partner.id,
      referredUserId: "client_0",
      paidAt: NOW,
    });

    expect(result?.rateBps).toBe(2000);
    expect(result?.commissionCents).toBe(2_980); // 20% of $149
  });

  it("pays 25% at ten or more paying clients", async () => {
    const { partner, referralIds } = await seedPartnerWithClients(12);
    expect(await countPayingClients(partner.id)).toBe(12);
    expect((await currentPartnerTier(partner.id)).ratePct).toBe(25);

    const result = await recordCommissionForInvoice({
      invoice: invoice({ id: "in_1" }),
      referralId: referralIds[0],
      partnerId: partner.id,
      referredUserId: "client_0",
      paidAt: NOW,
    });

    expect(result?.commissionCents).toBe(3_725); // $37.25
  });

  it("pays 30% at twenty-five or more paying clients", async () => {
    const { partner, referralIds } = await seedPartnerWithClients(26);

    const result = await recordCommissionForInvoice({
      invoice: invoice({ id: "in_pro", amountCents: 29_900 }),
      referralId: referralIds[0],
      partnerId: partner.id,
      referredUserId: "client_0",
      paidAt: NOW,
    });

    expect(result?.rateBps).toBe(3000);
    expect(result?.commissionCents).toBe(8_970); // 30% of $299
  });

  /**
   * The rate is frozen per commission. A partner crossing into a higher tier
   * must not retroactively re-price months already settled.
   */
  it("freezes the rate on commissions already earned when a tier changes", async () => {
    const { partner, referralIds } = await seedPartnerWithClients(3);

    await recordCommissionForInvoice({
      invoice: invoice({ id: "in_early" }),
      referralId: referralIds[0],
      partnerId: partner.id,
      referredUserId: "client_0",
      paidAt: NOW,
    });

    // The firm grows into the 25% tier.
    for (let i = 3; i < 12; i++) {
      const clientId = `later_${i}`;
      await fake.client.user.create({ data: { id: clientId, email: `${clientId}@example.com` } });
      await fake.client.subscription.create({
        data: { userId: clientId, status: "active", plan: "profit_intelligence" },
      });
      await fake.client.referral.create({
        data: {
          referralCodeId: "rc_1",
          kind: "partner",
          partnerId: partner.id,
          referredUserId: clientId,
          status: "paid",
        },
      });
    }

    const later = await recordCommissionForInvoice({
      invoice: invoice({ id: "in_later" }),
      referralId: referralIds[1],
      partnerId: partner.id,
      referredUserId: "client_1",
      paidAt: NOW,
    });

    expect(later?.rateBps).toBe(2500);
    const rows = await getPartnerCommissionHistory(partner.id);
    const early = rows.find((r) => r.commissionCents === 2_980);
    expect(early?.commissionRateBps).toBe(2000); // unchanged
  });
});

describe("what is and isn't commissionable", () => {
  it("excludes sales tax from the commission base", async () => {
    const { partner, referralIds } = await seedPartnerWithClients(3);

    const result = await recordCommissionForInvoice({
      invoice: invoice({ id: "in_tax", amountCents: 14_900, taxCents: 1_200 }),
      referralId: referralIds[0],
      partnerId: partner.id,
      referredUserId: "client_0",
      paidAt: NOW,
    });

    // 20% of $149, not of $161.
    expect(result?.commissionCents).toBe(2_980);
  });

  it("pays nothing when no money was actually collected", async () => {
    const { partner, referralIds } = await seedPartnerWithClients(3);

    const result = await recordCommissionForInvoice({
      invoice: invoice({ id: "in_credited", amountCents: 14_900, amountPaid: 0 }),
      referralId: referralIds[0],
      partnerId: partner.id,
      referredUserId: "client_0",
      paidAt: NOW,
    });

    expect(result).toBeNull();
    expect(await fake.client.partnerCommission.count()).toBe(0);
  });

  it("pays nothing for a partner who isn't approved", async () => {
    const { partner, referralIds } = await seedPartnerWithClients(3);
    await fake.client.partner.update({
      where: { id: partner.id },
      data: { status: "suspended" },
    });

    const result = await recordCommissionForInvoice({
      invoice: invoice({ id: "in_1" }),
      referralId: referralIds[0],
      partnerId: partner.id,
      referredUserId: "client_0",
      paidAt: NOW,
    });

    expect(result).toBeNull();
  });
});

describe("the 12-month commission window", () => {
  it("pays for twelve months then stops", async () => {
    const { partner, referralIds } = await seedPartnerWithClients(3);

    for (let month = 1; month <= 12; month++) {
      const result = await recordCommissionForInvoice({
        invoice: invoice({ id: `in_${month}` }),
        referralId: referralIds[0],
        partnerId: partner.id,
        referredUserId: "client_0",
        paidAt: NOW,
      });
      expect(result?.monthNumber).toBe(month);
    }

    const thirteenth = await recordCommissionForInvoice({
      invoice: invoice({ id: "in_13" }),
      referralId: referralIds[0],
      partnerId: partner.id,
      referredUserId: "client_0",
      paidAt: NOW,
    });

    expect(thirteenth).toBeNull();
    expect(await fake.client.partnerCommission.count()).toBe(12);
  });

  it("doesn't let a refunded month consume one of the twelve", async () => {
    const { partner, referralIds } = await seedPartnerWithClients(3);

    await recordCommissionForInvoice({
      invoice: invoice({ id: "in_1" }),
      referralId: referralIds[0],
      partnerId: partner.id,
      referredUserId: "client_0",
      paidAt: NOW,
    });
    await voidCommissionForInvoice("in_1", "Payment refunded", NOW);

    const next = await recordCommissionForInvoice({
      invoice: invoice({ id: "in_2" }),
      referralId: referralIds[0],
      partnerId: partner.id,
      referredUserId: "client_0",
      paidAt: NOW,
    });

    // Back to month 1 - the refunded month didn't count.
    expect(next?.monthNumber).toBe(1);
  });
});

describe("webhook retries", () => {
  /**
   * The single most important property in the commission system: Stripe
   * retries deliveries, and a retry must never pay a partner twice.
   */
  it("never creates a second commission for the same invoice", async () => {
    const { partner, referralIds } = await seedPartnerWithClients(3);
    const args = {
      invoice: invoice({ id: "in_retried" }),
      referralId: referralIds[0],
      partnerId: partner.id,
      referredUserId: "client_0",
      paidAt: NOW,
    };

    const first = await recordCommissionForInvoice(args);
    const second = await recordCommissionForInvoice(args);
    const third = await recordCommissionForInvoice(args);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(third).toBeNull();
    expect(await fake.client.partnerCommission.count()).toBe(1);
  });

  it("survives concurrent deliveries of the same invoice", async () => {
    const { partner, referralIds } = await seedPartnerWithClients(3);
    const args = {
      invoice: invoice({ id: "in_concurrent" }),
      referralId: referralIds[0],
      partnerId: partner.id,
      referredUserId: "client_0",
      paidAt: NOW,
    };

    const results = await Promise.all([
      recordCommissionForInvoice(args),
      recordCommissionForInvoice(args),
      recordCommissionForInvoice(args),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await fake.client.partnerCommission.count()).toBe(1);
  });
});

describe("refunds", () => {
  it("voids the commission for a refunded invoice", async () => {
    const { partner, referralIds } = await seedPartnerWithClients(3);
    await recordCommissionForInvoice({
      invoice: invoice({ id: "in_1" }),
      referralId: referralIds[0],
      partnerId: partner.id,
      referredUserId: "client_0",
      paidAt: NOW,
    });

    expect(await voidCommissionForInvoice("in_1", "Payment refunded", NOW)).toBe(true);

    const rows = await getPartnerCommissionHistory(partner.id);
    expect(rows[0].status).toBe("voided");
    // Voiding again is a no-op rather than an error.
    expect(await voidCommissionForInvoice("in_1", "Payment refunded", NOW)).toBe(false);
  });
});

describe("partner data isolation", () => {
  it("exposes no referred-client identity in the commission history", async () => {
    const { partner, referralIds } = await seedPartnerWithClients(3);
    await recordCommissionForInvoice({
      invoice: invoice({ id: "in_1" }),
      referralId: referralIds[0],
      partnerId: partner.id,
      referredUserId: "client_0",
      paidAt: NOW,
    });

    const rows = await getPartnerCommissionHistory(partner.id);
    const serialized = JSON.stringify(rows);

    expect(serialized).not.toContain("client_0");
    expect(serialized).not.toContain("@example.com");
    expect(rows[0]).not.toHaveProperty("referredUserId");
  });
});

describe("approval", () => {
  it("issues a referral code only on approval", async () => {
    await fake.client.user.create({ data: { id: "firm", email: "firm@example.com" } });
    const partner = await fake.client.partner.create({
      data: { userId: "firm", firmName: "Ledger Co", contactName: "Sam", status: "pending" },
    });

    expect(await fake.client.referralCode.count()).toBe(0);

    const { code, url } = await approvePartner(partner.id);

    expect(code).toMatch(/^[23456789BCDFGHJKMNPQRSTVWXYZ]{7}$/);
    expect(url).toContain(code);
    expect(
      (await fake.client.partner.findUnique({ where: { id: partner.id } })).status
    ).toBe("approved");
  });
});
