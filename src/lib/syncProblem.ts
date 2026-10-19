import { needsReconnect } from "./quickbooks";
import { formatDateTime } from "./format";

/**
 * The strip every dashboard page shows when the company on screen isn't
 * being kept up to date: its last sync failed, QuickBooks needs
 * reconnecting, or the plan doesn't cover it (src/lib/planLimits.ts). Also,
 * as a softer note, while a full read of QuickBooks is still partway.
 * Without it a failing nightly sync only shows as an old "last synced" date,
 * and the figures look current when they aren't.
 *
 * Plain words only. The raw sync error can be QuickBooks' own wording or an
 * internal message, so it is never shown here (Settings lists each
 * company's sync status in detail). A client's view-only login is told who
 * can fix it rather than sent to pages it can't open.
 */

export interface SyncProblem {
  tone: "warning" | "critical";
  message: string;
  link: { href: string; label: string } | null;
}

/** The start of the error the sync writes when a Classes company has no classes. */
const NO_CLASSES_PREFIX = "Your jobs are set to come from QuickBooks Classes";
/** The start of FULL_SYNC_TOO_LONG_MESSAGE in quickbooksSync.ts (not imported, to keep this file free of the sync's dependencies). */
const TOO_LONG_PREFIX = "Reading this company's QuickBooks history keeps running out of time";

/**
 * Whether the company's full read of QuickBooks keeps running out of time and
 * is down to one try a day (the sync's fullSyncStuck, as it leaves the
 * connection: FULL_SYNC_TOO_LONG_MESSAGE as the sync error).
 */
export function fullSyncTooLong(c: { lastSyncError?: string | null }): boolean {
  return c.lastSyncError?.startsWith(TOO_LONG_PREFIX) ?? false;
}

/**
 * fullSyncContinueAt for a full read that is owed but has nothing read yet:
 * QuickBooks' change feed failed, or the read was put off to the start of
 * the next run before it began. The epoch, so it's first in line for the
 * nightly sync's full-sync slot. The stored figures are as the last sync
 * left them, whole, so nothing waits for it. No other value means this: a
 * read that has saved progress is given a real time, or FULL_SYNC_PARTWAY_FIRST_AT.
 */
export const FULL_SYNC_OWED_AT = new Date(0);
/** First in line as well, for a read put off partway through (it has saved progress). */
export const FULL_SYNC_PARTWAY_FIRST_AT = new Date(1);

/** A full read is owed and none of it has been read yet (see FULL_SYNC_OWED_AT). Pure. */
export function fullSyncOwed(c: { fullSyncContinueAt?: Date | null }): boolean {
  return c.fullSyncContinueAt != null && c.fullSyncContinueAt.getTime() === FULL_SYNC_OWED_AT.getTime();
}

/**
 * Whether a full read of the company's QuickBooks data is partway: it has
 * read and saved at least one step and stopped before the last
 * (fullSyncContinueAt is set, and isn't FULL_SYNC_OWED_AT), and it isn't the
 * once-a-day case above. Some data types are then read and others not yet,
 * so on a first sync jobs show costs with no invoices, and on a later one
 * some figures are older than others. Anything that judges the figures (the
 * weekly brief, alerts, the WIP report) should wait while this is true. Pure.
 */
export function fullSyncPartway(c: { fullSyncContinueAt?: Date | null; lastSyncError?: string | null }): boolean {
  return c.fullSyncContinueAt != null && !fullSyncOwed(c) && !fullSyncTooLong(c);
}

export function syncProblemFor(
  company: {
    companyName: string | null;
    lastSyncStatus: string | null;
    lastSyncError: string | null;
    lastSyncedAt: Date | null;
    emailTimezone?: string | null;
    fullSyncContinueAt?: Date | null;
  },
  opts: { paused: boolean; role: "owner" | "member" | "client" }
): SyncProblem | null {
  const name = company.companyName ?? "This company";
  const client = opts.role === "client";
  const since = company.lastSyncedAt
    ? `The figures are from ${formatDateTime(company.lastSyncedAt, company.emailTimezone)}.`
    : "Nothing has been read from QuickBooks yet.";

  if (opts.paused) {
    if (client) {
      return { tone: "warning", message: `${name}'s figures aren't being updated right now. ${since} Your bookkeeper can turn updates back on.`, link: null };
    }
    const fix =
      opts.role === "owner"
        ? "To turn it back on, disconnect a company in Settings or choose a plan that covers more."
        : "Ask the account owner to disconnect a company or choose a plan that covers more.";
    return {
      tone: "warning",
      message: `${name} is paused because your plan doesn't cover this many companies. It isn't synced and gets no weekly brief or alerts. ${since} ${fix}`,
      link: opts.role === "owner" ? { href: "/dashboard/billing", label: "Go to Billing" } : null,
    };
  }

  if (needsReconnect(company.lastSyncError)) {
    if (client) {
      return { tone: "critical", message: `${name}'s QuickBooks connection needs your bookkeeper's attention, so the figures aren't updating. ${since}`, link: null };
    }
    return {
      tone: "critical",
      message: `QuickBooks needs to be reconnected for ${name}, so the figures here aren't updating. ${since}`,
      link: { href: "/dashboard/settings", label: "Reconnect in Settings" },
    };
  }

  if (company.lastSyncStatus === "error") {
    if (company.lastSyncError?.startsWith(NO_CLASSES_PREFIX)) {
      if (client) {
        return { tone: "critical", message: `${name}'s jobs couldn't be read from QuickBooks. ${since} Your bookkeeper can fix this.`, link: null };
      }
      return {
        tone: "critical",
        message: `${name}'s jobs are set to come from QuickBooks Classes, but QuickBooks has none, so the last sync stopped. ${since} If your jobs aren't classes, change how jobs are set up in Settings.`,
        link: { href: "/dashboard/settings", label: "Open Settings" },
      };
    }
    if (client) {
      return { tone: "warning", message: `The last update of ${name} from QuickBooks didn't finish. ${since} Your bookkeeper can check it.`, link: null };
    }
    if (fullSyncTooLong(company)) {
      // Sync now wouldn't help: this company's full read keeps running out
      // of time, and it's already being carried on once a day.
      return {
        tone: "warning",
        message: `Reading ${name}'s QuickBooks history keeps running out of time, so some figures may be out of date. ${since} It carries on once a day. If this hasn't cleared in a few days, email support@jobprofitai.com.`,
        link: null,
      };
    }
    return {
      tone: "warning",
      message: `The last sync of ${name} with QuickBooks didn't finish. ${since} It's tried again overnight, or use Sync now on the Dashboard. If it keeps failing, email support@jobprofitai.com.`,
      link: { href: "/dashboard/settings", label: "See sync status" },
    };
  }

  // Not a failure, but the figures aren't whole yet: a first read that
  // stopped partway showed costs with no revenue and nothing said why.
  if (fullSyncPartway(company)) {
    const first = company.lastSyncedAt == null;
    const what = first
      ? `We're still reading ${name}'s QuickBooks history, so the figures here may be incomplete: some jobs can show costs before their invoices are read.`
      : `We're partway through reading ${name}'s QuickBooks data in full, so some figures here may be incomplete until it finishes.`;
    const next = client ? "It carries on automatically, usually overnight." : "It carries on automatically, usually overnight, or use Sync now on the Dashboard to carry on now.";
    return { tone: "warning", message: `${what} ${next}`, link: null };
  }

  return null;
}
