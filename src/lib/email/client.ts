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
 * How long a send waits for Resend's answer. The v3 SDK has no timeout of
 * its own, so a stalled request held its route until the platform cut it
 * off at 300 seconds, taking every other send in that run with it (audit
 * Oct 27, E1). Resend normally answers in well under a second.
 */
export const SEND_TIMEOUT_MS = 10_000;
/** How much longer the fallback race waits than the abort (see sendEmail). */
const RACE_GRACE_MS = 2_000;
const NO_ANSWER = `No answer from the email provider within ${SEND_TIMEOUT_MS / 1000} seconds.`;

/**
 * A send's record while Resend is being asked (see sendLifecycleEmail). A
 * record still "sending" this long after it was written belongs to a run
 * that was cut off before it heard back, so it's treated as not sent and
 * the next run sends it. Every route has a 300 second limit and a send
 * gives up after SEND_TIMEOUT_MS, so no live run is still waiting on one.
 */
export const SENDING = "sending";
export const SENDING_STALE_MS = 15 * 60_000;

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
  /** Extra headers, e.g. List-Unsubscribe on the weekly brief. */
  headers?: Record<string, string>;
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  error?: string;
  /** True when email isn't configured in this environment (not a failure). */
  skipped?: boolean;
  /**
   * True when the failure was on the sending side (the provider down, busy
   * or over a quota, or the network), so sending again later can work and
   * the failure says nothing about the address. False for a rejected
   * message or address. The weekly brief doesn't count these against a
   * company's attempts.
   */
  transient?: boolean;
  /**
   * True when the failure was about our own sending setup, not the message
   * or the address: the sending domain or from address isn't accepted, or
   * the API key is missing, wrong or not allowed to send. Every recipient
   * fails the same way until someone fixes it, so the weekly brief doesn't
   * count these against a company's attempts, and they are reported.
   */
  senderSide?: boolean;
}

/**
 * Resend error names that mean "try again later" rather than "this message
 * or address was refused". Names from Resend's API documentation; which
 * ones Resend actually returns in each case is not verified here.
 */
const TRANSIENT_ERRORS = new Set([
  "rate_limit_exceeded",
  "daily_quota_exceeded",
  "monthly_quota_exceeded",
  "application_error",
  "internal_server_error",
  "concurrent_idempotent_requests",
]);

/** Resend error names that are about our account or key, whatever the message. */
const SENDER_ERRORS = new Set(["missing_api_key", "invalid_api_key", "restricted_api_key", "invalid_access", "invalid_from_address"]);

/**
 * Whether a refusal is about our sending setup (see SendEmailResult.senderSide).
 * Resend reports an unverified sending domain, a test key used for someone
 * else's address and a malformed from address as a validation_error, so for
 * that name the message decides. A bad recipient ("Invalid `to` field") is
 * not one.
 */
export function senderSideError(name: string | null | undefined, message: string | null | undefined): boolean {
  if (name && SENDER_ERRORS.has(name)) return true;
  return name === "validation_error" && /domain is not verified|verify a domain|`from`|from field|from address|testing emails|api key/i.test(message ?? "");
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
    return { ok: false, skipped: true, senderSide: true, error: "RESEND_API_KEY is not configured." };
  }

  // Second development safeguard: EMAIL_DEV_REDIRECT sends every message to
  // one inbox instead of real customers. Intended for preview environments
  // pointed at a copy of production data - without it, testing the trial
  // cron against real rows would email real people.
  const redirect = process.env.EMAIL_DEV_REDIRECT?.trim();
  const to = redirect ? [redirect] : Array.isArray(input.to) ? input.to : [input.to];

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resend = new Resend(apiKey);
    // Aborted at SEND_TIMEOUT_MS. The 3.5.0 SDK's typed options are only a
    // query string, but its post() spreads the options object into fetch's
    // own options, so a signal passed there reaches fetch, and an aborted
    // request comes back as an application_error, which is a failure worth
    // retrying (TRANSIENT_ERRORS). Only the signal is passed: headers there
    // would replace the SDK's own, Authorization included. The race stays
    // as well, in case an SDK change stops the signal getting through.
    // Whether a request cut off this way reached Resend is unknown, so it's
    // retried like a dropped connection, and could arrive twice; the abort
    // makes one that answers late much rarer (review of audit Oct 27). The
    // race gives the abort a moment to land first.
    const signal = AbortSignal.timeout(SEND_TIMEOUT_MS);
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(NO_ANSWER)), SEND_TIMEOUT_MS + RACE_GRACE_MS);
    });
    const { data, error } = await Promise.race([timedOut, resend.emails.send({
      from: fromAddress(),
      to,
      subject: redirect ? `[dev->${asString(input.to)}] ${input.subject}` : input.subject,
      html: input.html,
      text: input.text,
      // snake_case on purpose. Resend renamed this option between SDK
      // majors: v3's CreateEmailOptions calls it `reply_to`, v4 calls it
      // `replyTo`. package.json pins ^3.5.0, so `reply_to` is the name the
      // installed SDK accepts. Our own SendEmailInput keeps the camelCase
      // `replyTo` so callers aren't exposed to the provider's spelling, and
      // this is the single line that has to change on a Resend upgrade.
      reply_to: input.replyTo ?? SUPPORT_EMAIL,
      tags: input.tags,
      ...(input.headers ? { headers: input.headers } : {}),
    }, { signal } as never)]);

    if (error) {
      // The SDK reports our abort as "Unable to fetch data": say what happened.
      const message = signal.aborted ? NO_ANSWER : error.message;
      // Message only - never the whole provider error object, which can echo
      // request contents back into logs.
      console.error(`email: send failed for "${input.subject}": ${message}`);
      return {
        ok: false,
        error: message,
        transient: error.name != null && TRANSIENT_ERRORS.has(error.name),
        senderSide: senderSideError(error.name, error.message),
      };
    }
    return { ok: true, id: data?.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown email error";
    console.error(`email: send threw for "${input.subject}": ${message}`);
    // Thrown rather than returned: the request didn't get an answer.
    return { ok: false, error: message, transient: true };
  } finally {
    if (timer) clearTimeout(timer);
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

/** What claiming a key found: ours to send (the record's id), sent already, or being sent by a run that's still going. */
type Claim = { id: string } | "sent" | "in_flight";

/** Another run is sending it right now. Not sent, and worth trying again later: that run may yet fail. */
const IN_FLIGHT: SendEmailResult = { ok: false, transient: true, error: "Another run is sending this email right now." };

/**
 * A key's record found on claiming it: sent, or still "sending". One still
 * sending past SENDING_STALE_MS is taken over, conditionally, so two runs
 * can't both take it.
 */
async function claimFound(row: { id: string; status: string; sentAt: Date }): Promise<Claim> {
  if (row.status !== SENDING) return "sent";
  const now = new Date();
  const taken = await prisma.emailEvent.updateMany({
    where: { id: row.id, status: SENDING, sentAt: { lt: new Date(now.getTime() - SENDING_STALE_MS) } },
    data: { sentAt: now },
  });
  return taken.count === 1 ? { id: row.id } : "in_flight";
}

/** Claims a key by inserting its record as "sending"; see sendLifecycleEmail. */
async function claimKey(data: { userId: string | null; emailType: string; dedupeKey: string; toEmail: string; subject?: string }): Promise<Claim> {
  try {
    const claim = await prisma.emailEvent.create({ data: { ...data, status: SENDING } });
    return { id: claim.id };
  } catch (err) {
    if ((err as { code?: string })?.code !== "P2002") throw err;
  }
  const row = await prisma.emailEvent.findUnique({ where: { dedupeKey: data.dedupeKey }, select: { id: true, status: true, sentAt: true } });
  // Released a moment ago by a run whose send failed: the next run retries.
  if (!row) return "in_flight";
  return claimFound(row);
}

/**
 * Switches claimed records to "sent", once Resend has taken the email. Tried
 * twice and never thrown: the email has gone, and a record left "sending"
 * only means it may go again after SENDING_STALE_MS, not that it's lost.
 */
async function markSent(ids: string[], data: { providerMessageId: string | null; subject?: string }): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.emailEvent.updateMany({ where: { id: { in: ids } }, data: { ...data, status: "sent", sentAt: new Date() } });
      return;
    } catch (err) {
      if (attempt >= 2) {
        console.error(`email: a sent email couldn't be recorded as sent: ${err instanceof Error ? err.name : "Unknown error"}`);
        return;
      }
    }
  }
}

/**
 * Sends an email at most once per dedupeKey, ever.
 *
 * The sequence matters. The EmailEvent row is inserted FIRST, and its unique
 * dedupeKey is what claims the send - so two cron invocations racing on the
 * same user can't both get past this line. Only the winner calls Resend.
 *
 * The row is inserted as "sending" and becomes "sent" only once Resend has
 * taken the email. It used to be inserted as "sent", so a run cut off
 * between the insert and Resend's answer (the platform's 300 second limit)
 * left a record saying sent for an email that never went, and every later
 * run skipped it: that recipient never got that brief or alert (audit Oct
 * 27, E1). A record still "sending" after SENDING_STALE_MS is now taken
 * over and sent. Resend's idempotency key would make that resend safe even
 * when the first request did reach Resend, but the installed SDK (3.5.0)
 * has no option for one: emails.send sets its own request headers, and
 * headers passed through its options object replace them all, the API key
 * included. That waits for an SDK upgrade. So a send cut off after Resend
 * took it can, rarely, arrive twice; one that never went still arrives.
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

  const claim = await claimKey({
    userId: input.userId,
    emailType: input.emailType,
    dedupeKey: input.dedupeKey,
    toEmail,
    subject: input.subject,
  });
  // Already sent: exactly the intended outcome.
  if (claim === "sent") return { ok: true, skipped: true };
  if (claim === "in_flight") return IN_FLIGHT;
  const claimId = claim.id;

  const result = await sendEmail(input);

  if (result.ok) {
    await markSent([claimId], { providerMessageId: result.id ?? null });
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

export interface KeyedEmailResult extends SendEmailResult {
  /** Keys this address already had: sent before. */
  alreadySent: string[];
  /** Keys this call sent. Empty unless the send worked. */
  sentNow: string[];
  /**
   * Keys another run is sending right now: not sent yet, and that run may
   * still fail, so whoever is waiting on them tries again later rather than
   * count them as had.
   */
  inFlight: string[];
}

/**
 * One email carrying several things, each of which an address must get at
 * most once: a recipient's profit alerts, say, with one key per alert and
 * address. Keys already sent are left out, and the rest are claimed the way
 * sendLifecycleEmail claims its one key (an EmailEvent row per key, inserted
 * as "sending" before anything is sent, and taken over when it's been
 * "sending" too long), so a run that dies partway, or a second run with the
 * same things still to send, never sends one twice, and a run cut off
 * before Resend answered doesn't stop the next one sending it. A failed
 * send frees its keys for a retry. `render` builds the email from the keys
 * this call claimed; nothing is sent when there are none.
 */
export async function sendLifecycleEmailOncePerKey(input: {
  userId: string | null;
  emailType: string;
  to: string;
  keys: string[];
  render: (keys: string[]) => Omit<SendEmailInput, "to">;
}): Promise<KeyedEmailResult> {
  const keys = [...new Set(input.keys)];
  const found = await prisma.emailEvent.findMany({
    where: { dedupeKey: { in: keys } },
    select: { id: true, dedupeKey: true, status: true, sentAt: true },
  });
  const foundByKey = new Map(found.map((f) => [f.dedupeKey, f]));
  const alreadySent: string[] = [];
  const inFlight: string[] = [];

  const claims: { id: string; key: string }[] = [];
  const release = async (status: string, errorMessage: string | null, subject: string | null) => {
    for (const c of claims) {
      await prisma.emailEvent.update({
        where: { id: c.id },
        data: { dedupeKey: `failed:${c.id}:${c.key}`.slice(0, 500), status, errorMessage, ...(subject ? { subject } : {}) },
      });
    }
  };
  for (const key of keys) {
    let claim: Claim;
    try {
      const row = foundByKey.get(key);
      // Claimed by another run a moment ago: theirs to send, unless it's still "sending" long after.
      claim = row
        ? await claimFound(row)
        : await claimKey({ userId: input.userId, emailType: input.emailType, dedupeKey: key, toEmail: input.to });
    } catch (err) {
      await release("failed", err instanceof Error ? err.message : "Unknown error", null).catch(() => {});
      throw err;
    }
    if (claim === "sent") alreadySent.push(key);
    else if (claim === "in_flight") inFlight.push(key);
    else claims.push({ id: claim.id, key });
  }
  if (claims.length === 0) return { ok: true, skipped: true, alreadySent, sentNow: [], inFlight };

  const email = input.render(claims.map((c) => c.key));
  const result = await sendEmail({ ...email, to: input.to });
  if (result.ok) {
    await markSent(claims.map((c) => c.id), { subject: email.subject, providerMessageId: result.id ?? null });
    return { ...result, alreadySent, sentNow: claims.map((c) => c.key), inFlight };
  }
  // Release the keys so a later run can retry, but keep the audit rows.
  await release(result.skipped ? "skipped" : "failed", result.error ?? null, email.subject);
  return { ...result, alreadySent, sentNow: [], inFlight };
}

/** True when a lifecycle email with this dedupe key has already gone out. */
export async function hasSentLifecycleEmail(dedupeKey: string): Promise<boolean> {
  const row = await prisma.emailEvent.findUnique({ where: { dedupeKey } });
  return row != null && row.status === "sent";
}
