import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { rebuildWaiting, SYNC_COOLDOWN_SECONDS, syncCooldownSecondsLeft } from "../syncCooldown";

// The dashboard's "Is each job a Class?" question only appears after a sync
// has finished, so its "Yes" nearly always landed inside Sync now's pause
// and failed to read the jobs again. A rebuild asked for since the last sync
// started isn't held back by the pause.

const NOW = new Date("2026-09-28T12:00:00Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);

describe("Sync now's pause and a waiting rebuild", () => {
  const justSynced = { lastSyncAttemptAt: ago(10), lastSyncStatus: "success", lastSyncStartedAt: ago(40) };

  it("doesn't pause a rebuild asked for after the last sync started", () => {
    expect(syncCooldownSecondsLeft({ ...justSynced, rebuildRequestedAt: ago(5) }, NOW)).toBe(0);
    // Asked for while that sync was still running: it read the old setup.
    expect(syncCooldownSecondsLeft({ ...justSynced, rebuildRequestedAt: ago(20) }, NOW)).toBe(0);
  });

  it("pauses as before once a sync has started since the rebuild was asked for", () => {
    expect(syncCooldownSecondsLeft({ ...justSynced, rebuildRequestedAt: ago(60) }, NOW)).toBe(SYNC_COOLDOWN_SECONDS - 10);
    expect(syncCooldownSecondsLeft({ ...justSynced, rebuildRequestedAt: null }, NOW)).toBe(SYNC_COOLDOWN_SECONDS - 10);
    // Callers that don't pass the new fields keep the old rule.
    expect(syncCooldownSecondsLeft({ lastSyncAttemptAt: ago(10), lastSyncStatus: "error" }, NOW)).toBe(SYNC_COOLDOWN_SECONDS - 10);
  });

  it("counts a rebuild as waiting when no sync start is known", () => {
    expect(rebuildWaiting({ rebuildRequestedAt: ago(5), lastSyncStartedAt: null })).toBe(true);
    expect(rebuildWaiting({ rebuildRequestedAt: null, lastSyncStartedAt: null })).toBe(false);
  });

  it("is applied by Sync now, and the question waits out a pause the way it waits out a running sync", () => {
    const root = join(__dirname, "..", "..");
    const route = readFileSync(join(root, "app", "api", "quickbooks", "sync", "route.ts"), "utf8");
    expect(route).toContain("lastSyncStartedAt");
    expect(route).toContain("retryAfterSeconds");
    const prompt = readFileSync(join(root, "components", "dashboard", "JobSourcePrompt.tsx"), "utf8");
    expect(prompt).toContain('res.status === 429 && data?.code === "sync_cooldown"');
    expect(prompt).not.toMatch(/[\u2013\u2014]/);
  });
});
