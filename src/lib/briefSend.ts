/**
 * Small rules the weekly brief job (api/cron/weekly-email) and the nightly
 * job's alert emails (api/cron/nightly-sync) decide by, kept here so they
 * can be tested: a route file may only export its handlers.
 */

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

/**
 * The sync's stored error, if it's a sentence meant for customers (most
 * are, such as "Your jobs are set to come from QuickBooks Classes, but
 * QuickBooks sent no classes..."). Technical ones (status codes, request
 * ids, network errors) aren't put in an email.
 */
export function customerSyncError(message: string | null | undefined): string | null {
  const m = message?.trim();
  if (!m || m.length > 400) return null;
  if (/intuit_tid|status \d{3}|Change Data Capture|fetch failed|ECONN|ETIMEDOUT|socket|\bundefined\b|\bnull\b/i.test(m)) return null;
  return m;
}

/**
 * How one recipient's profit alert email went: sent (or nothing new to
 * send), worth trying again (the email provider down or busy, or email not
 * set up in this environment), or refused (the address or message was
 * rejected, which trying again won't change).
 */
export function alertSendFailure(result: { ok: boolean; transient?: boolean; skipped?: boolean }): "retry" | "refused" | null {
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
  /** Every recipient refused for a reason on our side (SendEmailResult.senderSide). */
  senderRefused?: boolean;
  /** This week's brief won't go out: its last attempt failed, or the week's window closes before the next run. */
  endsUnsent?: boolean;
  /** Due since then and waiting only for room in a run. */
  waitingSince?: Date;
}

export interface BriefRunProblems {
  summariesMissing: number;
  senderRefused: number;
  /** Companies whose every recipient was refused, for any reason. */
  refusedCompanies: number;
  endedUnsent: number;
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
  return {
    summariesMissing: results.filter((r) => r.status === "sent" && r.summaryMissing).length,
    senderRefused,
    refusedCompanies,
    endedUnsent: results.filter((r) => r.endsUnsent).length,
    minutesLate: late > BEHIND_AFTER_MS ? Math.round(late / 60_000) : null,
    failed: senderRefused > 0 || refusedCompanies >= REFUSED_COMPANIES_FAIL_AT,
  };
}

/** A weekly brief run's problem, for Sentry. Named, so each kind groups on its own. */
export class BriefRunProblem extends Error {
  constructor(name: "BriefSummaryMissing" | "BriefSendRefused" | "BriefNotSent" | "BriefRunBehind", message: string) {
    super(message);
    this.name = name;
  }
}

const briefs = (n: number) => `${n} weekly ${n === 1 ? "brief" : "briefs"}`;

/** The reports a run sends: at most one of each kind, with the counts. Pure. */
export function briefRunReports(p: BriefRunProblems): BriefRunProblem[] {
  const out: BriefRunProblem[] = [];
  if (p.summariesMissing > 0) {
    out.push(new BriefRunProblem("BriefSummaryMissing", `${briefs(p.summariesMissing)} went out without the written summary in this run.`));
  }
  if (p.senderRefused > 0) {
    out.push(
      new BriefRunProblem(
        "BriefSendRefused",
        `The email provider refused every recipient of ${briefs(p.senderRefused)} for a reason on our side (the sending domain, from address or API key). Each is tried again in an hour without using an attempt.`
      )
    );
  }
  if (p.endedUnsent > 0) {
    out.push(
      new BriefRunProblem(
        "BriefNotSent",
        `${briefs(p.endedUnsent)} won't go out this week: the last attempt failed, or every recipient was refused as the week's window closed.`
      )
    );
  }
  if (p.minutesLate != null) {
    out.push(new BriefRunProblem("BriefRunBehind", `The weekly brief run is behind: the brief waiting longest is ${p.minutesLate} minutes past its scheduled time.`));
  }
  return out;
}
