import { describe, it, expect, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));
vi.mock("@/lib/auth", () => ({
  getSession: async () => null,
  hashPassword: async (p: string) => `hashed:${p}`,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
}));

import { accountFor, canSeeConnection, connectionForAccount, listCompanies, refuseClient, type AccountContext } from "../account";
import { createInvite } from "../team";
import { firmQuantityChange, isBillableCompany } from "../stripe/firmQuantity";
import { acceptInvite, findUsableInvite } from "../team";
import { monthlyPriceCents } from "../plans";
import { getEntitlements } from "../entitlements";
import { RECONNECT_REQUIRED_MESSAGE } from "../quickbooks";
import { portfolioRow, portfolioTotals, sortPortfolio } from "../portfolio";

const DAY = 86_400_000;
const NOW = new Date("2026-09-27T12:00:00Z");

async function seedFirm(plan = "firm", status = "active") {
  await fake.client.user.create({ data: { id: "firm", email: "books@firm.com", name: "Pat Books", emailVerifiedAt: new Date() } });
  await fake.client.subscription.create({
    data: { userId: "firm", plan, status, trialEndsAt: new Date(Date.now() + 10 * DAY), stripeSubscriptionId: status === "active" ? "sub_1" : null },
  });
  await fake.client.quickBooksConnection.create({ data: { id: "c1", userId: "firm", companyName: "Acme Roofing", realmIdHash: "r1" } });
  await fake.client.quickBooksConnection.create({ data: { id: "c2", userId: "firm", companyName: "Best Builders", realmIdHash: "r2" } });
}

async function seedLogin(id: string, role: "member" | "client", connectionId: string | null = null) {
  await fake.client.user.create({ data: { id, email: `${id}@example.com`, emailVerifiedAt: new Date() } });
  await fake.client.teamMember.create({
    data: {
      ownerUserId: "firm",
      email: `${id}@example.com`,
      memberUserId: id,
      tokenHash: `hash-${id}`,
      expiresAt: new Date(Date.now() + DAY),
      acceptedAt: new Date(),
      role,
      connectionId,
    },
  });
}

beforeEach(() => {
  fake.client = createFakePrisma();
});

describe("client logins see one company and change nothing", () => {
  it("resolves a client login to its one company on a Firm account", async () => {
    await seedFirm();
    await seedLogin("contractor", "client", "c1");
    await seedLogin("staff", "member");
    expect(await accountFor("firm")).toEqual({ userId: "firm", ownerId: "firm", role: "owner", connectionId: null });
    expect(await accountFor("staff")).toEqual({ userId: "staff", ownerId: "firm", role: "member", connectionId: null });
    expect(await accountFor("contractor")).toEqual({ userId: "contractor", ownerId: "firm", role: "client", connectionId: "c1" });
  });

  it("shows a client nothing once the account isn't on a plan with client logins", async () => {
    await seedFirm("profit_intelligence_pro");
    await seedLogin("contractor", "client", "c1");
    const client = await accountFor("contractor");
    expect(client.connectionId).toBe("");
    expect(await listCompanies(client)).toEqual([]);
  });

  it("never lets a client see or reach another company on the account", async () => {
    await seedFirm();
    await seedLogin("contractor", "client", "c1");
    await seedLogin("staff", "member");
    const client = await accountFor("contractor");
    const staff = await accountFor("staff");
    expect((await listCompanies(client)).map((c) => c.id)).toEqual(["c1"]);
    expect((await listCompanies(staff)).map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    expect(await connectionForAccount(client, "c2")).toBeNull();
    expect((await connectionForAccount(client, "c1"))?.id).toBe("c1");
    expect(canSeeConnection(client, { id: "c2", userId: "firm" })).toBe(false);
    expect(canSeeConnection(client, { id: "c1", userId: "someone-else" })).toBe(false);
  });

  it("refuses every change from a client and nobody else", () => {
    const client: AccountContext = { userId: "u", ownerId: "firm", role: "client", connectionId: "c1" };
    const member: AccountContext = { userId: "m", ownerId: "firm", role: "member", connectionId: null };
    expect((refuseClient(client) as unknown as { status: number }).status).toBe(403);
    expect(refuseClient(member)).toBeNull();
  });
});

describe("inviting client logins", () => {
  it("are on the trial, so a firm can try them", async () => {
    await seedFirm("profit_intelligence", "trialing");
    expect((await getEntitlements("firm")).has("client_logins")).toBe(true);
  });

  it("can't be used once the company has moved to another account, or the plan no longer has them", async () => {
    await seedFirm();
    const r = await createInvite("firm", "owner@acme.com", NOW, { clientConnectionId: "c1" });
    if (!r.ok) throw new Error(r.error);
    expect((await findUsableInvite(r.token))?.role).toBe("client");
    await fake.client.subscription.update({ where: { userId: "firm" }, data: { plan: "profit_intelligence_pro" } });
    await fake.client.user.create({ data: { id: "acme", email: "owner@acme.com", emailVerifiedAt: new Date() } });
    expect(await acceptInvite(r.token, "acme")).toMatchObject({ ok: false, status: 409 });
    await fake.client.quickBooksConnection.update({ where: { id: "c1" }, data: { userId: "someone-else" } });
    expect(await findUsableInvite(r.token)).toBeNull();
  });

  it("needs the Firm plan", async () => {
    await seedFirm("profit_intelligence_pro");
    const r = await createInvite("firm", "owner@acme.com", NOW, { clientConnectionId: "c1" });
    expect(r).toMatchObject({ ok: false, status: 402 });
  });

  it("creates a view-only invitation for one of the firm's own companies", async () => {
    await seedFirm();
    await fake.client.quickBooksConnection.create({ data: { id: "other", userId: "someone-else", realmIdHash: "r9" } });
    expect(await createInvite("firm", "x@acme.com", NOW, { clientConnectionId: "other" })).toMatchObject({ ok: false, status: 404 });
    const r = await createInvite("firm", "Owner@Acme.com", NOW, { clientConnectionId: "c1" });
    expect(r.ok).toBe(true);
    const row = await fake.client.teamMember.findFirst({ where: { email: "owner@acme.com" } });
    expect(row).toMatchObject({ role: "client", connectionId: "c1" });
  });

  it("limits client logins per company, separately from team logins", async () => {
    await seedFirm();
    for (const n of [1, 2, 3]) expect((await createInvite("firm", `c${n}@acme.com`, NOW, { clientConnectionId: "c1" })).ok).toBe(true);
    expect(await createInvite("firm", "c4@acme.com", NOW, { clientConnectionId: "c1" })).toMatchObject({ ok: false, status: 402 });
    // Another company has its own three, and staff invitations are unaffected.
    expect((await createInvite("firm", "b1@best.com", NOW, { clientConnectionId: "c2" })).ok).toBe(true);
    expect((await createInvite("firm", "staff@firm.com", NOW)).ok).toBe(true);
  });
});

describe("Firm billing quantity", () => {
  it("stops billing a company a week after its QuickBooks access was revoked", () => {
    const connectedAt = new Date(NOW.getTime() - 90 * DAY);
    const base = { disconnectedAt: null, connectedAt };
    expect(isBillableCompany({ ...base, lastSyncError: null, lastSyncedAt: new Date(NOW.getTime() - 30 * DAY) }, NOW)).toBe(true);
    expect(isBillableCompany({ ...base, lastSyncError: RECONNECT_REQUIRED_MESSAGE, lastSyncedAt: new Date(NOW.getTime() - 3 * DAY) }, NOW)).toBe(true);
    expect(isBillableCompany({ ...base, lastSyncError: RECONNECT_REQUIRED_MESSAGE, lastSyncedAt: new Date(NOW.getTime() - 8 * DAY) }, NOW)).toBe(false);
    expect(isBillableCompany({ ...base, lastSyncError: "QuickBooks was slow", lastSyncedAt: new Date(NOW.getTime() - 20 * DAY) }, NOW)).toBe(true);
    expect(isBillableCompany({ ...base, disconnectedAt: NOW, lastSyncError: null, lastSyncedAt: null }, NOW)).toBe(false);
  });

  it("prices a Firm month by the companies billed, and the minimum when not known", () => {
    expect(monthlyPriceCents("firm", 10)).toBe(79_000);
    expect(monthlyPriceCents("firm", null)).toBe(31_600);
    expect(monthlyPriceCents("profit_intelligence_pro", 1)).toBe(29_900);
  });

  it("follows the connected companies, four at least", () => {
    expect(firmQuantityChange(4, 2)).toBeNull();
    expect(firmQuantityChange(4, 5)).toBe(5);
    expect(firmQuantityChange(7, 6)).toBe(6);
    expect(firmQuantityChange(null, 1)).toBe(4);
    expect(firmQuantityChange(6, 6)).toBeNull();
  });
});

describe("portfolio", () => {
  const base = {
    lastSyncedAt: new Date(NOW.getTime() - DAY),
    syncError: null,
    openJobs: 5,
    laborBurden: 0.25,
    unpaid: 0,
    unpaidOver60: 0,
    untaggedJobCost: 0,
    now: NOW,
  };

  it("works out margin with labor burden and flags what needs attention", () => {
    const r = portfolioRow({ ...base, connectionId: "c1", companyName: "Acme", revenue: 100_000, otherCost: 50_000, timeLabor: 20_000, targetPct: 30, unpaidOver60: 4_000, untaggedJobCost: 5_000 });
    expect(r.cost).toBe(75_000);
    expect(r.margin).toBeCloseTo(0.25);
    expect(r.belowTarget).toBe(true);
    expect(r.flags).toEqual(["Margin below target", "Invoices unpaid over 60 days", "Job costs not on any job"]);
    const ok = portfolioRow({ ...base, connectionId: "c2", companyName: "Best", revenue: 100_000, otherCost: 50_000, timeLabor: 0, targetPct: 30 });
    expect(ok.flags).toEqual([]);
    const stale = portfolioRow({ ...base, connectionId: "c3", companyName: "Cole", revenue: 0, otherCost: 0, timeLabor: 0, targetPct: null, lastSyncedAt: new Date(NOW.getTime() - 5 * DAY) });
    expect(stale.margin).toBeNull();
    expect(stale.flags).toEqual(["Not synced in over 3 days"]);
    expect(sortPortfolio([ok, stale, r]).map((x) => x.connectionId)).toEqual(["c1", "c3", "c2"]);
    const t = portfolioTotals([r, ok]);
    expect(t.revenue).toBe(200_000);
    expect(t.margin).toBeCloseTo(1 - 125_000 / 200_000);
  });
});

describe("every route that changes data refuses client logins", () => {
  // Routes allowed to take a POST from a client login, and why.
  const ALLOWED = new Map<string, string>([
    ["company/select", "only sets which of its companies is on screen, scoped by connectionForAccount"],
    ["feedback", "feedback to us, not a change to the account"],
  ]);
  const apiRoot = join(__dirname, "..", "..", "app", "api");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "route.ts") files.push(full);
    }
  };
  walk(apiRoot);

  it("finds the routes", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("guards each one", () => {
    const unguarded: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const route = file.slice(apiRoot.length + 1).replace(/[\\/]route\.ts$/, "").replace(/\\/g, "/");
      const mutates = /export async function (POST|PUT|PATCH|DELETE)\b/.test(src);
      const usesAccount = /\bgetAccount\(|\baccountFor\(/.test(src);
      if (!mutates || !usesAccount || ALLOWED.has(route)) continue;
      const guarded = src.includes("refuseClient(") || src.includes('role !== "owner"');
      if (!guarded) unguarded.push(route);
    }
    expect(unguarded).toEqual([]);
  });
});
