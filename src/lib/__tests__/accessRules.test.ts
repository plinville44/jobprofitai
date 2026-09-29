import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

// Removing team and client logins: access, email lists, and what the
// person sees afterwards. Also the company pickers and the sync strip.

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

import { accountFor, listCompanies } from "../account";
import { acceptInvite, createInvite, listTeam } from "../team";
import {
  removeClientLoginsForCompany,
  removedAccessFor,
  removeTeamLogin,
  REMOVED_ROLE,
  withoutAddresses,
} from "../teamRemoval";
import { defaultInviteCompanyId, filterCompanies, sortCompaniesByName } from "../companyPicker";
import { syncProblemFor } from "../syncProblem";
import { RECONNECT_REQUIRED_MESSAGE } from "../quickbooks";

const DAY = 86_400_000;

async function seedFirm() {
  await fake.client.user.create({ data: { id: "firm", email: "books@firm.com", name: "Pat Books", emailVerifiedAt: new Date() } });
  await fake.client.subscription.create({
    data: { userId: "firm", plan: "firm", status: "active", stripeSubscriptionId: "sub_1", trialEndsAt: new Date(Date.now() + 10 * DAY) },
  });
  await fake.client.quickBooksConnection.create({
    data: { id: "c1", userId: "firm", companyName: "Acme Roofing", realmIdHash: "r1", emailEnabled: true, emailRecipients: ["books@firm.com", "PM@Example.com "] },
  });
  await fake.client.quickBooksConnection.create({
    data: { id: "c2", userId: "firm", companyName: "Best Builders", realmIdHash: "r2", emailEnabled: true, emailRecipients: ["pm@example.com"] },
  });
  // Disconnected, so its list would come back on a reconnect.
  await fake.client.quickBooksConnection.create({
    data: { id: "c3", userId: "firm", companyName: "Cole Decks", realmIdHash: "r3", disconnectedAt: new Date(), emailEnabled: true, emailRecipients: ["pm@example.com", "books@firm.com"] },
  });
}

async function seedLogin(id: string, role: "member" | "client", connectionId: string | null = null) {
  await fake.client.user.create({ data: { id, email: `${id}@example.com`, emailVerifiedAt: new Date() } });
  return fake.client.teamMember.create({
    data: {
      id: `tm-${id}`,
      ownerUserId: "firm",
      email: `${id}@example.com`,
      memberUserId: id,
      tokenHash: `hash-${id}`,
      invitedAt: new Date(Date.now() - DAY),
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

describe("removing a team member", () => {
  it("ends their access and takes them off every company's email list", async () => {
    await seedFirm();
    await seedLogin("pm", "member");
    const r = await removeTeamLogin("firm", "tm-pm");
    expect(r).toEqual({ ok: true, memberUserId: "pm" });

    expect(await accountFor("pm")).toEqual({ userId: "pm", ownerId: "pm", role: "owner", connectionId: null });
    expect(await listCompanies(await accountFor("pm"))).toEqual([]);
    expect(await listTeam("firm")).toEqual([]);

    const lists = await fake.client.quickBooksConnection.findMany({ orderBy: { id: "asc" } });
    expect(lists.map((c: any) => [c.id, c.emailRecipients, c.emailEnabled])).toEqual([
      ["c1", ["books@firm.com"], true],
      // Nobody left to send to: the brief is switched off, as the unsubscribe link does.
      ["c2", [], false],
      ["c3", ["books@firm.com"], true],
    ]);
  });

  it("says plainly whose account they were removed from, until they have an account of their own", async () => {
    await seedFirm();
    await seedLogin("pm", "member");
    await removeTeamLogin("firm", "tm-pm");
    expect(await removedAccessFor("pm")).toEqual({ ownerName: "Pat Books", ownerEmail: "books@firm.com" });
    await fake.client.quickBooksConnection.create({ data: { id: "own", userId: "pm", realmIdHash: "r9" } });
    expect(await removedAccessFor("pm")).toBeNull();
    // A current member was never removed.
    await seedLogin("office", "member");
    expect(await removedAccessFor("office")).toBeNull();
  });

  it("cancels a pending invitation outright", async () => {
    await seedFirm();
    const invite = await createInvite("firm", "pm@example.com");
    if (!invite.ok) throw new Error(invite.error);
    expect(await removeTeamLogin("firm", invite.inviteId)).toEqual({ ok: true, memberUserId: null });
    expect(await fake.client.teamMember.count()).toBe(0);
    expect((await fake.client.quickBooksConnection.findUnique({ where: { id: "c2" } })).emailRecipients).toEqual([]);
  });

  it("only removes logins on the owner's own account", async () => {
    await seedFirm();
    await seedLogin("pm", "member");
    expect(await removeTeamLogin("someone-else", "tm-pm")).toMatchObject({ ok: false, status: 404 });
    expect(await removeTeamLogin("firm", "missing")).toMatchObject({ ok: false, status: 404 });
    // Already removed: nothing more to do.
    await removeTeamLogin("firm", "tm-pm");
    expect(await removeTeamLogin("firm", "tm-pm")).toMatchObject({ ok: false, status: 404 });
  });

  it("can be invited back, by the same account or another one", async () => {
    await seedFirm();
    await seedLogin("pm", "member");
    await removeTeamLogin("firm", "tm-pm");
    // The old invitation link is dead.
    expect(await acceptInvite("hash-pm-token-that-was-never-valid", "pm")).toMatchObject({ ok: false });

    await fake.client.user.create({ data: { id: "other", email: "other@example.com", emailVerifiedAt: new Date() } });
    await fake.client.subscription.create({ data: { userId: "other", status: "trialing", trialEndsAt: new Date(Date.now() + 10 * DAY) } });
    const invite = await createInvite("other", "pm@example.com");
    if (!invite.ok) throw new Error(invite.error);
    expect(await acceptInvite(invite.token, "pm")).toEqual({ ok: true, ownerUserId: "other" });
    expect(await accountFor("pm")).toMatchObject({ ownerId: "other", role: "member" });
  });

  it("can be invited back to the same account", async () => {
    await seedFirm();
    await seedLogin("pm", "member");
    await removeTeamLogin("firm", "tm-pm");
    const invite = await createInvite("firm", "pm@example.com");
    if (!invite.ok) throw new Error(invite.error);
    expect(await acceptInvite(invite.token, "pm")).toEqual({ ok: true, ownerUserId: "firm" });
    expect(await accountFor("pm")).toMatchObject({ ownerId: "firm", role: "member" });
  });
});

describe("disconnecting a company", () => {
  it("removes its client logins and cancels their invitations, and no other company's", async () => {
    await seedFirm();
    await seedLogin("acme", "client", "c1");
    await seedLogin("best", "client", "c2");
    const pending = await createInvite("firm", "new@acme.com", new Date(), { clientConnectionId: "c1" });
    if (!pending.ok) throw new Error(pending.error);

    expect(await removeClientLoginsForCompany("firm", "c1")).toEqual(["acme"]);
    expect(await fake.client.teamMember.findUnique({ where: { id: "tm-acme" } })).toMatchObject({ role: REMOVED_ROLE, connectionId: null });
    expect(await fake.client.teamMember.findUnique({ where: { id: pending.inviteId } })).toBeNull();
    expect(await accountFor("acme")).toMatchObject({ role: "owner", ownerId: "acme" });
    expect(await accountFor("best")).toMatchObject({ role: "client", connectionId: "c2" });
  });
});

describe("recipient lists", () => {
  it("drop an address whatever its case or spacing", () => {
    expect(withoutAddresses(["A@x.com", " b@x.com ", "c@x.com"], ["a@X.com", "B@x.com"])).toEqual(["c@x.com"]);
    expect(withoutAddresses(["a@x.com"], [""])).toEqual(["a@x.com"]);
  });
});

describe("company pickers", () => {
  const companies = [
    { id: "3", name: "cole decks" },
    { id: "1", name: "Acme Roofing" },
    { id: "2", name: "Best Builders" },
    { id: "4", name: "Acme Roofing" },
  ];

  it("list companies by name", () => {
    expect(sortCompaniesByName(companies).map((c) => c.id)).toEqual(["1", "4", "2", "3"]);
  });

  it("filter by name but keep the chosen one", () => {
    expect(filterCompanies(companies, "ACME").map((c) => c.id)).toEqual(["1", "4"]);
    expect(filterCompanies(companies, "acme", "3").map((c) => c.id)).toEqual(["3", "1", "4"]);
    expect(filterCompanies(companies, "  ")).toHaveLength(4);
  });

  it("start the client login form on the company on screen, not the first connected", () => {
    expect(defaultInviteCompanyId(companies, "2")).toBe("2");
    expect(defaultInviteCompanyId(companies, "gone")).toBe("1");
    expect(defaultInviteCompanyId([], null)).toBe("");
  });
});

describe("the sync problem strip", () => {
  const base = { companyName: "Acme", lastSyncStatus: "success", lastSyncError: null, lastSyncedAt: new Date("2026-09-20T12:00:00Z"), emailTimezone: "UTC" };
  const dashes = /[\u2013\u2014]/;

  it("shows nothing when the company is syncing fine", () => {
    expect(syncProblemFor(base, { paused: false, role: "owner" })).toBeNull();
  });

  it("explains a paused company and where to fix it, by who can fix it", () => {
    const owner = syncProblemFor(base, { paused: true, role: "owner" })!;
    expect(owner.message).toMatch(/paused because your plan/);
    expect(owner.link?.href).toBe("/dashboard/billing");
    expect(syncProblemFor(base, { paused: true, role: "member" })!.link).toBeNull();
    const client = syncProblemFor(base, { paused: true, role: "client" })!;
    expect(client.link).toBeNull();
    expect(client.message).toMatch(/bookkeeper/);
  });

  it("never shows the raw sync error", () => {
    const raw = "Change Data Capture returned 1000 records, at or over its cap";
    const failed = syncProblemFor({ ...base, lastSyncStatus: "error", lastSyncError: raw }, { paused: false, role: "owner" })!;
    expect(failed.message).not.toContain("Change Data Capture");
    expect(failed.message).toMatch(/didn't finish/);
    expect(failed.link?.href).toBe("/dashboard/settings");

    const reconnect = syncProblemFor({ ...base, lastSyncStatus: "error", lastSyncError: RECONNECT_REQUIRED_MESSAGE }, { paused: false, role: "member" })!;
    expect(reconnect.tone).toBe("critical");
    expect(reconnect.message).toMatch(/reconnected/);

    const noClasses = syncProblemFor(
      { ...base, lastSyncStatus: "error", lastSyncError: "Your jobs are set to come from QuickBooks Classes, but QuickBooks sent no classes. If..." },
      { paused: false, role: "owner" }
    )!;
    expect(noClasses.message).toMatch(/Classes, but QuickBooks has none/);
  });

  it("never sends a client login to pages it can't open, and uses no dashes", () => {
    for (const lastSyncError of [RECONNECT_REQUIRED_MESSAGE, "boom", "Your jobs are set to come from QuickBooks Classes"]) {
      for (const role of ["owner", "member", "client"] as const) {
        for (const paused of [false, true]) {
          const p = syncProblemFor({ ...base, lastSyncStatus: "error", lastSyncError }, { paused, role })!;
          expect(dashes.test(p.message)).toBe(false);
          if (role === "client") {
            expect(p.link).toBeNull();
            expect(p.message).not.toMatch(/Settings|Billing|Sync now/);
          }
        }
      }
    }
  });
});
