import { describe, it, expect } from "vitest";
import { dailySyncDue, inOvernightWindow, localHour } from "../syncSchedule";

const H = 3_600_000;
// 1:30 am in Indiana (EDT, UTC-4) on Oct 1, 2026.
const nightIndiana = new Date("2026-10-01T05:30:00Z");
// 8:30 pm in Indiana on Sep 30.
const eveningIndiana = new Date("2026-10-01T00:30:00Z");
const tz = "America/Indiana/Indianapolis";

describe("the daily sync runs overnight in the company's time zone", () => {
  it("reads the local hour", () => {
    expect(localHour(nightIndiana, tz)).toBe(1);
    expect(localHour(eveningIndiana, tz)).toBe(20);
    expect(localHour(nightIndiana, "Not/AZone")).toBe(1); // falls back to US Eastern
    expect(localHour(nightIndiana, "America/Los_Angeles")).toBe(22);
  });

  it("knows the window is midnight to 6 am", () => {
    expect(inOvernightWindow(nightIndiana, tz)).toBe(true);
    expect(inOvernightWindow(eveningIndiana, tz)).toBe(false);
    expect(inOvernightWindow(new Date("2026-10-01T10:00:00Z"), tz)).toBe(false); // 6 am exactly
    expect(inOvernightWindow(new Date("2026-10-01T09:59:00Z"), tz)).toBe(true); // 5:59 am
  });

  it("syncs overnight a company last synced yesterday evening, not the same evening", () => {
    // Synced by Sync now at 10:22 pm on Sep 29 (the drift case Preston saw).
    const c = { lastSyncedAt: new Date("2026-09-30T02:22:00Z"), emailTimezone: tz };
    expect(dailySyncDue(c, eveningIndiana)).toBe(false); // 8:30 pm Sep 30: 22 hours, but not night
    expect(dailySyncDue(c, nightIndiana)).toBe(true); // 1:30 am Oct 1
  });

  it("waits when it was synced earlier tonight or late this evening", () => {
    expect(dailySyncDue({ lastSyncedAt: new Date(nightIndiana.getTime() - 1 * H), emailTimezone: tz }, nightIndiana)).toBe(false);
    expect(dailySyncDue({ lastSyncedAt: new Date(nightIndiana.getTime() - 5 * H), emailTimezone: tz }, nightIndiana)).toBe(false);
    expect(dailySyncDue({ lastSyncedAt: new Date(nightIndiana.getTime() - 7 * H), emailTimezone: tz }, nightIndiana)).toBe(true);
  });

  it("syncs a company that missed a night at any hour once 30 hours have passed", () => {
    expect(dailySyncDue({ lastSyncedAt: new Date(eveningIndiana.getTime() - 29 * H), emailTimezone: tz }, eveningIndiana)).toBe(false);
    expect(dailySyncDue({ lastSyncedAt: new Date(eveningIndiana.getTime() - 30 * H), emailTimezone: tz }, eveningIndiana)).toBe(true);
  });

  it("syncs a company never synced straight away", () => {
    expect(dailySyncDue({ lastSyncedAt: null, emailTimezone: tz }, eveningIndiana)).toBe(true);
  });

  it("uses each company's own zone", () => {
    // 1:30 am in Indiana is 10:30 pm in Los Angeles: not yet night there.
    const c = { lastSyncedAt: new Date(nightIndiana.getTime() - 24 * H), emailTimezone: "America/Los_Angeles" };
    expect(dailySyncDue(c, nightIndiana)).toBe(false);
    expect(dailySyncDue(c, new Date(nightIndiana.getTime() + 3 * H))).toBe(true); // 1:30 am there
  });
});
