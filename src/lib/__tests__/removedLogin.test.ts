import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

// A login whose access to someone else's account was removed: it carries on
// in an empty account of its own, can choose a plan or delete itself, never
// sees the old account, and can join another team. Mocks match
// accessRules.test.ts.

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

import { accountFor, canSeeConnection, connectionForAccount, listCompanies, refuseClient } from "../account";
import { acceptInvite, createInvite } from "../team";
import { removedAccessFor, removeTeamLogin, REMOVED_ROLE } from "../teamRemoval";
import { ensureSubscription, NO_PLAN_STATUS } from "../trial";
import { getEntitlements } from "../entitlements";

const DAY = 86_400_000;

async function seedOwner(id: string, email: string, name: string | null = null) {
  await fake.client.user.create({ data: { id, email, name, emailVerifiedAt: new Date() } });
  await fake.client.subscription.create({
    data: { userId: id, plan: "firm", status: "active", stripeSubscriptionId: `sub_${id}`, trialEndsAt: new Date(Date.now() + 10 * DAY) },
  });
}

async function seedAcceptedLogin(ownerId: string, role: "member" | "client", connectionId: string | null = null) {
  await fake.client.user.create({ data: { id: "pm", email: "pm@example.com", emailVerifiedAt: new Date() } });
  await fake.client.teamMember.create({
    data: {
      id: "tm-pm",
      ownerUserId: ownerId,
      email: "pm@example.com",
      memberUserId: "pm",
      tokenHash: "hash-pm",
      invitedAt: new Date(Date.now() - DAY),
      expiresAt: new Date(Date.now() + DAY),
      acceptedAt: new Date(),
      role,
      connectionId,
    },
  });
}

beforeEach(async () => {
  fake.client = createFakePrisma();
  await seedOwner("firm", "books@firm.com", "Pat Books");
  await fake.client.quickBooksConnection.create({ data: { id: "c1", userId: "firm", companyName: "Acme Roofing", realmIdHash: "r1" } });
});

describe("a removed login", () => {
  for (const role of ["member", "client"] as const) {
    it(`works in its own empty account as its owner, and never sees the old one (${role})`, async () => {
      await seedAcceptedLogin("firm", role, role === "client" ? "c1" : null);
      await removeTeamLogin("firm", "tm-pm");

      const account = await accountFor("pm");
      expect(account).toEqual({ userId: "pm", ownerId: "pm", role: "owner", connectionId: null });
      expect(refuseClient(account)).toBeNull();
      expect(await listCompanies(account)).toEqual([]);
      expect(await connectionForAccount(account, "c1")).toBeNull();
      expect(canSeeConnection(account, { id: "c1", userId: "firm" })).toBe(false);

      // Its own account has no plan and no fresh trial: Billing offers the plans.
      await ensureSubscription("pm");
      expect((await fake.client.subscription.findUnique({ where: { userId: "pm" } })).status).toBe(NO_PLAN_STATUS);
      const entitlements = await getEntitlements("pm");
      expect(entitlements.active).toBe(false);
      expect(entitlements.access).toBe("none");

      // The dashboard says whose account it was, and nothing more.
      expect(await removedAccessFor("pm")).toEqual({ ownerName: "Pat Books", ownerEmail: "books@firm.com" });
    });
  }

  it("gets every dashboard page, Billing and Settings included, with a notice instead of a wall", () => {
    const layout = readFileSync(path.join(__dirname, "../../app/dashboard/layout.tsx"), "utf8");
    // No early return of a stand-alone screen for removed logins.
    expect(layout).not.toMatch(/if \(removed\)\s*return/);
    expect(layout).toMatch(/\{removed \? <RemovedAccessNotice/);
    expect(layout).toContain('href="/dashboard/billing"');
    expect(layout).toContain('href="/dashboard/settings"');
    expect(layout).toMatch(/<Fragment key=\{activeCompany\?\.id \?\? "none"\}>\{children\}<\/Fragment>/);
  });
});

describe("inviting a removed person back", () => {
  it("doesn't tie the unused invitation to their login", async () => {
    await seedAcceptedLogin("firm", "member");
    await removeTeamLogin("firm", "tm-pm");
    expect((await fake.client.teamMember.findUnique({ where: { id: "tm-pm" } })).memberUserId).toBe("pm");

    const again = await createInvite("firm", "pm@example.com");
    if (!again.ok) throw new Error(again.error);
    expect(again.inviteId).toBe("tm-pm");
    const row = await fake.client.teamMember.findUnique({ where: { id: "tm-pm" } });
    expect(row).toMatchObject({ memberUserId: null, acceptedAt: null, role: "member" });
    // Still their own account until they accept.
    expect(await accountFor("pm")).toMatchObject({ ownerId: "pm", role: "owner" });
  });

  it("an unused re-invitation doesn't stop them joining another team", async () => {
    await seedAcceptedLogin("firm", "member");
    await removeTeamLogin("firm", "tm-pm");
    const back = await createInvite("firm", "pm@example.com");
    if (!back.ok) throw new Error(back.error);

    await seedOwner("other", "owner@other.com");
    const invite = await createInvite("other", "pm@example.com");
    if (!invite.ok) throw new Error(invite.error);
    expect(await acceptInvite(invite.token, "pm")).toEqual({ ok: true, ownerUserId: "other" });
    expect(await accountFor("pm")).toMatchObject({ ownerId: "other", role: "member" });
    // The first account's unused invitation is moot now.
    expect(await fake.client.teamMember.findUnique({ where: { id: back.inviteId } })).toBeNull();
  });

  it("a re-invitation row left holding the login from before this fix doesn't block joining either", async () => {
    await seedAcceptedLogin("firm", "member");
    await removeTeamLogin("firm", "tm-pm");
    // What the old createInvite left: a pending invitation still holding the login id.
    await fake.client.teamMember.update({
      where: { id: "tm-pm" },
      data: { role: "member", tokenHash: "hash-again", expiresAt: new Date(Date.now() + 7 * DAY), email: "pm.old@example.com" },
    });

    await seedOwner("other", "owner@other.com");
    const invite = await createInvite("other", "pm@example.com");
    if (!invite.ok) throw new Error(invite.error);
    expect(await acceptInvite(invite.token, "pm")).toEqual({ ok: true, ownerUserId: "other" });
    // The old invitation stays for its own address, without the login.
    expect(await fake.client.teamMember.findUnique({ where: { id: "tm-pm" } })).toMatchObject({ memberUserId: null, acceptedAt: null });
  });

  it("the removal marker itself still doesn't block joining", async () => {
    await seedAcceptedLogin("firm", "member");
    await removeTeamLogin("firm", "tm-pm");
    await seedOwner("other", "owner@other.com");
    const invite = await createInvite("other", "pm@example.com");
    if (!invite.ok) throw new Error(invite.error);
    expect(await acceptInvite(invite.token, "pm")).toEqual({ ok: true, ownerUserId: "other" });
    expect(await fake.client.teamMember.count({ where: { role: REMOVED_ROLE } })).toBe(0);
  });

  it("an accepted membership still blocks joining another team", async () => {
    await seedAcceptedLogin("firm", "member");
    await seedOwner("other", "owner@other.com");
    const invite = await createInvite("other", "pm@example.com");
    if (!invite.ok) throw new Error(invite.error);
    expect(await acceptInvite(invite.token, "pm")).toMatchObject({ ok: false, status: 409 });
    expect(await accountFor("pm")).toMatchObject({ ownerId: "firm", role: "member" });
  });
});
