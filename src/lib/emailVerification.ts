import { randomBytes } from "crypto";
import { prisma } from "./prisma";
import { hashToken } from "./passwordReset";

// Email verification.
//
// What it protects, which is why it exists at all:
//
// 1. The admin area. Admin access comes from the ADMIN_EMAILS allowlist, and
//    until now "is this address on the list" was the whole check. An address
//    on that list with no account yet was a claimable admin slot: anyone who
//    signed up with it first got every customer's data. Admin now also
//    requires that the account has proved it receives mail at that address.
//
// 2. The Weekly Profit Brief. A new connection sends the brief to the
//    account's own address by default. A typo at signup meant a stranger
//    received one company's job-level revenue, costs and margins every
//    week. The brief is not sent until the owner has verified.
//
// Nothing else is withheld. An unverified account can sign in, connect
// QuickBooks and use the whole product; it sees a banner asking it to
// verify. Blocking the product itself would cost trial conversions to
// protect against a mistake that only matters at the two points above.
//
// Tokens follow the password reset design exactly (see passwordReset.ts):
// 256 random bits, only the SHA-256 hash stored, single use, rate limited.

/** Long enough to survive a weekend; a verification link is lower stakes than a reset. */
export const VERIFY_TOKEN_TTL_HOURS = 48;

/** Resends allowed per account per hour, for the same inbox-flooding reason as resets. */
export const MAX_VERIFICATIONS_PER_HOUR = 5;

const HOUR_MS = 60 * 60 * 1000;

export interface CreatedVerification {
  userId: string;
  email: string;
  name: string | null;
  /** The raw token. Goes in the email link and nowhere else. */
  token: string;
  expiresAt: Date;
}

export type CreateVerificationResult =
  | { ok: true; verification: CreatedVerification }
  | { ok: false; reason: "not_found" | "already_verified" | "rate_limited" };

/**
 * Issues a verification link for an account. Unlike the reset flow this is
 * always called for a signed-in (or just-created) user, so there is no
 * account-existence oracle to protect and the reasons can be specific.
 */
export async function createEmailVerification(
  userId: string,
  now: Date = new Date()
): Promise<CreateVerificationResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { ok: false, reason: "not_found" };
  if (user.emailVerifiedAt) return { ok: false, reason: "already_verified" };

  const recent = await prisma.emailVerificationToken.count({
    where: { userId, createdAt: { gt: new Date(now.getTime() - HOUR_MS) } },
  });
  if (recent >= MAX_VERIFICATIONS_PER_HOUR) return { ok: false, reason: "rate_limited" };

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + VERIFY_TOKEN_TTL_HOURS * HOUR_MS);

  await prisma.emailVerificationToken.create({
    data: { userId, email: user.email, tokenHash: hashToken(token), expiresAt, createdAt: now },
  });

  return {
    ok: true,
    verification: { userId, email: user.email, name: user.name ?? null, token, expiresAt },
  };
}

export type VerifyOutcome =
  | { ok: true; userId: string; email: string; firstTime: boolean }
  | { ok: false; reason: "invalid" | "expired" | "used" | "email_changed" };

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Verifies the address a link was sent to.
 *
 * A link that has already been used reports SUCCESS if the account is
 * verified. That is deliberate. Corporate mail filters (Outlook Safe Links,
 * Mimecast and friends) fetch every link in an email before the recipient
 * sees it, so the first visit is often a scanner's. Treating the customer's
 * own click as "this link was already used" would tell someone whose address
 * is verified that something went wrong. The scanner's visit still proves
 * what verification is for: mail sent to that address arrived there.
 */
export async function verifyEmailToken(token: string, now: Date = new Date()): Promise<VerifyOutcome> {
  if (!token) return { ok: false, reason: "invalid" };

  const tokenHash = hashToken(token);
  const row = await prisma.emailVerificationToken.findUnique({ where: { tokenHash } });
  if (!row) return { ok: false, reason: "invalid" };

  const user = await prisma.user.findUnique({ where: { id: row.userId } });
  if (!user) return { ok: false, reason: "invalid" };

  // The link proves the address it was sent to, not whatever the account
  // says now.
  if (!sameAddress(row.email, user.email)) return { ok: false, reason: "email_changed" };

  if (row.usedAt) {
    return user.emailVerifiedAt
      ? { ok: true, userId: user.id, email: user.email, firstTime: false }
      : { ok: false, reason: "used" };
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    // An expired link on an account that verified some other way is
    // still good news, not an error.
    return user.emailVerifiedAt
      ? { ok: true, userId: user.id, email: user.email, firstTime: false }
      : { ok: false, reason: "expired" };
  }

  const firstTime = await prisma.$transaction(async (tx) => {
    const claim = await tx.emailVerificationToken.updateMany({
      where: { tokenHash, usedAt: null },
      data: { usedAt: now },
    });
    if (claim.count === 0) return false;

    // Only stamped when still null, so the first verification date is kept
    // and a second link can't move it.
    const stamped = await tx.user.updateMany({
      where: { id: user.id, emailVerifiedAt: null },
      data: { emailVerifiedAt: now },
    });

    // Every other outstanding link for this account is spent too.
    await tx.emailVerificationToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now },
    });

    return stamped.count > 0;
  });

  return { ok: true, userId: user.id, email: user.email, firstTime };
}

/** Whether an account has verified its address. */
export async function isEmailVerified(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { emailVerifiedAt: true },
  });
  return Boolean(user?.emailVerifiedAt);
}

/** Housekeeping for the lifecycle cron, same as purgeExpiredPasswordResets. */
export async function purgeExpiredEmailVerifications(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * HOUR_MS);
  const result = await prisma.emailVerificationToken.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return result.count;
}
