import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { syncRefusalNotice } from "../syncNotice";
import { syncCooldownMessage } from "../syncCooldown";

// Clicking Sync now while the first sync is still running, or within a
// minute of one ending, used to show "Failed: ...". Neither is a failure,
// so the dashboard now shows the server's message as a plain notice.

const SRC = join(__dirname, "..", "..");

describe("Sync now refusals that are notices, not failures", () => {
  it("shows the server's own message for a sync already running", () => {
    const msg = "A QuickBooks sync is already running for this company. Give it a minute and refresh.";
    expect(syncRefusalNotice({ error: msg, code: "sync_in_progress" })).toBe(msg);
  });

  it("shows the server's own message for the one-minute pause", () => {
    const msg = syncCooldownMessage(48);
    expect(syncRefusalNotice({ error: msg, code: "sync_cooldown", retryAfterSeconds: 48 })).toBe(msg);
    expect(msg).toContain("48 seconds");
  });

  it("still has a notice when the server sent the code but no message", () => {
    expect(syncRefusalNotice({ code: "sync_in_progress" })).toMatch(/already running/);
    expect(syncRefusalNotice({ code: "sync_cooldown", error: "  " })).toMatch(/less than a minute ago/);
  });

  it("leaves every other refusal as a failure", () => {
    expect(syncRefusalNotice(null)).toBeNull();
    expect(syncRefusalNotice(undefined)).toBeNull();
    expect(syncRefusalNotice("Sync failed.")).toBeNull();
    expect(syncRefusalNotice({ error: "Sync failed." })).toBeNull();
    expect(syncRefusalNotice({ error: "Your trial has ended.", code: "entitlement_required" })).toBeNull();
  });

  it("is what the dashboard's Sync now button uses", () => {
    const src = readFileSync(join(SRC, "app", "dashboard", "DashboardActions.tsx"), "utf8");
    expect(src).toContain('import { syncRefusalNotice } from "@/lib/syncNotice";');
    expect(src).toMatch(/syncRefusalNotice\(data\)/);
    // A real failure still says so.
    expect(src).toContain("Failed: ");
  });

  it("uses no em or en dashes", () => {
    const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    for (const f of ["lib/syncNotice.ts", "lib/__tests__/syncNotice.test.ts", "app/dashboard/DashboardActions.tsx"]) {
      expect({ f, dash: DASHES.test(readFileSync(join(SRC, f), "utf8")) }).toEqual({ f, dash: false });
    }
  });
});
