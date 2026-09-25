import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

const fake: { client: FakePrisma } = { client: createFakePrisma() };
const state = { companyInfoFails: false, revoked: 0, entitlements: { active: true, trialing: false } as any };

vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));
vi.mock("@/lib/quickbooks", () => ({
  qboCompanyInfo: async () => {
    if (state.companyInfoFails) throw new Error("QuickBooks API request failed with status 403");
    return { CompanyInfo: { CompanyName: "Smith Roofing" } };
  },
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
  canConnectAnotherCompany: async () => ({ allowed: true }),
}));
vi.mock("@/lib/trial", () => ({ tryMarkQuickBooksConnected: async () => {} }));
vi.mock("@/lib/email/client", () => ({ sendEmail: async () => ({ ok: true }) }));
vi.mock("@/lib/email/templates", () => ({ connectAttemptBlockedEmail: () => ({ subject: "s", html: "h", text: "t" }) }));

import { attachCompany } from "../connectCompany";

const tokens = { access_token: "at", refresh_token: "rt", expires_in: 3600, x_refresh_token_expires_in: 8_640_000 };

beforeEach(() => {
  fake.client = createFakePrisma();
  state.companyInfoFails = false;
  state.revoked = 0;
  state.entitlements = { active: true, trialing: false };
});

async function seedUsers() {
  await fake.client.user.create({ data: { id: "a", email: "a@example.com" } });
  await fake.client.user.create({ data: { id: "b", email: "b@example.com" } });
}

describe("attachCompany", () => {
  it("refuses a company id the new tokens can't read (a swapped id in the callback)", async () => {
    await seedUsers();
    state.companyInfoFails = true;
    const result = await attachCompany({ ownerId: "b", realmId: "123", tokens });
    expect(result).toMatchObject({ ok: false, code: "verify_failed" });
    expect(await fake.client.quickBooksConnection.count()).toBe(0);
  });

  it("refuses a company id that isn't a QuickBooks id at all", async () => {
    await seedUsers();
    expect(await attachCompany({ ownerId: "b", realmId: "../x", tokens })).toMatchObject({ ok: false, code: "verify_failed" });
  });

  it("gives a company changing hands a clean start and leaves the old history with its old account", async () => {
    await seedUsers();
    await fake.client.quickBooksConnection.create({
      data: { id: "old", userId: "a", realmIdHash: "h2:123", disconnectedAt: new Date(), companyName: "Smith Roofing" },
    });
    const result = await attachCompany({ ownerId: "b", realmId: "123", tokens });
    expect(result.ok).toBe(true);
    const old = await fake.client.quickBooksConnection.findUnique({ where: { id: "old" } });
    expect(old).toMatchObject({ userId: "a", realmIdHash: "moved:h2:123:old" });
    const fresh = await fake.client.quickBooksConnection.findFirst({ where: { realmIdHash: "h2:123" } });
    expect(fresh?.userId).toBe("b");
    expect(fresh?.id).not.toBe("old");
  });

  it("brings an account's own set-aside history back when it reconnects the company", async () => {
    await seedUsers();
    await fake.client.quickBooksConnection.create({
      data: { id: "mine", userId: "a", realmIdHash: "moved:h2:123:mine", disconnectedAt: new Date() },
    });
    const result = await attachCompany({ ownerId: "a", realmId: "123", tokens });
    expect(result).toEqual({ ok: true, connectionId: "mine" });
    const row = await fake.client.quickBooksConnection.findUnique({ where: { id: "mine" } });
    expect(row).toMatchObject({ realmIdHash: "h2:123", disconnectedAt: null });
  });

  it("won't give a trial to a company another account has had", async () => {
    await seedUsers();
    state.entitlements = { active: true, trialing: true };
    await fake.client.quickBooksConnection.create({
      data: { id: "old", userId: "a", realmIdHash: "moved:h2:123:old", disconnectedAt: new Date() },
    });
    expect(await attachCompany({ ownerId: "b", realmId: "123", tokens })).toMatchObject({ ok: false, code: "trial_used" });
  });

  it("refuses a company that is live on another account without revoking its grant", async () => {
    await seedUsers();
    await fake.client.quickBooksConnection.create({ data: { id: "live", userId: "a", realmIdHash: "h2:123" } });
    expect(await attachCompany({ ownerId: "b", realmId: "123", tokens })).toMatchObject({ ok: false, code: "already_connected" });
    expect(state.revoked).toBe(0);
  });
});
