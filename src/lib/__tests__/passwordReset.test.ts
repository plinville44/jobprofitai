import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));

// bcrypt is real but slow, and none of these tests are about hashing. Stub it
// to something deterministic so the suite stays fast, while still proving the
// stored hash CHANGED, which is the property that matters here.
vi.mock("@/lib/auth", () => ({
  hashPassword: async (p: string) => `hashed:${p}`,
}));

import {
  MAX_RESETS_PER_HOUR,
  RESET_TOKEN_TTL_MINUTES,
  completePasswordReset,
  createPasswordReset,
  hashToken,
  inspectPasswordReset,
  purgeExpiredPasswordResets,
} from "../passwordReset";

const NOW = new Date("2026-09-09T12:00:00Z");
const MINUTE = 60_000;

async function makeUser(email = "owner@example.com") {
  return fake.client.user.create({
    data: { id: "u1", email, passwordHash: "hashed:original", name: "Sam Builder" },
  });
}

beforeEach(() => {
  fake.client = createFakePrisma();
});

describe("createPasswordReset", () => {
  it("issues a token for a known address and stores only its hash", async () => {
    await makeUser();

    const reset = await createPasswordReset("owner@example.com", NOW);

    expect(reset).not.toBeNull();
    expect(reset!.token.length).toBeGreaterThan(20);

    const rows = await fake.client.passwordResetToken.findMany({});
    expect(rows).toHaveLength(1);

    // The raw token must not be recoverable from the database. This is the
    // whole reason the column is a hash: a leaked backup is useless to an
    // attacker because the value in it can't be put in a reset link.
    expect(rows[0].tokenHash).toBe(hashToken(reset!.token));
    expect(rows[0].tokenHash).not.toBe(reset!.token);
    expect(JSON.stringify(rows[0])).not.toContain(reset!.token);
  });

  it("sets the expiry from the configured TTL", async () => {
    await makeUser();
    const reset = await createPasswordReset("owner@example.com", NOW);
    expect(reset!.expiresAt.getTime() - NOW.getTime()).toBe(RESET_TOKEN_TTL_MINUTES * MINUTE);
  });

  it("returns null for an unknown address, and writes nothing", async () => {
    await makeUser();

    const reset = await createPasswordReset("nobody@example.com", NOW);

    expect(reset).toBeNull();
    expect(await fake.client.passwordResetToken.count()).toBe(0);
  });

  it("finds the account regardless of email casing", async () => {
    await makeUser("Owner@Example.com");
    const reset = await createPasswordReset("owner@example.com", NOW);
    expect(reset).not.toBeNull();
    expect(reset!.email).toBe("Owner@Example.com");
  });

  it("stops issuing after the hourly limit, so nobody can flood an inbox", async () => {
    await makeUser();

    for (let i = 0; i < MAX_RESETS_PER_HOUR; i++) {
      expect(await createPasswordReset("owner@example.com", NOW)).not.toBeNull();
    }

    expect(await createPasswordReset("owner@example.com", NOW)).toBeNull();
    expect(await fake.client.passwordResetToken.count()).toBe(MAX_RESETS_PER_HOUR);
  });

  it("lets the limit lapse once an hour has passed", async () => {
    await makeUser();
    for (let i = 0; i < MAX_RESETS_PER_HOUR; i++) {
      await createPasswordReset("owner@example.com", NOW);
    }

    const later = new Date(NOW.getTime() + 61 * MINUTE);
    expect(await createPasswordReset("owner@example.com", later)).not.toBeNull();
  });
});

describe("inspectPasswordReset", () => {
  it("accepts a fresh token", async () => {
    await makeUser();
    const reset = await createPasswordReset("owner@example.com", NOW);

    const result = await inspectPasswordReset(reset!.token, NOW);

    expect(result.ok).toBe(true);
  });

  it("rejects a token that never existed", async () => {
    const result = await inspectPasswordReset("not-a-real-token", NOW);
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects an expired token", async () => {
    await makeUser();
    const reset = await createPasswordReset("owner@example.com", NOW);

    const late = new Date(NOW.getTime() + (RESET_TOKEN_TTL_MINUTES + 1) * MINUTE);
    expect(await inspectPasswordReset(reset!.token, late)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("does not consume the token it checks", async () => {
    await makeUser();
    const reset = await createPasswordReset("owner@example.com", NOW);

    await inspectPasswordReset(reset!.token, NOW);
    await inspectPasswordReset(reset!.token, NOW);

    // Checking a link must stay side-effect free, or the page load that
    // validates the link would burn it before the customer typed anything.
    const result = await completePasswordReset(reset!.token, "brand-new-password", NOW);
    expect(result.ok).toBe(true);
  });
});

describe("completePasswordReset", () => {
  it("changes the password and burns the token", async () => {
    await makeUser();
    const reset = await createPasswordReset("owner@example.com", NOW);

    const result = await completePasswordReset(reset!.token, "brand-new-password", NOW);

    expect(result.ok).toBe(true);

    const user = await fake.client.user.findUnique({ where: { id: "u1" } });
    expect(user.passwordHash).toBe("hashed:brand-new-password");

    const row = await fake.client.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(reset!.token) },
    });
    expect(row.usedAt).not.toBeNull();
  });

  it("refuses to reuse a link", async () => {
    await makeUser();
    const reset = await createPasswordReset("owner@example.com", NOW);

    await completePasswordReset(reset!.token, "first-new-password", NOW);
    const second = await completePasswordReset(reset!.token, "second-new-password", NOW);

    expect(second).toEqual({ ok: false, reason: "used" });

    // The second attempt must not have taken effect. A reused link that
    // still sets a password would let anyone with an old email thread take
    // the account back at any time.
    const user = await fake.client.user.findUnique({ where: { id: "u1" } });
    expect(user.passwordHash).toBe("hashed:first-new-password");
  });

  it("invalidates every other outstanding link for that account", async () => {
    await makeUser();
    const first = await createPasswordReset("owner@example.com", NOW);
    const second = await createPasswordReset("owner@example.com", NOW);

    await completePasswordReset(second!.token, "brand-new-password", NOW);

    // Someone who clicked "forgot password" twice should not be left with a
    // working link sitting in their inbox afterwards.
    expect(await inspectPasswordReset(first!.token, NOW)).toEqual({
      ok: false,
      reason: "used",
    });
  });

  it("refuses an expired link even if it was never used", async () => {
    await makeUser();
    const reset = await createPasswordReset("owner@example.com", NOW);

    const late = new Date(NOW.getTime() + (RESET_TOKEN_TTL_MINUTES + 1) * MINUTE);
    const result = await completePasswordReset(reset!.token, "brand-new-password", late);

    expect(result).toEqual({ ok: false, reason: "expired" });

    const user = await fake.client.user.findUnique({ where: { id: "u1" } });
    expect(user.passwordHash).toBe("hashed:original");
  });

  it("leaves other accounts untouched", async () => {
    await makeUser();
    await fake.client.user.create({
      data: { id: "u2", email: "other@example.com", passwordHash: "hashed:theirs" },
    });

    const reset = await createPasswordReset("owner@example.com", NOW);
    await completePasswordReset(reset!.token, "brand-new-password", NOW);

    const other = await fake.client.user.findUnique({ where: { id: "u2" } });
    expect(other.passwordHash).toBe("hashed:theirs");
  });
});

describe("purgeExpiredPasswordResets", () => {
  it("removes only tokens that expired more than a day ago", async () => {
    await makeUser();
    const old = await createPasswordReset("owner@example.com", new Date(NOW.getTime() - 48 * 60 * MINUTE));
    const recent = await createPasswordReset("owner@example.com", NOW);

    const removed = await purgeExpiredPasswordResets(NOW);

    expect(removed).toBe(1);
    expect(await inspectPasswordReset(old!.token, NOW)).toEqual({ ok: false, reason: "invalid" });
    expect((await inspectPasswordReset(recent!.token, NOW)).ok).toBe(true);
  });
});
