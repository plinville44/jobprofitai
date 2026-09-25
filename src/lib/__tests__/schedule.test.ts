import { describe, expect, it } from "vitest";
import { lastScheduledSend, localWeekStarting, withinCatchUp, zonedTimeToUtc } from "../schedule";

describe("zonedTimeToUtc", () => {
  it("handles daylight saving time in both directions", () => {
    // 8am New York is 12:00 UTC in summer (EDT) and 13:00 UTC in winter (EST).
    expect(zonedTimeToUtc(2026, 8, 21, 8, "America/New_York").toISOString()).toBe("2026-09-21T12:00:00.000Z");
    expect(zonedTimeToUtc(2026, 11, 7, 8, "America/New_York").toISOString()).toBe("2026-12-07T13:00:00.000Z");
    expect(zonedTimeToUtc(2026, 8, 21, 8, "America/Los_Angeles").toISOString()).toBe("2026-09-21T15:00:00.000Z");
  });
});

describe("lastScheduledSend", () => {
  const monday8 = { day: 1, hour: 8, timeZone: "America/New_York" };

  it("finds this week's send once its hour has passed", () => {
    const r = lastScheduledSend(new Date("2026-09-21T12:30:00Z"), monday8); // Mon 8:30am ET
    expect(r.scheduledAt.toISOString()).toBe("2026-09-21T12:00:00.000Z");
    expect(r.weekStarting.toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });

  it("before the hour on the day, it is still last week's send", () => {
    const r = lastScheduledSend(new Date("2026-09-21T11:30:00Z"), monday8); // Mon 7:30am ET
    expect(r.scheduledAt.toISOString()).toBe("2026-09-14T12:00:00.000Z");
    expect(r.weekStarting.toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });

  it("uses the contractor's own calendar, not UTC's", () => {
    // Sunday 9pm in Los Angeles is already Monday in UTC. A Sunday 6pm send
    // belongs to the week that started the Monday before.
    const r = lastScheduledSend(new Date("2026-09-21T04:00:00Z"), { day: 0, hour: 18, timeZone: "America/Los_Angeles" });
    expect(r.scheduledAt.toISOString()).toBe("2026-09-21T01:00:00.000Z");
    expect(r.weekStarting.toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });

  it("keys a Monday 8am Eastern brief to the same week as the old server-side Monday", () => {
    // Existing WeeklyDigest rows were written with Monday 00:00 UTC keys.
    expect(localWeekStarting(new Date("2026-09-23T15:00:00Z"), "America/New_York").toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });
});

describe("withinCatchUp", () => {
  it("keeps a missed brief due for 48 hours, then lets it go", () => {
    const at = new Date("2026-09-21T12:00:00Z");
    expect(withinCatchUp(new Date("2026-09-21T12:00:00Z"), at)).toBe(true);
    expect(withinCatchUp(new Date("2026-09-23T11:00:00Z"), at)).toBe(true);
    expect(withinCatchUp(new Date("2026-09-23T13:00:00Z"), at)).toBe(false);
    expect(withinCatchUp(new Date("2026-09-21T11:59:00Z"), at)).toBe(false);
  });
});
