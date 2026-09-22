import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));
// emailVerification reuses hashToken from passwordReset, which imports auth
// (bcrypt, jose). None of that is under test here.
vi.mock("@/lib/auth", () => ({ hashPassword: async (p: string) => `hashed:${p}` }));

import {
  MAX_VERIFICATIONS_PER_HOUR,
  VERIFY_TOKEN_TTL_HOURS,
  createEmailVerification,
  isEmailVerified,
  purgeExpiredEmailVerifications,
  verifyEmailToken,
} from "../emailVerification";
import { hashToken } from "../passwordReset";

const NOW = new Date("2026-09-22T12:00:00Z");
const HOUR = 60 * 60 * 1000;

async function makeUser(email = "owner@example.com", verifiedAt: Date | null = null) {
  return fake.client.user.create({
    data: { id: "u1", email, passwordHash: "x", name: "Sam Builder", emailVerifiedAt: verifiedAt },
  });
}

async function issue(at: Date = NOW) {
  const r = await createEmailVerification("u1", at);
  if (!r.ok) throw new Error(`expected a link, got ${r.reason}`);
  return r.verification;
}

beforeEach(() => {
  fake.client = createFakePrisma();
});

describe("createEmailVerification", () => {
  it("issues a link for the account's own address and stores only its hash", async () => {
    await makeUser();
    const v = await issue();

    expect(v.email).toBe("owner@example.com");
    expect(v.expiresAt.getTime()).toBe(NOW.getTime() + VERIFY_TOKEN_TTL_HOURS * HOUR);

    const rows = await fake.client.emailVerificationToken.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashToken(v.token));
    expect(JSON.stringify(rows[0])).not.toContain(v.token);
  });

  it("does nothing for an account that is already verified", async () => {
    await makeUser("owner@example.com", new Date("2026-09-01T00:00:00Z"));
    expect(await createEmailVerification("u1", NOW)).toEqual({ ok: false, reason: "already_verified" });
  });

  it("stops after the hourly limit, then allows more an hour later", async () => {
    await makeUser();
    for (let i = 0; i < MAX_VERIFICATIONS_PER_HOUR; i++) await issue(new Date(NOW.getTime() + i * 1000));

    expect(await createEmailVerification("u1", new Date(NOW.getTime() + 10_000))).toEqual({
      ok: false,
      reason: "rate_limited",
    });
    expect((await createEmailVerification("u1", new Date(NOW.getTime() + HOUR + 10_000))).ok).toBe(true);
  });
});

describe("verifyEmailToken", () => {
  it("verifies the account and reports it as the first time", async () => {
    await makeUser();
    const v = await issue();

    const result = await verifyEmailToken(v.token, NOW);

    expect(result).toEqual({ ok: true, userId: "u1", email: "owner@example.com", firstTime: true });
    expect(await isEmailVerified("u1")).toBe(true);
  });

  /**
   * Mail scanners fetch links before the recipient does. The customer's own
   * click must still land on success, not "this link was already used".
   */
  it("treats a second click on a used link as success once verified", async () => {
    await makeUser();
    const v = await issue();
    await verifyEmailToken(v.token, NOW); // the scanner

    const again = await verifyEmailToken(v.token, new Date(NOW.getTime() + 60_000)); // the customer
    expect(again).toEqual({ ok: true, userId: "u1", email: "owner@example.com", firstTime: false });
  });

  it("keeps the first verification date when a second link is used", async () => {
    await makeUser();
    const first = await issue();
    const second = await issue(new Date(NOW.getTime() + 1000));

    await verifyEmailToken(first.token, NOW);
    await verifyEmailToken(second.token, new Date(NOW.getTime() + 5 * HOUR));

    const user = await fake.client.user.findUnique({ where: { id: "u1" } });
    expect(user.emailVerifiedAt.getTime()).toBe(NOW.getTime());
  });

  it("spends every other outstanding link on success", async () => {
    await makeUser();
    await issue();
    const v = await issue(new Date(NOW.getTime() + 1000));
    await verifyEmailToken(v.token, NOW);

    const live = await fake.client.emailVerificationToken.findMany({ where: { usedAt: null } });
    expect(live).toHaveLength(0);
  });

  it("refuses an expired link on an unverified account", async () => {
    await makeUser();
    const v = await issue();
    const later = new Date(NOW.getTime() + (VERIFY_TOKEN_TTL_HOURS + 1) * HOUR);

    expect(await verifyEmailToken(v.token, later)).toEqual({ ok: false, reason: "expired" });
    expect(await isEmailVerified("u1")).toBe(false);
  });

  it("refuses a link sent to an address the account no longer has", async () => {
    await makeUser();
    const v = await issue();
    await fake.client.user.update({ where: { id: "u1" }, data: { email: "new@example.com" } });

    expect(await verifyEmailToken(v.token, NOW)).toEqual({ ok: false, reason: "email_changed" });
    expect(await isEmailVerified("u1")).toBe(false);
  });

  it("refuses a token it has never issued", async () => {
    await makeUser();
    expect(await verifyEmailToken("not-a-real-token", NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyEmailToken("", NOW)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("purgeExpiredEmailVerifications", () => {
  it("drops links that expired more than a day ago and keeps the rest", async () => {
    await makeUser();
    await issue(new Date(NOW.getTime() - 10 * 24 * HOUR)); // long dead
    await issue(NOW); // live

    expect(await purgeExpiredEmailVerifications(NOW)).toBe(1);
    expect(await fake.client.emailVerificationToken.count()).toBe(1);
  });
});
