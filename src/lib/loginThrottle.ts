import crypto from "crypto";
import { prisma } from "./prisma";

/**
 * Login rate limiting, backed by the database so it holds across every
 * serverless instance.
 *
 *   - 8 failed attempts on one email address in 15 minutes locks that
 *     address out for the rest of the window (slows password guessing
 *     against one account).
 *   - 40 failed attempts from one IP address in 15 minutes locks that IP
 *     out (slows spraying one password across many accounts).
 *
 * Neither the address nor the IP is stored: both are HMACs keyed with
 * AUTH_SECRET, so the table is useless to anyone who reads it.
 */
export const WINDOW_MINUTES = 15;
const MAX_FAILS_PER_EMAIL = 8;
const MAX_FAILS_PER_IP = 40;

function hmac(value: string): string {
  return crypto.createHmac("sha256", process.env.AUTH_SECRET ?? "dev-only").update(value).digest("hex");
}

export const emailKey = (email: string) => hmac(`email:${email.trim().toLowerCase()}`);
export const ipKey = (ip: string | null) => (ip ? hmac(`ip:${ip}`) : null);

/** First address in X-Forwarded-For (set by Vercel), else null. */
export function clientIp(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || null;
  return headers.get("x-real-ip");
}

export async function isLockedOut(email: string, ip: string | null, now: Date = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - WINDOW_MINUTES * 60_000);
  const byEmail = await prisma.loginAttempt.count({
    where: { emailHash: emailKey(email), success: false, createdAt: { gte: since } },
  });
  if (byEmail >= MAX_FAILS_PER_EMAIL) return true;
  const ipHash = ipKey(ip);
  if (!ipHash) return false;
  const byIp = await prisma.loginAttempt.count({
    where: { ipHash, success: false, createdAt: { gte: since } },
  });
  return byIp >= MAX_FAILS_PER_IP;
}

export async function recordLoginAttempt(email: string, ip: string | null, success: boolean): Promise<void> {
  try {
    await prisma.loginAttempt.create({ data: { emailHash: emailKey(email), ipHash: ipKey(ip), success } });
  } catch (err) {
    // Throttling must never break signing in.
    console.error("login throttle: could not record attempt:", err instanceof Error ? err.message : "Unknown error");
  }
}

export async function purgeOldLoginAttempts(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60_000);
  const result = await prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return result.count;
}
