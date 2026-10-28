/**
 * Small rules the weekly brief job (api/cron/weekly-email) and the nightly
 * job's alert emails (api/cron/nightly-sync) decide by, kept here so they
 * can be tested: a route file may only export its handlers.
 */

import { publicErrorMessage } from "./publicError";
import { CATCH_UP_HOURS, lastScheduledSend, isValidTimeZone, withinCatchUp } from "./schedule";
import { FULL_SYNC_PARTWAY_FIRST_AT } from "./syncProblem";

/** A sync "in progress" for longer than this was cut off. The sync itself uses the same limit (STALE_SYNC_MINUTES). */
export const STALE_SYNC_MS = 10 * 60_000;

/** A sync that failed, or that has said "in progress" too long to still be running. */
export function syncLooksFailed(
  c: { lastSyncStatus: string | null; lastSyncAttemptAt: Date | null },
  now: number
): boolean {
  if (c.lastSyncStatus === "error") return true;
  return c.lastSyncStatus === "in_progress" && (c.lastSyncAttemptAt == null || now - c.lastSyncAttemptAt.getTime() > STALE_SYNC_MS);
}

/** A last good sync older than this means QuickBooks hasn't been read lately: the nightly sync runs every day. */
export const STALE_DATA_MS = 36 * 3_600_000;

/**
 * When QuickBooks was last read, if the brief has to say so: the last sync
 * failed, or the last one that worked is over STALE_DATA_MS old. Null when
 * the figures are current, and for a company never synced. A failing sync
 * only skipped the sync step, and the brief then presented its figures as
 * current (audit Oct 27, E4). Pure.
 */
export function staleDataAsOf(
  c: { lastSyncedAt: Date | null; lastSyncStatus: string | null; lastSyncAttemptAt: Date | null },
  now: number
): Date | null {
  if (!c.lastSyncedAt) return null;
  return syncLooksFailed(c, now) || now - c.lastSyncedAt.getTime() > STALE_DATA_MS ? c.lastSyncedAt : null;
}

/** Our own support address, which the app's sync messages give and the scrub would take out as an email address. */
const OUR_SUPPORT_ADDRESS = /\bsupport@jobprofitai\.com\b/gi;

/**
 * The sync's stored error, if it's a sentence meant for customers (most
 * are, such as "Your jobs are set to come from QuickBooks Classes, but
 * QuickBooks sent no classes..."). Technical ones (status codes, request
 * ids, network errors) aren't put in an email, and null is returned: the
 * email then says, in plain words, that the last attempts didn't finish.
 *
 * Also screened the way the app screens any error before a person sees it
 * (publicErrorMessage): the stored error is whatever the sync threw, so a
 * database or library message ("Invalid `prisma.x.y()` invocation...",
 * "TOKEN_ENCRYPTION_KEY must decode...") used to go into the owner's email
 * as it was (audit Oct 27, SEC1). Our support address is allowed through.
 */
export function customerSyncError(message: string | null | undefined): string | null {
  const m = message?.trim();
  if (!m || m.length > 400) return null;
  if (/intuit_tid|status \d{3}|Change Data Capture|fetch failed|ECONN|ETIMEDOUT|socket|\bundefined\b|\bnull\b/i.test(m)) return null;
  const screened = m.replace(OUR_SUPPORT_ADDRESS, "our support address");
  return publicErrorMessage(new Error(screened), "") === screened ? m : null;
}

/**
 * How one recipient's profit alert email went: sent (or nothing new to
 * send), worth trying again (the email provider down or busy, email not set
 * up in this environment, or another run still sending some of them), or
 * refused (the address or message was rejected, which trying again won't
 * change).
 */
export function alertSendFailure(result: { ok: boolean; transient?: boolean; skipped?: boolean; inFlight?: string[] }): "retry" | "refused" | null {
  // Another run's send of these may still fail: not had yet (audit Oct 27, E1).
  if (result.inFlight?.length) return "retry";
  if (result.ok) return null;
  return result.transient || result.skipped ? "retry" : "refused";
}

/**
 * The profit alerts that are done: every recipient who can get them has
 * them. One still owed to a recipient whose send may work next time stays
 * waiting, and goes to that recipient alone at the next run (each address
 * gets each alert once; see sendProfitAlerts). An address that was refused
 * doesn't hold an alert back, but one that nobody has received stays
 * waiting. Pure.
 */
export function alertsDelivered(
  alertIds: string[],
  recipients: { has: string[]; failed: "retry" | "refused" | null }[]
): string[] {
  return alertIds.filter((id) => {
    if (!recipients.some((r) => r.has.includes(id))) return false;
    return !recipients.some((r) => r.failed === "retry" && !r.has.includes(id));
  });
}

// --- The weekly brief run ----------------------------------------------------

/** How often the weekly brief job runs (vercel.json). */
export const BRIEF_RUN_EVERY_MS = 15 * 60_000;

/** Whether no run after this one is inside the brief's catch-up window: this run is its last chance. */
export function lastRunFor(scheduledAt: Date, now: number = Date.now()): boolean {
  return !withinCatchUp(new Date(now + BRIEF_RUN_EVERY_MS), scheduledAt);
}

/**
 * When to try a brief's send again, `waitMs` from now but early enough that
 * a run after it is still inside the brief's window (a later run picks it
 * up once this time has passed). Null when no later run is inside it:
 * waiting the full hour used to carry a retry past the window's end, where
 * it was dropped with nobody told (audit Oct 27, E7). Pure.
 */
export function nextRetryAt(now: number, scheduledAt: Date, waitMs: number): number | null {
  if (lastRunFor(scheduledAt, now)) return null;
  const windowEnd = scheduledAt.getTime() + CATCH_UP_HOURS * 3_600_000;
  return Math.max(now, Math.min(now + waitMs, windowEnd - BRIEF_RUN_EVERY_MS));
}

/**
 * Waits for `work` until `deadline` (epoch ms). Its value when it settled in
 * time, `{ done: false }` when it didn't; its error is thrown when it failed
 * in time. One that fails later is ignored: whoever gave up on it has
 * already moved on.
 */
export async function byDeadline<T>(work: Promise<T>, deadline: number): Promise<{ done: true; value: T } | { done: false }> {
  const settled = work.then((value) => ({ done: true as const, value }));
  settled.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([settled, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Time before a brief's scheduled send within which its company goes first for a full sync. */
export const BRIEF_SOON_MS = 24 * 3_600_000;

/**
 * The nightly job's full-sync queue, with the companies whose brief is held
 * for that sync (`held`) and due within BRIEF_SOON_MS, or waiting now,
 * moved up, soonest due first. The rest keep their order. After an upgrade
 * that every company needs a full sync for, a Monday 8am company could wait
 * behind the others in the one-at-a-time slot until its brief's 48-hour
 * window closed (audit Oct 27, E2). Pure.
 *
 * Two kinds stay where they are (review of audit Oct 27):
 *  - A full read put first in line on purpose (FULL_SYNC_OWED_AT,
 *    FULL_SYNC_PARTWAY_FIRST_AT: its first step needs the start of a run)
 *    stays ahead of the companies moved up. Behind them, a large read could
 *    be put off run after run.
 *  - A company whose brief already went out for this send (`lastEmailedAt`,
 *    by connection id, at or after the send's time) isn't waiting for it.
 *    Right after an upgrade every company is held, and those whose brief had
 *    gone out sorted ahead of one due in a few hours.
 */
export function briefDueFirst<
  T extends {
    id: string;
    emailEnabled: boolean;
    emailRecipients: string[];
    emailDay: number;
    emailHour: number;
    emailTimezone: string;
    fullSyncContinueAt?: Date | null;
  },
>(queue: T[], now: Date, held: (c: T) => boolean, lastEmailedAt: Map<string, Date | null> = new Map()): T[] {
  const dueIn = (c: T): number | null => {
    if (!c.emailEnabled || c.emailRecipients.length === 0 || !held(c)) return null;
    const schedule = { day: c.emailDay, hour: c.emailHour, timeZone: isValidTimeZone(c.emailTimezone) ? c.emailTimezone : "America/New_York" };
    const last = lastScheduledSend(now, schedule).scheduledAt;
    const emailed = lastEmailedAt.get(c.id);
    // Waiting now, unless it went out: the longest overdue first (a negative wait).
    if (withinCatchUp(now, last) && !(emailed && emailed.getTime() >= last.getTime())) return last.getTime() - now.getTime();
    const next = lastScheduledSend(new Date(now.getTime() + 7 * 86_400_000), schedule).scheduledAt;
    const wait = next.getTime() - now.getTime();
    return wait <= BRIEF_SOON_MS ? wait : null;
  };
  const firstInLine = (c: T) => c.fullSyncContinueAt != null && c.fullSyncContinueAt.getTime() <= FULL_SYNC_PARTWAY_FIRST_AT.getTime();
  const soon = queue
    .filter((c) => !firstInLine(c))
    .map((c) => ({ c, wait: dueIn(c) }))
    .filter((x): x is { c: T; wait: number } => x.wait != null);
  if (soon.length === 0) return queue;
  const moved = new Set(soon.map((x) => x.c));
  return [
    ...queue.filter(firstInLine),
    ...soon.sort((a, b) => a.wait - b.wait).map((x) => x.c),
    ...queue.filter((c) => !firstInLine(c) && !moved.has(c)),
  ];
}

/**
 * The order due briefs are worked in: longest overdue first and, among
 * those due at the same moment, the company whose last brief went out
 * longest ago (never sent first). Ties used to go in database order, so the
 * same companies came last every week and were the ones left for the next
 * run when a run filled up. Pure.
 */
export function orderDueBriefs<T extends { connection: { id: string }; scheduledAt: Date }>(
  due: T[],
  lastEmailedAt: Map<string, Date | null>
): T[] {
  const last = (t: T) => lastEmailedAt.get(t.connection.id)?.getTime() ?? Number.NEGATIVE_INFINITY;
  const byId = (a: T, b: T) => (a.connection.id < b.connection.id ? -1 : a.connection.id > b.connection.id ? 1 : 0);
  return [...due].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime() || last(a) - last(b) || byId(a, b));
}

/** What the weekly brief run needs to know about each company's outcome to say what went wrong. */
export interface BriefRunResult {
  status: string;
  /** Sent without its written summary. */
  summaryMissing?: boolean;
  /** Why the summary is missing (SummaryFailure in src/lib/digest.ts). */
  summaryFailure?: { kind: string; message: string } | null;
  /** Sent while a full read of QuickBooks was unfinished: its sync failed, or it waited a day for it. */
  sentPartway?: boolean;
  /** Every recipient refused for a reason on our side (SendEmailResult.senderSide). */
  senderRefused?: boolean;
  /** This week's brief won't go out: its last attempt failed, or the week's window closes before the next run. */
  endsUnsent?: boolean;
  /**
   * This week's brief won't go out: it was still waiting (for a sync it's
   * held for, or for room in a run) when the week's window closed. Used to
   * end with nobody told (audit Oct 27, E2).
   */
  endsWaiting?: boolean;
  /**
   * Some recipients got it, and the rest won't: the week's window closed
   * first (audit Oct 27, E7), or the send day was moved earlier, ending its
   * send (review of audit Oct 27).
   */
  partlySent?: boolean;
  /** Due since then and waiting only for room in a run. */
  waitingSince?: Date;
}

export interface BriefRunProblems {
  summariesMissing: number;
  /** How many of those went without it for each reason. */
  summaryFailureKinds: Record<string, number>;
  /** What the first refused AI request said, the likeliest cause to fix. */
  firstRefusal: string | null;
  /** What the first failure with no known cause said, so the report explains itself. */
  firstOther: string | null;
  sentPartway: number;
  senderRefused: number;
  /** Companies whose every recipient was refused, for any reason. */
  refusedCompanies: number;
  endedUnsent: number;
  /** Still waiting when the window closed (BriefRunResult.endsWaiting). */
  endedWaiting: number;
  /** Reached only some recipients by the window's end (BriefRunResult.partlySent). */
  partlySent: number;
  /** How late the brief waiting longest for room in a run is, in minutes, when over an hour. */
  minutesLate: number | null;
  /** The run counts as failed for the cron monitor. */
  failed: boolean;
}

const BEHIND_AFTER_MS = 60 * 60_000;
/** This many companies refused for every recipient in one run is more than a typo in a Settings list. */
const REFUSED_COMPANIES_FAIL_AT = 3;

/**
 * What went wrong in a run, counted. A refusal on our side (the sending
 * domain or key) fails every brief until someone fixes it, so one is enough
 * to count the run as failed; so are three or more companies refused for
 * every recipient. Pure.
 */
export function briefRunProblems(results: BriefRunResult[], now: Date): BriefRunProblems {
  const senderRefused = results.filter((r) => r.senderRefused).length;
  const refusedCompanies = senderRefused + results.filter((r) => r.status === "generated_not_sent").length;
  const waiting = results.map((r) => r.waitingSince?.getTime()).filter((t): t is number => t != null);
  const oldest = waiting.length ? Math.min(...waiting) : null;
  const late = oldest == null ? 0 : now.getTime() - oldest;
  const missing = results.filter((r) => r.status === "sent" && r.summaryMissing);
  const summaryFailureKinds: Record<string, number> = {};
  for (const r of missing) {
    const kind = r.summaryFailure?.kind ?? "other";
    summaryFailureKinds[kind] = (summaryFailureKinds[kind] ?? 0) + 1;
  }
  return {
    summariesMissing: missing.length,
    summaryFailureKinds,
    firstRefusal: missing.find((r) => r.summaryFailure?.kind === "refused")?.summaryFailure?.message ?? null,
    firstOther: missing.find((r) => (r.summaryFailure?.kind ?? "other") === "other")?.summaryFailure?.message ?? null,
    sentPartway: results.filter((r) => r.status === "sent" && r.sentPartway).length,
    senderRefused,
    refusedCompanies,
    endedUnsent: results.filter((r) => r.endsUnsent).length,
    endedWaiting: results.filter((r) => r.endsWaiting && !r.endsUnsent).length,
    partlySent: results.filter((r) => r.partlySent).length,
    minutesLate: late > BEHIND_AFTER_MS ? Math.round(late / 60_000) : null,
    failed: senderRefused > 0 || refusedCompanies >= REFUSED_COMPANIES_FAIL_AT,
  };
}

/** A weekly brief run's problem, for Sentry. Named, so each kind groups on its own. */
export class BriefRunProblem extends Error {
  constructor(name: "BriefSummaryMissing" | "BriefSendRefused" | "BriefNotSent" | "BriefRunBehind" | "BriefSentPartway", message: string) {
    super(message);
    this.name = name;
  }
}

const briefs = (n: number) => `${n} weekly ${n === 1 ? "brief" : "briefs"}`;

/** Each reason a summary went missing, in words. */
const FAILURE_WORDS: Record<string, string> = {
  refused: "refused by Anthropic",
  transient: "rate limit or server error",
  timeout: "timed out",
  connection: "no connection",
  out_of_time: "out of time in the run",
  rules: "too little left after the check",
  other: "other",
};

/** The reports a run sends: at most one of each kind, with the counts. Pure. */
export function briefRunReports(p: BriefRunProblems): BriefRunProblem[] {
  const out: BriefRunProblem[] = [];
  if (p.summariesMissing > 0) {
    const why = Object.entries(p.summaryFailureKinds)
      .sort((a, b) => b[1] - a[1])
      .map(([kind, n]) => `${FAILURE_WORDS[kind] ?? kind}: ${n}`)
      .join(", ");
    const refusal = p.firstRefusal ? ` The first refusal said: ${p.firstRefusal.slice(0, 200)}` : "";
    // "other" alone says nothing about the cause (Oct 22, 2026: one brief,
    // and the reason was only in Vercel's logs), so its message comes too.
    // No quotes in this sentence: the scrub replaces quoted text, and took
    // the word with it (audit Oct 27, SEC2 and E8).
    const other = p.firstOther ? ` The first failure of kind other said: ${p.firstOther.slice(0, 200)}` : "";
    out.push(new BriefRunProblem("BriefSummaryMissing", `${briefs(p.summariesMissing)} went out without the written summary in this run (${why}).${refusal}${other}`));
  }
  if (p.senderRefused > 0) {
    out.push(
      new BriefRunProblem(
        "BriefSendRefused",
        `The email provider refused every recipient of ${briefs(p.senderRefused)} for a reason on our side (the sending domain, from address or API key). Each is tried again in an hour without using an attempt.`
      )
    );
  }
  // One report of this kind, with a sentence for each way a brief ends unsent.
  const notSent = [
    p.endedUnsent > 0
      ? `${briefs(p.endedUnsent)} won't go out this week: the last attempt failed, or every recipient was refused as the week's window closed.`
      : null,
    p.endedWaiting > 0
      ? `${briefs(p.endedWaiting)} won't go out this week: still waiting for a sync or for room in a run when the week's window closed.`
      : null,
    p.partlySent > 0
      ? `${briefs(p.partlySent)} reached only some of their recipients, and the rest won't get it: the email provider couldn't take theirs before the week's window closed or the send day was moved.`
      : null,
  ].filter((s): s is string => s != null);
  if (notSent.length > 0) out.push(new BriefRunProblem("BriefNotSent", notSent.join(" ")));
  if (p.sentPartway > 0) {
    out.push(
      new BriefRunProblem(
        "BriefSentPartway",
        `${briefs(p.sentPartway)} went out from what was synced while a full read of QuickBooks was unfinished: its sync failed, or it had waited a day past the brief's time.`
      )
    );
  }
  if (p.minutesLate != null) {
    out.push(new BriefRunProblem("BriefRunBehind", `The weekly brief run is behind: the brief waiting longest is ${p.minutesLate} minutes past its scheduled time.`));
  }
  return out;
}
