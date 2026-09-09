import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "./prisma";
import { hashPassword } from "./auth";

// Password reset.
//
// The three properties that matter, and how each is enforced:
//
// 1. A stolen database gives an attacker nothing usable. Only the SHA-256
//    hash of a token is stored. Reset links are high-value bearer tokens -
//    whoever holds one owns the account - so they get the same treatment as
//    a password: hashed at rest, never logged, never returned by an API.
//
// 2. A link works once. `usedAt` is stamped inside the same transaction that
//    changes the password, and every other outstanding token for that user
//    is invalidated at the same moment. Someone who requested three resets
//    while confused cannot leave two live links behind in their inbox.
//
// 3. Requesting a reset tells you nothing about who has an account. The
//    route always responds identically, so this module returns null for an
//    unknown address rather than throwing something a caller might surface.

/** How long a reset link stays valid. */
export const RESET_TOKEN_TTL_MINUTES = 60;

/**
 * Most resets a single account can request per hour.
 *
 * This is abuse protection for the mailbox owner, not for us: without it,
 * anyone who knows a customer's email address can flood their inbox with
 * genuine-looking reset mail from us, which is both harassment and a good
 * way to get our sending domain reported as spam.
 */
export const MAX_RESETS_PER_HOUR = 5;

const HOUR_MS = 60 * 60 * 1000;

/** SHA-256, hex. Fast on purpose: the token is 256 bits of entropy already,
 *  so there is nothing to brute-force and no reason to pay bcrypt's cost on
 *  a path that runs before we know the caller is legitimate. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface CreatedReset {
  userId: string;
  email: string;
  name: string | null;
  /** The raw token. Goes in the email link and nowhere else. */
  token: string;
  expiresAt: Date;
}

/**
 * Issues a reset token for an email address, or returns null.
 *
 * Null covers three different situations on purpose - no such account, too
 * many recent requests, and a malformed address - because the caller must
 * respond identically in all of them. Distinguishing them to the client
 * would turn this endpoint into an account-existence oracle, which is how
 * "is this customer of yours also a customer of ours" gets answered by
 * anyone who cares to ask.
 */
export async function createPasswordReset(
  emailInput: string,
  now: Date = new Date()
): Promise<CreatedReset | null> {
  const email = emailInput.trim();
  if (!email) return null;

  // Same two-step lookup as the login route: exact match first (indexed),
  // then case-insensitive, so an account created before signup normalized
  // casing can still reset.
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
    });
  }
  if (!user) return null;

  const recent = await prisma.passwordResetToken.count({
    where: { userId: user.id, createdAt: { gt: new Date(now.getTime() - HOUR_MS) } },
  });
  if (recent >= MAX_RESETS_PER_HOUR) return null;

  // 32 bytes = 256 bits. base64url so it survives being pasted into a URL,
  // an email client's link rewriter, and a customer's copy and paste.
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

  await prisma.passwordResetToken.create({
    // createdAt is written explicitly rather than left to the database
    // default, because the rate limit counts rows by it. Passing the same
    // `now` the expiry is derived from keeps the two consistent, and makes
    // the hourly window testable without waiting an hour.
    data: { userId: user.id, tokenHash: hashToken(token), expiresAt, createdAt: now },
  });

  return { userId: user.id, email: user.email, name: user.name ?? null, token, expiresAt };
}

export type ResetOutcome =
  | { ok: true; userId: string; email: string }
  | { ok: false; reason: "invalid" | "expired" | "used" };

/**
 * Checks a token without consuming it, so the reset page can show "this link
 * has expired" before the customer types a new password rather than after.
 */
export async function inspectPasswordReset(
  token: string,
  now: Date = new Date()
): Promise<ResetOutcome> {
  if (!token) return { ok: false, reason: "invalid" };

  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!row) return { ok: false, reason: "invalid" };
  if (row.usedAt) return { ok: false, reason: "used" };
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };

  const user = await prisma.user.findUnique({ where: { id: row.userId } });
  if (!user) return { ok: false, reason: "invalid" };

  return { ok: true, userId: user.id, email: user.email };
}

/**
 * Sets the new password and burns the token.
 *
 * Everything happens in one transaction, and the `usedAt: null` guard on the
 * update is what actually prevents a double-spend: two requests arriving
 * together with the same link both read an unused row, but only one
 * updateMany matches, and the loser sees count 0 and gives up. Doing this
 * check in application code instead would leave a window between reading and
 * writing where both could pass.
 */
export async function completePasswordReset(
  token: string,
  newPassword: string,
  now: Date = new Date()
): Promise<ResetOutcome> {
  const check = await inspectPasswordReset(token, now);
  if (!check.ok) return check;

  const tokenHash = hashToken(token);
  const passwordHash = await hashPassword(newPassword);

  const claimed = await prisma.$transaction(async (tx) => {
    const claim = await tx.passwordResetToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claim.count === 0) return false;

    await tx.user.update({
      where: { id: check.userId },
      data: { passwordHash },
    });

    // Any other live link for this account dies here too. A customer who
    // clicked "forgot password" three times should not be left with two
    // working links sitting in their inbox after the reset succeeds.
    await tx.passwordResetToken.updateMany({
      where: { userId: check.userId, usedAt: null },
      data: { usedAt: now },
    });

    return true;
  });

  if (!claimed) return { ok: false, reason: "used" };
  return check;
}

/**
 * Constant-time string compare, for anywhere a token is compared directly
 * rather than looked up by hash. Exported because the temptation to write
 * `a === b` on a secret is worth heading off with something already here.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Housekeeping: drops tokens that expired more than a day ago. Called from
 * the lifecycle cron. Not security-critical, since an expired token is
 * already refused, but there is no reason to accumulate them forever.
 */
export async function purgeExpiredPasswordResets(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * HOUR_MS);
  const result = await prisma.passwordResetToken.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return result.count;
}
