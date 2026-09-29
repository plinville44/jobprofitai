import { describe, it, expect } from "vitest";
import { formatDate, formatDateIn } from "../format";

describe("dating a report in the company's time zone", () => {
  // 9:43 pm on Sep 28 in Indiana is already Sep 29 in UTC. The WIP report
  // run then said "As of Sep 29".
  const evening = new Date("2026-09-29T01:43:00Z");

  it("uses the company's calendar date", () => {
    expect(formatDateIn(evening, "America/Indiana/Indianapolis")).toBe("Sep 28, 2026");
    expect(formatDate(evening)).toBe("Sep 29, 2026");
  });

  it("falls back to US Eastern for a missing or unknown zone", () => {
    expect(formatDateIn(evening, null)).toBe("Sep 28, 2026");
    expect(formatDateIn(evening, "Not/AZone")).toBe("Sep 28, 2026");
  });
});
