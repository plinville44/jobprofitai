/**
 * Sync now's two refusals that are not failures (see api/quickbooks/sync):
 *
 *  - sync_in_progress (409): a sync is already running for this company,
 *    started by the first-run screen, the nightly job or another click.
 *  - sync_cooldown (429): a sync ended less than a minute ago.
 *
 * In both cases the sync that is running, or has just run, is doing the
 * work, so the dashboard shows the server's message as a plain notice
 * instead of "Failed: ...". Anything else is still a failure.
 *
 * No imports, so client components can use it.
 */
export const SYNC_NOTICE_CODES = ["sync_in_progress", "sync_cooldown"] as const;

const FALLBACK: Record<(typeof SYNC_NOTICE_CODES)[number], string> = {
  sync_in_progress: "A QuickBooks sync is already running for this company. Give it a minute and refresh.",
  sync_cooldown: "This company finished syncing less than a minute ago. Try again in a minute.",
};

/**
 * The notice to show for a refused Sync now, or null when the refusal is a
 * real failure. `data` is the parsed JSON body, or null when there wasn't
 * one. Pure.
 */
export function syncRefusalNotice(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const { code, error } = data as { code?: unknown; error?: unknown };
  if (code !== "sync_in_progress" && code !== "sync_cooldown") return null;
  return typeof error === "string" && error.trim() ? error : FALLBACK[code];
}
