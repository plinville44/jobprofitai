import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { appUrl } from "@/lib/email/templates";

/**
 * Tips and reminders the customer can turn off with one click: the emails
 * whose main purpose is encouraging use of the product or asking for
 * something, rather than telling the customer about their account. Under
 * CAN-SPAM an email is judged by its main purpose, so these carry an
 * unsubscribe link and List-Unsubscribe headers. Account, security, billing
 * and trial-status emails (verification, password, receipts, payment
 * problems, "your trial ends on", "your trial has ended", data deletion
 * notices) are not in this list and keep going.
 */
export const TIPS_EMAIL_TYPES = new Set([
  "setup_reminder",
  "trial_checkin",
  "report_guide",
  "trial_ending_offer",
  "testimonial_request",
]);

function sig(userId: string): string {
  return crypto
    .createHmac("sha256", process.env.AUTH_SECRET ?? "dev-only")
    .update(`tips-unsub:${userId}`)
    .digest("base64url")
    .slice(0, 32);
}

/** The signed link that turns tips and reminders off for this login. */
export function tipsUnsubscribeUrl(userId: string): string {
  return appUrl(`/api/email/tips-off?u=${encodeURIComponent(userId)}&t=${sig(userId)}`);
}

export function verifyTipsToken(userId: string, token: string): boolean {
  const expected = sig(userId);
  if (token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export async function tipsEmailsAllowed(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { tipsEmailsOffAt: true } });
  return user != null && user.tipsEmailsOffAt == null;
}

export async function turnOffTipsEmails(userId: string): Promise<void> {
  await prisma.user.updateMany({ where: { id: userId, tipsEmailsOffAt: null }, data: { tipsEmailsOffAt: new Date() } });
}
