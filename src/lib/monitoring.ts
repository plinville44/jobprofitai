/**
 * Error and cron monitoring through Sentry, over plain HTTPS.
 *
 * No Sentry SDK: this talks to Sentry's envelope endpoint with fetch, so the
 * app takes on no new dependency, and every field that leaves the app is
 * written out below where it can be read and tested.
 *
 * Privacy comes first. The app holds contractors' QuickBooks books and
 * tokens, so an error report carries only:
 *  - the kind of error (its class name),
 *  - its message, scrubbed of email addresses, tokens, long IDs, quoted
 *    text, amounts and URL query strings (scrubText), and cut to 500
 *    characters; for database errors, only the error code and the call,
 *  - where in the code it happened (function, file, line and column),
 *  - a few tags from an allow-list: the route's path pattern (never the real
 *    URL), the HTTP method, the route type, the cron job's name and the
 *    feature that failed (such as brief-summary),
 *  - the environment and the commit it was built from.
 * Never a user, the request (URL, query string, headers, cookies, body), the
 * error's `cause`, or any other data attached to it.
 *
 * Nothing is sent unless SENTRY_DSN is set, and nothing from Vercel preview
 * or development deployments (VERCEL_ENV other than "production"). Sending
 * never throws and gives up after about two seconds, so a Sentry outage can
 * never break a page, a route or a scheduled job.
 */

import { describeError, safeErrorText, scrubText } from "./scrub";

// Re-exported so existing imports keep working; the scrubbing itself lives in src/lib/scrub.ts.
export { safeErrorText, scrubText };

/** Where envelopes go, worked out from the DSN. */
export interface ParsedDsn {
  publicKey: string;
  host: string;
  projectId: string;
  envelopeUrl: string;
}

/** The only things a report may be tagged with. */
export interface ErrorContext {
  /** The route's path pattern, such as /dashboard/jobs/[jobId]. Never the real URL. */
  route?: string;
  method?: string;
  /** Next.js's route type: render, route, action, middleware or proxy. */
  routeType?: string;
  /** Next.js's router: App Router or Pages Router. */
  router?: string;
  /** The scheduled job, such as nightly-sync. */
  cron?: string;
  /** The feature that failed, such as brief-summary: what the report is about, in a word or two. */
  feature?: string;
}

export interface SentryFrame {
  function: string;
  filename: string;
  lineno: number;
  colno: number;
  in_app: boolean;
}

export interface SentryEvent {
  event_id: string;
  timestamp: number;
  platform: "node";
  level: "error";
  environment: string;
  release?: string;
  exception: { values: { type: string; value: string; stacktrace?: { frames: SentryFrame[] } }[] };
  tags: Record<string, string>;
}

export type CheckInStatus = "ok" | "error";

export interface SentryCheckIn {
  check_in_id: string;
  monitor_slug: string;
  status: CheckInStatus;
  environment: string;
  release?: string;
  duration?: number;
  monitor_config?: {
    schedule: { type: "crontab"; value: string };
    checkin_margin: number;
    timezone: string;
  };
}

export type ReportResult =
  | { sent: false; reason: "no_dsn" | "not_production" | "rate_limited" | "failed" }
  /** status: Sentry's HTTP status, or null when it didn't answer in time or the request failed. */
  | { sent: true; status: number | null };

type Env = Record<string, string | undefined>;

/** How long a send may take before it's given up on. */
export const SEND_TIMEOUT_MS = 2_000;
/**
 * Error reports per server instance per minute. A fault that hits every
 * company in a nightly run (a few hundred) would otherwise use up a month of
 * Sentry's quota in a day; the first few say all there is to say.
 */
const MAX_REPORTS_PER_MINUTE = 20;
/**
 * How late a scheduled job's check-in may arrive before Sentry calls the run
 * missed. A run checks in when it ends, so this covers the platform's 300 s
 * limit on a run plus a late start.
 */
export const CHECKIN_MARGIN_MINUTES = 10;

/**
 * Reads a DSN of the form https://<publicKey>@<host>/<projectId> (a path
 * before the project ID, used by self-hosted Sentry, is kept). Null for a
 * missing or malformed one, and for one that isn't HTTPS.
 */
export function parseDsn(dsn: string | null | undefined): ParsedDsn | null {
  if (typeof dsn !== "string" || dsn.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(dsn.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.username || !url.host) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const projectId = parts.pop();
  if (!projectId || !/^\d+$/.test(projectId)) return null;
  if (!/^[A-Za-z0-9]+$/.test(url.username)) return null;
  const prefix = parts.length ? `/${parts.join("/")}` : "";
  return {
    publicKey: url.username,
    host: url.host,
    projectId,
    envelopeUrl: `https://${url.host}${prefix}/api/${projectId}/envelope/`,
  };
}

const FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;

/**
 * Frames from a V8 stack trace, oldest call first as Sentry expects (V8
 * lists the newest first). Only the "at ..." lines are read: the stack's
 * first line repeats the unscrubbed message. A filename keeps nothing after
 * "?" or "#".
 */
export function parseStack(stack: string | undefined): SentryFrame[] {
  if (!stack) return [];
  const frames: SentryFrame[] = [];
  for (const line of stack.split("\n")) {
    if (!/^\s*at /.test(line)) continue;
    const m = FRAME.exec(line);
    if (!m) continue;
    const filename = m[2].split(/[?#]/)[0].slice(0, 300);
    const fn = (m[1] ?? "").replace(/^async /, "").slice(0, 200);
    frames.push({
      function: fn || "?",
      filename,
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !/node_modules|^node:|^internal[/:]/.test(filename),
    });
  }
  return frames.slice(0, 50).reverse();
}

function tagValue(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return pattern.test(v) ? v : undefined;
}

/** Only the allow-listed tags, each checked for shape, whatever else the caller passed. */
function pickTags(context: ErrorContext | undefined): Record<string, string> {
  const c = context ?? {};
  const route = typeof c.route === "string" ? scrubText(c.route.split(/[?#]/)[0]).slice(0, 200).trim() : "";
  const tags: Record<string, string | undefined> = {
    route: route || undefined,
    method: tagValue(typeof c.method === "string" ? c.method.toUpperCase() : undefined, /^[A-Z]{3,10}$/),
    route_type: tagValue(c.routeType, /^[a-z][a-z-]{0,19}$/),
    router: tagValue(c.router, /^[A-Za-z ]{1,20}$/),
    cron: tagValue(c.cron, /^[a-z0-9-]{1,50}$/),
    feature: tagValue(c.feature, /^[a-z0-9-]{1,50}$/),
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) if (v) out[k] = v;
  return out;
}

function environmentOf(env: Env): string {
  return env.VERCEL_ENV || env.NODE_ENV || "development";
}

function releaseOf(env: Env): string | undefined {
  const sha = env.VERCEL_GIT_COMMIT_SHA;
  return sha && /^[\w.-]{1,200}$/.test(sha) ? sha : undefined;
}

/** Not from Vercel preview or development deployments. Outside Vercel, only the DSN decides. */
function productionOnly(env: Env): boolean {
  return !env.VERCEL_ENV || env.VERCEL_ENV === "production";
}

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  let id = "";
  for (let i = 0; i < 32; i++) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

/**
 * The Sentry event for an error. Pure apart from its defaults (the
 * environment variables, the clock and a random ID), which tests pass in.
 */
export function buildErrorEvent(
  err: unknown,
  context: ErrorContext = {},
  opts: { env?: Env; now?: number; eventId?: string } = {}
): SentryEvent {
  const env = opts.env ?? process.env;
  const { type, value, stack } = describeError(err);
  const frames = parseStack(stack);
  const release = releaseOf(env);
  return {
    event_id: opts.eventId ?? newId(),
    timestamp: (opts.now ?? Date.now()) / 1000,
    platform: "node",
    level: "error",
    environment: environmentOf(env),
    ...(release ? { release } : {}),
    exception: { values: [{ type, value, ...(frames.length ? { stacktrace: { frames } } : {}) }] },
    tags: pickTags(context),
  };
}

/** An envelope: a header line, then an item header line and its payload for each item. */
function envelope(header: Record<string, unknown>, itemType: string, payload: unknown): string {
  return `${JSON.stringify(header)}\n${JSON.stringify({ type: itemType })}\n${JSON.stringify(payload)}\n`;
}

export function errorEnvelope(event: SentryEvent, now: number = Date.now()): string {
  return envelope({ event_id: event.event_id, sent_at: new Date(now).toISOString() }, "event", event);
}

/**
 * A check-in envelope. Follows Sentry's documented check_in item (the shape
 * its own SDKs send: an item header of {"type":"check_in"} and a payload
 * with check_in_id, monitor_slug, status, duration in seconds, environment,
 * release and monitor_config). Sentry accepted this shape in production on
 * September 30, 2026: the nightly-sync monitor was created from it and its
 * runs show as ok.
 */
export function checkInEnvelope(checkIn: SentryCheckIn, now: number = Date.now()): string {
  return envelope({ sent_at: new Date(now).toISOString() }, "check_in", checkIn);
}

export function authHeader(dsn: ParsedDsn): string {
  return `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=jobprofitai-monitoring/1.0`;
}

/**
 * Posts an envelope. Resolves to Sentry's HTTP status, or null when it
 * didn't answer within the time limit or the request failed. Never throws.
 */
export async function sendEnvelope(dsn: ParsedDsn, body: string, timeoutMs: number = SEND_TIMEOUT_MS): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    const request = fetch(dsn.envelopeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": authHeader(dsn) },
      body,
      signal: controller.signal,
    }).then(
      (res) => {
        discardBody(res);
        return res.status;
      },
      () => null
    );
    // Raced as well as aborted, so a fetch that ignores the signal still can't hold anything up.
    return await Promise.race([request, timedOut]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The reply is a tiny JSON id that nothing reads: cancelled so the connection is freed. */
function discardBody(res: Response): void {
  try {
    res.body?.cancel().catch(() => {});
  } catch {
    // Nothing to free.
  }
}

let windowStart = 0;
let reportsInWindow = 0;

function takeReportSlot(now: number): boolean {
  if (now - windowStart >= 60_000) {
    windowStart = now;
    reportsInWindow = 0;
  }
  if (reportsInWindow >= MAX_REPORTS_PER_MINUTE) return false;
  reportsInWindow++;
  return true;
}

/** For tests: forgets the reports counted toward this minute's limit. */
export function resetReportLimit(): void {
  windowStart = 0;
  reportsInWindow = 0;
}

/**
 * Sends an error to Sentry. Does nothing without SENTRY_DSN, or on a Vercel
 * deployment other than production unless `anyEnvironment` (the admin test
 * route) says so. Never throws. With `occurrences` above 1, the report says
 * how many times the error happened (see RunErrors).
 */
export async function reportError(
  err: unknown,
  context: ErrorContext = {},
  options: { anyEnvironment?: boolean; occurrences?: number } = {}
): Promise<ReportResult> {
  try {
    const env: Env = process.env;
    const dsn = parseDsn(env.SENTRY_DSN);
    if (!dsn) return { sent: false, reason: "no_dsn" };
    if (!options.anyEnvironment && !productionOnly(env)) return { sent: false, reason: "not_production" };
    if (!takeReportSlot(Date.now())) return { sent: false, reason: "rate_limited" };
    const event = withOccurrences(buildErrorEvent(err, context, { env }), options.occurrences);
    const status = await sendEnvelope(dsn, errorEnvelope(event));
    return { sent: true, status };
  } catch {
    return { sent: false, reason: "failed" };
  }
}

/** The event with how many times it happened put in front of its message, when more than once. Pure. */
export function withOccurrences(event: SentryEvent, occurrences: number | undefined): SentryEvent {
  if (occurrences == null || !(occurrences > 1)) return event;
  const [first, ...rest] = event.exception.values;
  const value = `${Math.round(occurrences)} times in this run, one report for all of them. The first: ${first.value}`;
  return { ...event, exception: { values: [{ ...first, value }, ...rest] } };
}

/**
 * A scheduled run's unexpected errors, sent as one report per kind of error
 * with how many times it happened, once the run is done, the way the weekly
 * brief run reports its problems (briefRunReports). Each company's error
 * used to be its own report, so a fault that hit every company in a run
 * used up the 20 reports a minute on one instance, and other faults in that
 * minute weren't reported (audit Oct 27, E9). A kind is the error's class
 * and its scrubbed message, which takes out what differs from one company
 * to the next (IDs, amounts), and without the Stripe IDs the scrub keeps,
 * so "No such subscription" for two subscriptions is one kind. Each kind's
 * first error is the one sent, so the report keeps its stack. At most
 * MAX_KINDS reports, the commonest.
 */
/** A Stripe object ID (sub_..., cus_..., evt_...), which the scrub keeps as a reference. */
const STRIPE_ID = /\b[a-z]{2,5}_(?:(?:live|test)_)?[A-Za-z0-9]{6,64}\b/g;

export class RunErrors {
  static readonly MAX_KINDS = 10;
  private readonly kinds = new Map<string, { err: unknown; count: number }>();

  add(err: unknown): void {
    const { type, value } = describeError(err);
    const key = `${type}\n${value.replace(STRIPE_ID, "[id]")}`;
    const seen = this.kinds.get(key);
    if (seen) seen.count++;
    else this.kinds.set(key, { err, count: 1 });
  }

  get count(): number {
    let n = 0;
    for (const k of this.kinds.values()) n += k.count;
    return n;
  }

  /** Sends the reports. Never throws. */
  async report(context: ErrorContext): Promise<void> {
    const commonest = [...this.kinds.values()].sort((a, b) => b.count - a.count).slice(0, RunErrors.MAX_KINDS);
    await Promise.all(commonest.map(({ err, count }) => reportError(err, context, { occurrences: count })));
  }
}

async function sendCheckIn(checkIn: Omit<SentryCheckIn, "environment" | "release">): Promise<void> {
  try {
    const env: Env = process.env;
    const dsn = parseDsn(env.SENTRY_DSN);
    if (!dsn || !productionOnly(env)) return;
    const release = releaseOf(env);
    await sendEnvelope(dsn, checkInEnvelope({ ...checkIn, environment: environmentOf(env), ...(release ? { release } : {}) }));
  } catch {
    // Monitoring never affects the job.
  }
}

/** A Response (or anything shaped like one) with a 5xx status. */
function isFailedResponse(result: unknown): boolean {
  if (result === null || typeof result !== "object") return false;
  const status = (result as { status?: unknown }).status;
  return typeof status === "number" && status >= 500;
}

/**
 * Runs a scheduled job and tells Sentry's cron monitoring how it went, with
 * one check-in when the job ends: "ok", or "error" when the job throws or
 * returns a response with a 5xx status, with how long it took. Every
 * check-in carries the schedule (UTC), so Sentry creates the monitor from
 * whichever one it sees first.
 *
 * One check-in, not "in progress" at the start and another at the end.
 * Sentry can take in two check-ins sent a fraction of a second apart in
 * either order, and a run with nothing to do (most weekly-email runs) ends
 * that quickly. On September 30, 2026, weekly-email's first production run
 * did: its "ok" reached Sentry before the "in progress" that creates the
 * monitor, was dropped as "Monitor not found", and Sentry then reported the
 * run, which had finished, as timed out. A single check-in can't arrive out
 * of order. A run the platform cuts off sends nothing, and Sentry reports it
 * as missed once CHECKIN_MARGIN_MINUTES have passed, so a run that never
 * finishes is still reported.
 *
 * The job's result is returned unchanged and its error rethrown unchanged.
 */
export async function withCronMonitor<T>(slug: string, schedule: string, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const checkIn = (status: CheckInStatus) =>
    sendCheckIn({
      check_in_id: newId(),
      monitor_slug: slug,
      status,
      duration: Math.round(Date.now() - startedAt) / 1000,
      monitor_config: {
        schedule: { type: "crontab", value: schedule },
        checkin_margin: CHECKIN_MARGIN_MINUTES,
        timezone: "UTC",
      },
    });
  let result: T;
  try {
    result = await run();
  } catch (err) {
    await checkIn("error");
    throw err;
  }
  await checkIn(isFailedResponse(result) ? "error" : "ok");
  return result;
}

/**
 * Faults in our own code or the database, as opposed to QuickBooks' errors.
 * For a cron job's sync step, whose failures are mostly QuickBooks' (a
 * reconnect needed, an outage, a refused request), are recorded on the
 * company and are retried on a later run: only these are worth a report.
 * "fetch failed" is a TypeError too, but it's the network to QuickBooks.
 */
export function isCodeOrDatabaseFault(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name.startsWith("PrismaClient")) return true;
  if (err instanceof TypeError) return err.message !== "fetch failed";
  return err instanceof ReferenceError || err instanceof RangeError;
}
