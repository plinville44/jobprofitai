import { describe, it, expect } from "vitest";
import {
  CHECKIN_AFTER_ANALYSIS_DAYS,
  GUIDE_AFTER_ANALYSIS_DAYS,
  NUDGE_QUIET_DAYS_LEFT,
  dueTrialNudges,
} from "../trialNudges";
import { reportGuideEmail, trialCheckInEmail } from "../email/templates";

const DAY = 86_400_000;
const NOW = new Date("2026-03-10T15:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const onTrial = (daysRemaining: number) => ({ onTrial: true, daysRemaining });

describe("dueTrialNudges", () => {
  it("sends nothing before the first analysis", () => {
    expect(dueTrialNudges(onTrial(10), null, NOW)).toEqual({ checkIn: false, guide: false });
  });

  it("times the check-in from the first analysis, not from signup", () => {
    expect(dueTrialNudges(onTrial(10), daysAgo(CHECKIN_AFTER_ANALYSIS_DAYS - 0.5), NOW).checkIn).toBe(false);
    expect(dueTrialNudges(onTrial(10), daysAgo(CHECKIN_AFTER_ANALYSIS_DAYS), NOW).checkIn).toBe(true);
  });

  it("sends the guide only after its own delay", () => {
    expect(dueTrialNudges(onTrial(8), daysAgo(GUIDE_AFTER_ANALYSIS_DAYS - 1), NOW)).toEqual({
      checkIn: true,
      guide: false,
    });
    expect(dueTrialNudges(onTrial(8), daysAgo(GUIDE_AFTER_ANALYSIS_DAYS), NOW).guide).toBe(true);
  });

  it("goes quiet in the last days, leaving that to the ending-soon email", () => {
    expect(dueTrialNudges(onTrial(NUDGE_QUIET_DAYS_LEFT), daysAgo(9), NOW)).toEqual({
      checkIn: false,
      guide: false,
    });
    expect(dueTrialNudges(onTrial(NUDGE_QUIET_DAYS_LEFT + 1), daysAgo(9), NOW).guide).toBe(true);
  });

  it("never nudges an account that is not on a trial", () => {
    expect(dueTrialNudges({ onTrial: false, daysRemaining: 10 }, daysAgo(9), NOW)).toEqual({
      checkIn: false,
      guide: false,
    });
  });
});

describe("mid-trial email copy", () => {
  it("contains no en or em dashes", () => {
    for (const email of [trialCheckInEmail("Dana Smith"), reportGuideEmail(null)]) {
      expect(email.subject + email.text + email.html).not.toMatch(/[–—]/);
    }
  });

  it("greets by first name when there is one", () => {
    expect(trialCheckInEmail("Dana Smith").text).toContain("Dana, your QuickBooks jobs");
    expect(trialCheckInEmail(null).text).toContain("Your QuickBooks jobs");
  });
});
