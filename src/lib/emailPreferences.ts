import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { appUrl } from "@/lib/email/templates";
import { linkSigningKey } from "@/lib/email/signing";

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
    .createHmac("sha256", linkSigningKey())
    .update(`tips-unsub:${userId}`)
    .digest("base64url")
    .slice(0, 32);
}

/** The signed link that turns tips and reminders off for this login. */
export function tipsUnsubscribeUrl(userId: string): string {
  return appUrl(`/api/email/tips-off?u=${encodeURIComponent(userId)}&t=${sig(userId)}`);
}

export function verifyTipsToken(userId: string, token: string): boolean {
  let expected: string;
  try {
    expected = sig(userId);
  } catch {
    // No signing key in production: no link can be trusted.
    return false;
  }
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

/** The Settings fields an unsubscribe link or another login can change while the page is open. */
export interface EmailListSettings {
  emailEnabled: boolean;
  emailRecipients: string[];
  alertsEnabled: boolean;
}

/** What a Settings save says when those fields changed after the page was opened. */
export const STALE_SETTINGS_MESSAGE = "These settings changed since you opened this page. Reload to see the latest, then save again.";

const sameList = (a: string[], b: string[]) => {
  const norm = (l: string[]) => Array.from(new Set(l.map((e) => e.trim().toLowerCase()).filter(Boolean))).sort().join("\n");
  return norm(a) === norm(b);
};

const sameSettings = (a: EmailListSettings, b: EmailListSettings) =>
  a.emailEnabled === b.emailEnabled && a.alertsEnabled === b.alertsEnabled && sameList(a.emailRecipients, b.emailRecipients);

/**
 * Whether a Settings save would undo a change made after the page was
 * opened. The recipient list and the on and off switches are saved whole,
 * so a page opened before a recipient pressed "Stop getting this email"
 * put the address back, and the brief back on, when the owner saved a
 * target margin. Stale when what the page loaded differs from what is
 * stored now and the save would change what is stored. Order and case in
 * the list don't count. Pure.
 */
export function staleEmailSettings(loaded: EmailListSettings, current: EmailListSettings, submitted: EmailListSettings): boolean {
  return !sameSettings(loaded, current) && !sameSettings(submitted, current);
}

/** The loaded values a Settings form sent, or null when it sent none (a page from before this check). */
export function loadedEmailSettings(body: unknown): EmailListSettings | null {
  const l = (body as { loaded?: Record<string, unknown> } | null)?.loaded;
  if (!l || typeof l !== "object") return null;
  if (typeof l.emailEnabled !== "boolean" || typeof l.alertsEnabled !== "boolean" || !Array.isArray(l.emailRecipients)) return null;
  return {
    emailEnabled: l.emailEnabled,
    alertsEnabled: l.alertsEnabled,
    emailRecipients: l.emailRecipients.filter((e): e is string => typeof e === "string"),
  };
}
