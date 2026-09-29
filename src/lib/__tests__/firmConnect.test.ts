import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

// Who may add a company to an account, and what a reconnect brings back.
// Mocks match connectCompany.test.ts.

const fake: { client: FakePrisma } = { client: createFakePrisma() };
const state = {
  revoked: 0,
  entitlements: { active: true, trialing: false, plan: "firm" } as any,
  permission: { allowed: true } as { allowed: boolean; reason?: string },
};

vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));
vi.mock("@/lib/quickbooks", () => ({
  qboCompanyInfo: async () => ({ CompanyInfo: { CompanyName: "Smith Roofing" } }),
  detectCostTrackingMode: async () => "projects",
  revokeToken: async () => {
    state.revoked++;
  },
}));
vi.mock("@/lib/crypto", () => ({
  encryptToken: (v: string) => `enc:${v}`,
  hashRealmId: (r: string) => `h2:${r}`,
  legacyHashRealmId: (r: string) => `legacy:${r}`,
}));
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: async () => state.entitlements,
  canConnectAnotherCompany: async () => state.permission,
}));
vi.mock("@/lib/trial", () => ({ tryMarkQuickBooksConnected: async () => {} }));
vi.mock("@/lib/email/client", () => ({ sendEmail: async () => ({ ok: true }) }));
vi.mock("@/lib/email/templates", () => ({ connectAttemptBlockedEmail: () => ({ subject: "s", html: "h", text: "t" }) }));

import { attachCompany, connectNeedsOwner } from "../connectCompany";
import { REMOVED_ROLE } from "../teamRemoval";

const tokens = { access_token: "at", refresh_token: "rt", expires_in: 3600, x_refresh_token_expires_in: 8_640_000 };
const DAY = 86_400_000;

beforeEach(async () => {
  fake.client = createFakePrisma();
  state.revoked = 0;
  state.entitlements = { active: true, trialing: false, plan: "firm" };
  state.permission = { allowed: true };
  await fake.client.user.create({ data: { id: "firm", email: "books@firm.com" } });
});

describe("connecting a company on the Firm plan", () => {
  it("is owner-only on a paid Firm plan, since each company is billed", () => {
    expect(connectNeedsOwner({ active: true, trialing: false, plan: "firm" })).toBe(true);
    // The trial isn't billed per company, and other plans aren't at all.
    expect(connectNeedsOwner({ active: true, trialing: true, plan: "firm" })).toBe(false);
    expect(connectNeedsOwner({ active: true, trialing: false, plan: "profit_intelligence_pro" })).toBe(false);
    expect(connectNeedsOwner({ active: false, trialing: false, plan: "firm" })).toBe(false);
  });

  it("refuses a team member adding a new company, and gives the grant back", async () => {
    const r = await attachCompany({ ownerId: "firm", realmId: "123", tokens, actorRole: "member" });
    expect(r).toMatchObject({ ok: false, code: "owner_only" });
    expect(await fake.client.quickBooksConnection.count()).toBe(0);
    expect(state.revoked).toBe(1);
  });

  it("lets the owner add one, and a member reconnect one already on the account", async () => {
    expect((await attachCompany({ ownerId: "firm", realmId: "123", tokens, actorRole: "owner" })).ok).toBe(true);
    // Same company again (a reconnect after Intuit revoked the grant): no change to the bill.
    expect((await attachCompany({ ownerId: "firm", realmId: "123", tokens, actorRole: "member" })).ok).toBe(true);
  });

  it("refuses a member bringing back a company the account disconnected, which adds to the bill", async () => {
    await fake.client.quickBooksConnection.create({ data: { id: "c1", userId: "firm", realmIdHash: "h2:123", disconnectedAt: new Date() } });
    expect(await attachCompany({ ownerId: "firm", realmId: "123", tokens, actorRole: "member" })).toMatchObject({ code: "owner_only" });
  });

  it("leaves members free to connect on other plans and during the trial", async () => {
    state.entitlements = { active: true, trialing: false, plan: "profit_intelligence_pro" };
    expect((await attachCompany({ ownerId: "firm", realmId: "123", tokens, actorRole: "member" })).ok).toBe(true);
    state.entitlements = { active: true, trialing: true, plan: "firm" };
    expect((await attachCompany({ ownerId: "firm", realmId: "456", tokens, actorRole: "member" })).ok).toBe(true);
  });
});

describe("reconnecting a disconnected company", () => {
  it("doesn't give its old client logins their access back", async () => {
    await fake.client.quickBooksConnection.create({ data: { id: "c1", userId: "firm", realmIdHash: "h2:123", disconnectedAt: new Date() } });
    await fake.client.user.create({ data: { id: "acme", email: "owner@acme.com" } });
    await fake.client.teamMember.create({
      data: {
        id: "t1",
        ownerUserId: "firm",
        email: "owner@acme.com",
        memberUserId: "acme",
        tokenHash: "h1",
        expiresAt: new Date(Date.now() + DAY),
        acceptedAt: new Date(),
        role: "client",
        connectionId: "c1",
      },
    });
    await fake.client.teamMember.create({
      data: { id: "t2", ownerUserId: "firm", email: "pm@acme.com", tokenHash: "h2", expiresAt: new Date(Date.now() + DAY), role: "client", connectionId: "c1" },
    });

    const r = await attachCompany({ ownerId: "firm", realmId: "123", tokens, actorRole: "owner" });
    expect(r).toEqual({ ok: true, connectionId: "c1" });
    expect(await fake.client.teamMember.findUnique({ where: { id: "t1" } })).toMatchObject({
      role: REMOVED_ROLE,
      acceptedAt: null,
      connectionId: null,
    });
    // The pending invitation for it is cancelled.
    expect(await fake.client.teamMember.findUnique({ where: { id: "t2" } })).toBeNull();
  });

  it("leaves client logins alone on a reconnect of a company that was never disconnected", async () => {
    await fake.client.quickBooksConnection.create({ data: { id: "c1", userId: "firm", realmIdHash: "h2:123" } });
    await fake.client.teamMember.create({
      data: { id: "t1", ownerUserId: "firm", email: "owner@acme.com", memberUserId: "acme", tokenHash: "h1", expiresAt: new Date(), acceptedAt: new Date(), role: "client", connectionId: "c1" },
    });
    expect((await attachCompany({ ownerId: "firm", realmId: "123", tokens, actorRole: "owner" })).ok).toBe(true);
    expect(await fake.client.teamMember.findUnique({ where: { id: "t1" } })).toMatchObject({ role: "client", connectionId: "c1" });
  });
});

describe("reconnecting a company and choosing a different one", () => {
  async function live() {
    return (await fake.client.quickBooksConnection.findMany({ where: { userId: "firm", disconnectedAt: null } }))
      .map((c: any) => c.realmIdHash)
      .sort();
  }

  it("replaces it once; a second tab choosing another new company is checked like any new company", async () => {
    await fake.client.quickBooksConnection.create({ data: { id: "c1", userId: "firm", realmIdHash: "h2:111" } });
    // Tab one: the member reconnects c1 and picks company 222. The count stays the same.
    const first = await attachCompany({ ownerId: "firm", realmId: "222", tokens, reconnectId: "c1", actorRole: "member" });
    expect(first.ok).toBe(true);
    expect(await live()).toEqual(["h2:222"]);
    // Tab two, same reconnect link, picks company 333: that would add a billed company.
    const second = await attachCompany({ ownerId: "firm", realmId: "333", tokens, reconnectId: "c1", actorRole: "member" });
    expect(second).toMatchObject({ ok: false, code: "owner_only" });
    expect(await live()).toEqual(["h2:222"]);
    expect(state.revoked).toBe(1);
  });

  it("runs the plan limit on the second tab too", async () => {
    await fake.client.quickBooksConnection.create({ data: { id: "c1", userId: "firm", realmIdHash: "h2:111" } });
    state.permission = { allowed: false, reason: "Your plan is full." };
    expect((await attachCompany({ ownerId: "firm", realmId: "222", tokens, reconnectId: "c1", actorRole: "owner" })).ok).toBe(true);
    expect(await attachCompany({ ownerId: "firm", realmId: "333", tokens, reconnectId: "c1", actorRole: "owner" })).toMatchObject({
      ok: false,
      code: "plan_limit",
      message: "Your plan is full.",
    });
    expect(await live()).toEqual(["h2:222"]);
  });

  it("still lets a member reconnect the same company as often as they like", async () => {
    await fake.client.quickBooksConnection.create({ data: { id: "c1", userId: "firm", realmIdHash: "h2:111" } });
    state.permission = { allowed: false };
    for (let i = 0; i < 2; i++) {
      expect(await attachCompany({ ownerId: "firm", realmId: "111", tokens, reconnectId: "c1", actorRole: "member" })).toEqual({
        ok: true,
        connectionId: "c1",
      });
    }
    expect(await live()).toEqual(["h2:111"]);
  });

  it("checks bringing back the reconnected company after another tab replaced it", async () => {
    await fake.client.quickBooksConnection.create({ data: { id: "c1", userId: "firm", realmIdHash: "h2:111" } });
    expect((await attachCompany({ ownerId: "firm", realmId: "222", tokens, reconnectId: "c1", actorRole: "member" })).ok).toBe(true);
    // The other tab picks the original company after all; it's disconnected now, so it would add one.
    expect(await attachCompany({ ownerId: "firm", realmId: "111", tokens, reconnectId: "c1", actorRole: "member" })).toMatchObject({
      code: "owner_only",
    });
    expect(await live()).toEqual(["h2:222"]);
  });

  it("puts the old company back if saving the new one fails", async () => {
    await fake.client.quickBooksConnection.create({ data: { id: "c1", userId: "firm", realmIdHash: "h2:111" } });
    const model = fake.client.quickBooksConnection as any;
    const create = model.create.bind(model);
    model.create = async () => {
      throw new Error("database unavailable");
    };
    const failed = await attachCompany({ ownerId: "firm", realmId: "222", tokens, reconnectId: "c1", actorRole: "member" }).catch(
      (e: Error) => e.message
    );
    expect(failed).toBe("database unavailable");
    model.create = create;
    expect(await live()).toEqual(["h2:111"]);
  });
});
