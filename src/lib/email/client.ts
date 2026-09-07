import { Resend } from "resend";
import { prisma } from "@/lib/prisma";

// Centralized transactional email.
//
// Two things this layer exists to get right, both of which are easy to get
// wrong with Resend specifically:
//
// 1. resend.emails.send() in the v3 SDK does NOT throw on an API error - it
//    RESOLVES with `{ data: null, error: {...} }`. Code that only wraps the
//    call in try/catch will treat a hard rejection (unverified domain,
//    invalid recipient, rate limit) as a successful send. Every send in the
//    app goes through sendEmail() below, which checks the returned error as
//    well as catching thrown ones.
//
// 2. Lifecycle emails are driven by an hourly cron that is expected to be
//    re-run and retried. "Send this once, ever" therefore has to be a
//    database guarantee, not a code path - see sendLifecycleEmail().

const DEFAULT_FROM = "JobProfitAI <noreply@jobprofitai.com>";
export const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL?.trim() || "support@jobprofitai.com";

/**
 * The verified Resend sending identity. Kept separate from SUPPORT_EMAIL so
 * the sending domain can be a no-reply address while every reply still lands
 * in the real support inbox (see replyTo below).
 */
function fromAddress(): string {
  return process.env.EMAIL_FROM?.trim() || DEFAULT_FROM;
}

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  /** Defaults to the support address so replies always reach a human. */
  replyTo?: string;
  tags?: { name: string; value: string }[];
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  error?: string;
  /** True when email isn't configured in this environment (not a failure). */
  skipped?: boolean;
}

/**
 * Low-level send. Never throws - callers get a result object, because a
 * failed notification must not take down the user action that triggered it.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Development safeguard: with no key configured, log and carry on rather
    // than crashing local work or a preview deployment.
    console.warn(`email: RESEND_API_KEY not set - skipped "${input.subject}"`);
    return { ok: false, skipped: true, error: "RESEND_API_KEY is not configured." };
  }

  // Second development safeguard: EMAIL_DEV_REDIRECT sends every message to
  // one inbox instead of real customers. Intended for preview environments
  // pointed at a copy of production data - without it, testing the trial
  // cron against real rows would email real people.
  const redirect = process.env.EMAIL_DEV_REDIRECT?.trim();
  const to = redirect ? [redirect] : Array.isArray(input.to) ? input.to : [input.to];

  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({
      from: fromAddress(),
      to,
      subject: redirect ? `[dev->${asString(input.to)}] ${input.subject}` : input.subject,
      html: input.html,
      text: input.text,
      replyTo: input.replyTo ?? SUPPORT_EMAIL,
      tags: input.tags,
    });

    if (error) {
      // Message only - never the whole provider error object, which can echo
      // request contents back into logs.
      console.error(`email: send failed for "${input.subject}": ${error.message}`);
      return { ok: false, error: error.message };
    }
    return { ok: true, id: data?.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown email error";
    console.error(`email: send threw for "${input.subject}": ${message}`);
    return { ok: false, error: message };
  }
}

function asString(to: string | string[]): string {
  return Array.isArray(to) ? to.join(", ") : to;
}

export interface LifecycleEmailInput extends SendEmailInput {
  /** Null for emails not tied to a user (e.g. contact-form confirmations). */
  userId: string | null;
  /** Stable machine name, e.g. "trial_welcome". */
  emailType: string;
  /**
   * Uniquely identifies this send. Must include the lifecycle instant it
   * belongs to, not just the user - e.g.
   * `trial_ending_soon:<userId>:<trialEndsAt ISO>` so that extending a trial
   * legitimately allows a second "ending soon" email for the NEW date, while
   * an hourly cron re-run for the same date sends nothing.
   */
  dedupeKey: string;
}

/**
 * Sends an email at most once per dedupeKey, ever.
 *
 * The sequence matters. The EmailEvent row is inserted FIRST, and its unique
 * dedupeKey is what claims the send - so two cron invocations racing on the
 * same user can't both get past this line. Only the winner calls Resend.
 *
 * On failure the claim is released rather than deleted: the row is rewritten
 * with a one-off `failed:` key and status "failed". That keeps the failure in
 * the audit trail (so a delivery problem is visible, per the requirement to
 * log failed delivery attempts) while freeing the original key so the next
 * cron run legitimately retries. A permanently-claimed key would mean one
 * transient Resend blip silently costs a customer their trial-ending email.
 */
export async function sendLifecycleEmail(input: LifecycleEmailInput): Promise<SendEmailResult> {
  const toEmail = asString(input.to);

  let claimId: string;
  try {
    const claim = await prisma.emailEvent.create({
      data: {
        userId: input.userId,
        emailType: input.emailType,
        dedupeKey: input.dedupeKey,
        toEmail,
        subject: input.subject,
        status: "sent",
      },
    });
    claimId = claim.id;
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      // Already sent (or in flight) - exactly the intended outcome.
      return { ok: true, skipped: true };
    }
    throw err;
  }

  const result = await sendEmail(input);

  if (result.ok) {
    await prisma.emailEvent.update({
      where: { id: claimId },
      data: { providerMessageId: result.id ?? null },
    });
    return result;
  }

  // Release the key so a later run can retry, but keep the audit row.
  await prisma.emailEvent.update({
    where: { id: claimId },
    data: {
      dedupeKey: `failed:${claimId}:${input.dedupeKey}`.slice(0, 500),
      status: result.skipped ? "skipped" : "failed",
      errorMessage: result.error ?? null,
    },
  });

  return result;
}

/** True when a lifecycle email with this dedupe key has already gone out. */
export async function hasSentLifecycleEmail(dedupeKey: string): Promise<boolean> {
  const row = await prisma.emailEvent.findUnique({ where: { dedupeKey } });
  return row != null && row.status === "sent";
}
