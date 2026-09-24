import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));
vi.mock("@/lib/auth", () => ({
  hashPassword: async (p: string) => `hashed:${p}`,
}));

import { acceptInvite, createInvite, findUsableInvite, MAX_INVITE_EMAILS_PER_HOUR, recordInviteEmail } from "../team";
import { hashToken } from "../passwordReset";

const DAY = 86_400_000;

async function seedOwner(opts: { plan?: string; status?: string } = {}) {
  await fake.client.user.create({
    data: { id: "owner", email: "owner@example.com", name: "Sam Builder", emailVerifiedAt: new Date() },
  });
  await fake.client.subscription.create({
    data: {
      userId: "owner",
      status: opts.status ?? "trialing",
      plan: opts.plan ?? "profit_intelligence",
      trialEndsAt: new Date(Date.now() + 10 * DAY),
    },
  });
}

async function seedUser(id: string, email: string, extra: Record<string, unknown> = {}) {
  return fake.client.user.create({ data: { id, email, emailVerifiedAt: null, ...extra } });
}

beforeEach(() => {
  fake.client = createFakePrisma();
});

describe("createInvite", () => {
  it("stores only a hash of the token and lowercases the address", async () => {
    await seedOwner();
    const result = await createInvite("owner", "  Office@Example.com ");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.email).toBe("office@example.com");
    const rows = await fake.client.teamMember.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashToken(result.token));
    expect(JSON.stringify(rows[0])).not.toContain(result.token);
  });

  it("refuses the owner's own address and bad addresses", async () => {
    await seedOwner();
    expect((await createInvite("owner", "OWNER@example.com")).ok).toBe(false);
    expect((await createInvite("owner", "not-an-email")).ok).toBe(false);
  });

  it("holds the plan's team size, counting pending invitations", async () => {
    await seedOwner({ status: "active", plan: "profit_intelligence" }); // 3 logins
    for (const n of [1, 2, 3]) expect((await createInvite("owner", `p${n}@example.com`)).ok).toBe(true);
    const fourth = await createInvite("owner", "p4@example.com");
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.status).toBe(402);
  });

  it("does not count expired invitations against the limit", async () => {
    await seedOwner({ status: "active", plan: "profit_intelligence" });
    for (const n of [1, 2, 3]) {
      await fake.client.teamMember.create({
        data: { ownerUserId: "owner", email: `old${n}@example.com`, tokenHash: `h${n}`, expiresAt: new Date(Date.now() - DAY) },
      });
    }
    expect((await createInvite("owner", "new@example.com")).ok).toBe(true);
  });

  it("re-sending an expired invitation still needs a free place", async () => {
    await seedOwner({ status: "active", plan: "profit_intelligence" });
    await fake.client.teamMember.create({
      data: { ownerUserId: "owner", email: "old@example.com", tokenHash: "h0", invitedAt: new Date(Date.now() - 8 * DAY), expiresAt: new Date(Date.now() - DAY) },
    });
    for (const n of [1, 2, 3]) expect((await createInvite("owner", `p${n}@example.com`)).ok).toBe(true);
    expect((await createInvite("owner", "old@example.com")).ok).toBe(false);
  });

  it("re-sends by replacing the token, but not within a few minutes", async () => {
    await seedOwner();
    const now = new Date();
    const first = await createInvite("owner", "pm@example.com", now);
    const tooSoon = await createInvite("owner", "pm@example.com", new Date(now.getTime() + 60_000));
    expect(tooSoon.ok).toBe(false);
    const later = await createInvite("owner", "pm@example.com", new Date(now.getTime() + 10 * 60_000));
    expect(later.ok).toBe(true);
    if (!first.ok || !later.ok) return;
    expect(await findUsableInvite(first.token, new Date(now.getTime() + 11 * 60_000))).toBeNull();
    expect(await findUsableInvite(later.token, new Date(now.getTime() + 11 * 60_000))).not.toBeNull();
    expect(await fake.client.teamMember.count()).toBe(1);
  });

  it("needs the owner's own address confirmed first", async () => {
    await seedOwner();
    await fake.client.user.update({ where: { id: "owner" }, data: { emailVerifiedAt: null } });
    const r = await createInvite("owner", "pm@example.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("caps invitation emails per hour, however they were sent", async () => {
    await seedOwner({ status: "active", plan: "profit_intelligence_pro" });
    for (let i = 0; i < MAX_INVITE_EMAILS_PER_HOUR; i++) await recordInviteEmail("owner", `inv${i}`, "x@example.com", true);
    const r = await createInvite("owner", "pm@example.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(429);
  });

  it("needs an active plan or trial", async () => {
    await seedOwner({ status: "canceled" });
    expect((await createInvite("owner", "pm@example.com")).ok).toBe(false);
  });
});

describe("acceptInvite", () => {
  async function invite(email = "pm@example.com") {
    await seedOwner();
    const r = await createInvite("owner", email);
    if (!r.ok) throw new Error(r.error);
    return r.token;
  }

  it("joins a login with the invited address and marks it verified", async () => {
    const token = await invite();
    await seedUser("pm", "PM@example.com");
    const result = await acceptInvite(token, "pm");
    expect(result).toEqual({ ok: true, ownerUserId: "owner" });
    const row = (await fake.client.teamMember.findMany())[0];
    expect(row.memberUserId).toBe("pm");
    expect(row.acceptedAt).toBeInstanceOf(Date);
    expect((await fake.client.user.findUnique({ where: { id: "pm" } }))?.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("works once", async () => {
    const token = await invite();
    await seedUser("pm", "pm@example.com");
    expect((await acceptInvite(token, "pm")).ok).toBe(true);
    expect((await acceptInvite(token, "pm")).ok).toBe(false);
  });

  it("refuses a login with a different address", async () => {
    const token = await invite();
    await seedUser("other", "someone-else@example.com");
    const result = await acceptInvite(token, "other");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("refuses an expired invitation", async () => {
    const token = await invite();
    await seedUser("pm", "pm@example.com");
    const result = await acceptInvite(token, "pm", new Date(Date.now() + 8 * DAY));
    expect(result.ok).toBe(false);
  });

  it("refuses a login that has its own QuickBooks company", async () => {
    const token = await invite();
    await seedUser("pm", "pm@example.com");
    await fake.client.quickBooksConnection.create({ data: { userId: "pm", realmIdHash: "r1" } });
    const result = await acceptInvite(token, "pm");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });

  it("refuses a login that pays for its own plan", async () => {
    const token = await invite();
    await seedUser("pm", "pm@example.com");
    await fake.client.subscription.create({ data: { userId: "pm", status: "active", stripeSubscriptionId: "sub_1" } });
    expect((await acceptInvite(token, "pm")).ok).toBe(false);
  });

  it("drops the login's own unpaid trial so it gets no trial emails", async () => {
    const token = await invite();
    await seedUser("pm", "pm@example.com");
    await fake.client.subscription.create({ data: { userId: "pm", status: "trialing" } });
    expect((await acceptInvite(token, "pm")).ok).toBe(true);
    expect(await fake.client.subscription.findUnique({ where: { userId: "pm" } })).toBeNull();
    expect(await fake.client.subscription.findUnique({ where: { userId: "owner" } })).not.toBeNull();
  });

  it("refuses a login that already belongs to another team", async () => {
    const token = await invite();
    await seedUser("pm", "pm@example.com");
    await seedUser("owner2", "owner2@example.com");
    await fake.client.teamMember.create({
      data: {
        ownerUserId: "owner2",
        email: "pm@example.com",
        tokenHash: "x",
        memberUserId: "pm",
        acceptedAt: new Date(),
        expiresAt: new Date(Date.now() + DAY),
      },
    });
    expect((await acceptInvite(token, "pm")).ok).toBe(false);
  });
});
