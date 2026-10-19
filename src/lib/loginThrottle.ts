import crypto from "crypto";
import { prisma } from "./prisma";

/**
 * Login rate limiting, backed by the database so it holds across every
 * serverless instance.
 *
 *   - 8 failed attempts on one email address in 15 minutes locks that
 *     address out for the rest of the window (slows password guessing
 *     against one account). A correct password from a network address with
 *     no failed attempts in the window still gets in, so a stranger typing
 *     wrong passwords can't keep the real customer out; each such address
 *     gets one try before it is locked too, and past MAX_FAILS_PER_EMAIL_HARD
 *     (guessing from many machines) nobody gets in until the window passes.
 *   - 40 failed attempts from one IP address in 15 minutes locks that IP
 *     out (slows spraying one password across many accounts).
 *   - A successful password reset clears the address's failed attempts.
 *
 * The same table also counts signups per network address (SIGNUPS_PER_IP_PER_HOUR),
 * under a key no login attempt can produce.
 *
 * Neither the address nor the IP is stored: both are HMACs keyed with
 * AUTH_SECRET, so the table is useless to anyone who reads it.
 */
export const WINDOW_MINUTES = 15;
const MAX_FAILS_PER_EMAIL = 8;
const MAX_FAILS_PER_EMAIL_HARD = 30;
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

/**
 * Where a sign-in stands before the password is checked:
 *   "open"         check the password as usual;
 *   "correct_only" the address is locked but this network address has no
 *                  recent failures: only a correct password gets in, and a
 *                  wrong one is answered as locked;
 *   "locked"       refuse without checking the password.
 */
export type LoginLock = "open" | "correct_only" | "locked";

export async function loginLock(email: string, ip: string | null, now: Date = new Date()): Promise<LoginLock> {
  const since = new Date(now.getTime() - WINDOW_MINUTES * 60_000);
  const ipHash = ipKey(ip);
  const [byEmail, byIp] = await Promise.all([
    prisma.loginAttempt.count({
      where: { emailHash: emailKey(email), success: false, createdAt: { gte: since } },
    }),
    ipHash ? prisma.loginAttempt.count({ where: { ipHash, success: false, createdAt: { gte: since } } }) : 0,
  ]);
  if (byIp >= MAX_FAILS_PER_IP) return "locked";
  if (byEmail < MAX_FAILS_PER_EMAIL) return "open";
  // Without a network address there's no telling this try from the guesses.
  if (!ipHash || byIp > 0 || byEmail >= MAX_FAILS_PER_EMAIL_HARD) return "locked";
  return "correct_only";
}

/** True when a sign-in can't go ahead on any password (see loginLock). */
export async function isLockedOut(email: string, ip: string | null, now: Date = new Date()): Promise<boolean> {
  return (await loginLock(email, ip, now)) === "locked";
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

/**
 * Whether this network address has used up its signups for the hour. False
 * without an address, and if the count can't be read (a database blip must
 * not stop real signups).
 */
export async function signupLimitReached(ip: string | null, now: Date = new Date()): Promise<boolean> {
  if (!ip) return false;
  const since = new Date(now.getTime() - 3_600_000);
  try {
    const count = await prisma.loginAttempt.count({ where: { emailHash: signupKey(ip), createdAt: { gte: since } } });
    return count >= SIGNUPS_PER_IP_PER_HOUR;
  } catch (err) {
    console.error("signup throttle: could not count signups:", err instanceof Error ? err.message : "Unknown error");
    return false;
  }
}

/**
 * Counts a signup against its network address. Stored as a successful
 * attempt with no ipHash, so it never counts toward any sign-in lockout.
 * Never throws: a signup must not fail over this.
 */
export async function recordSignup(ip: string | null): Promise<void> {
  if (!ip) return;
  try {
    await prisma.loginAttempt.create({ data: { emailHash: signupKey(ip), ipHash: null, success: true } });
  } catch (err) {
    console.error("signup throttle: could not record signup:", err instanceof Error ? err.message : "Unknown error");
  }
}

export async function purgeOldLoginAttempts(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60_000);
  const result = await prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return result.count;
}
