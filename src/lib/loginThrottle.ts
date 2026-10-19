import crypto from "crypto";
import { prisma } from "./prisma";

/**
 * Login rate limiting, backed by the database so it holds across every
 * serverless instance.
 *
 *   - 8 failed attempts on one email address in 15 minutes locks that
 *     address out for the rest of the window (slows password guessing
 *     against one account), checked before the password is.
 *   - 40 failed attempts from one IP address in 15 minutes locks that IP
 *     out (slows spraying one password across many accounts).
 *   - A successful password reset clears the address's failed attempts, so
 *     a customer locked out by someone else's guesses has a way back in.
 *
 * Each attempt is written as a failure BEFORE the password is checked and
 * the count includes it (startLoginAttempt), then turned into a success if
 * the password was right. Counting first and writing after let many
 * requests sent at once all pass the check and all guess.
 *
 * The same table also counts signups per network address
 * (SIGNUPS_PER_IP_PER_HOUR), under a key no login attempt can produce.
 *
 * Neither the address nor the IP is stored: both are HMACs keyed with
 * AUTH_SECRET, so the table is useless to anyone who reads it.
 */
export const WINDOW_MINUTES = 15;
export const MAX_FAILS_PER_EMAIL = 8;
const MAX_FAILS_PER_IP = 40;

function hmac(value: string): string {
  return crypto.createHmac("sha256", process.env.AUTH_SECRET ?? "dev-only").update(value).digest("hex");
}

export const emailKey = (email: string) => hmac(`email:${email.trim().toLowerCase()}`);
export const ipKey = (ip: string | null) => (ip ? hmac(`ip:${ip}`) : null);
/** The key a signup is counted under: its network address, with its own prefix. */
export const signupKey = (ip: string) => hmac(`signup-ip:${ip}`);

/** First address in X-Forwarded-For (set by Vercel), else null. */
export function clientIp(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || null;
  return headers.get("x-real-ip");
}

async function failureCounts(email: string, ip: string | null, now: Date): Promise<{ byEmail: number; byIp: number }> {
  const since = new Date(now.getTime() - WINDOW_MINUTES * 60_000);
  const ipHash = ipKey(ip);
  const [byEmail, byIp] = await Promise.all([
    prisma.loginAttempt.count({ where: { emailHash: emailKey(email), success: false, createdAt: { gte: since } } }),
    ipHash ? prisma.loginAttempt.count({ where: { ipHash, success: false, createdAt: { gte: since } } }) : 0,
  ]);
  return { byEmail, byIp };
}

/** True when the address or the network address has used up its failed attempts. */
export async function isLockedOut(email: string, ip: string | null, now: Date = new Date()): Promise<boolean> {
  const { byEmail, byIp } = await failureCounts(email, ip, now);
  return byEmail >= MAX_FAILS_PER_EMAIL || byIp >= MAX_FAILS_PER_IP;
}

export type LoginAttemptStart = { locked: true } | { locked: false; attemptId: string | null };

/**
 * Call before checking the password. Writes this attempt as a failure, then
 * counts with it included: locked when the failures before it already
 * reached the limit, in which case its row is removed again (a refused
 * request isn't a guess). Otherwise pass the id to finishLoginAttempt.
 * Because the row exists before the count, requests sent at once can't all
 * pass: the ninth to count always sees nine.
 */
export async function startLoginAttempt(email: string, ip: string | null, now: Date = new Date()): Promise<LoginAttemptStart> {
  let attemptId: string | null = null;
  try {
    const row = await prisma.loginAttempt.create({ data: { emailHash: emailKey(email), ipHash: ipKey(ip), success: false } });
    attemptId = row.id;
  } catch (err) {
    // Throttling must never break signing in; the count below still applies.
    console.error("login throttle: could not record attempt:", err instanceof Error ? err.message : "Unknown error");
  }
  const { byEmail, byIp } = await failureCounts(email, ip, now);
  const own = attemptId ? 1 : 0;
  const ownIp = attemptId && ip ? 1 : 0;
  if (byEmail - own >= MAX_FAILS_PER_EMAIL || byIp - ownIp >= MAX_FAILS_PER_IP) {
    if (attemptId) await prisma.loginAttempt.delete({ where: { id: attemptId } }).catch(() => {});
    return { locked: true };
  }
  return { locked: false, attemptId };
}

/** After the password check: a right password turns the attempt into a success. A wrong one stays a failure. */
export async function finishLoginAttempt(attemptId: string | null, success: boolean): Promise<void> {
  if (!success || !attemptId) return;
  try {
    await prisma.loginAttempt.update({ where: { id: attemptId }, data: { success: true } });
  } catch (err) {
    console.error("login throttle: could not record success:", err instanceof Error ? err.message : "Unknown error");
  }
}

export async function recordLoginAttempt(email: string, ip: string | null, success: boolean): Promise<void> {
  try {
    await prisma.loginAttempt.create({ data: { emailHash: emailKey(email), ipHash: ipKey(ip), success } });
  } catch (err) {
    // Throttling must never break signing in.
    console.error("login throttle: could not record attempt:", err instanceof Error ? err.message : "Unknown error");
  }
}

/**
 * Forgets an address's failed sign-ins, after a password reset proved the
 * mailbox is theirs. Never throws: the reset has already happened.
 */
export async function clearFailedLogins(email: string): Promise<void> {
  try {
    await prisma.loginAttempt.deleteMany({ where: { emailHash: emailKey(email), success: false } });
  } catch (err) {
    console.error("login throttle: could not clear attempts:", err instanceof Error ? err.message : "Unknown error");
  }
}

// ---------------------------------------------------------------------------
// Signups
// ---------------------------------------------------------------------------

/**
 * Accounts one network address can create in an hour. Each signup sends a
 * verification email to whatever address was typed, so without a limit a
 * script could use the form to mail anyone. An office signing up a few
 * people stays well under it.
 */
export const SIGNUPS_PER_IP_PER_HOUR = 5;

export type SignupSlot = { ok: true; slotId: string | null } | { ok: false };

/**
 * Takes one of this network address's signups for the hour, before the
 * signup does anything slow. The row is written first and the count includes
 * it, so signups sent at once can't all see room: past the limit the row is
 * removed and the signup refused. Stored as a successful attempt with no
 * ipHash, so it never counts toward a sign-in lockout. Without an address,
 * or if the database can't be reached, the signup goes ahead (a blip must
 * not stop real signups).
 */
export async function claimSignupSlot(ip: string | null, now: Date = new Date()): Promise<SignupSlot> {
  if (!ip) return { ok: true, slotId: null };
  let slotId: string | null = null;
  try {
    const row = await prisma.loginAttempt.create({ data: { emailHash: signupKey(ip), ipHash: null, success: true } });
    slotId = row.id;
    const since = new Date(now.getTime() - 3_600_000);
    const used = await prisma.loginAttempt.count({ where: { emailHash: signupKey(ip), createdAt: { gte: since } } });
    if (used > SIGNUPS_PER_IP_PER_HOUR) {
      await releaseSignupSlot(slotId);
      return { ok: false };
    }
    return { ok: true, slotId };
  } catch (err) {
    console.error("signup throttle: could not count signups:", err instanceof Error ? err.message : "Unknown error");
    return { ok: true, slotId };
  }
}

/** Gives a signup's place back, for one that created no account (so sent no email). Never throws. */
export async function releaseSignupSlot(slotId: string | null): Promise<void> {
  if (!slotId) return;
  await prisma.loginAttempt.delete({ where: { id: slotId } }).catch(() => {});
}

export async function purgeOldLoginAttempts(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60_000);
  const result = await prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return result.count;
}
