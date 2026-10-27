import { describe, it, expect } from "vitest";
import { setupReminderEmail, trialWelcomeEmail } from "../email/templates";
import { GETTING_STARTED_VIDEO, youtubeWatchUrl } from "../demoVideo";

// The welcome email and the day 3 setup reminder link the 1-minute
// getting-started video under the Connect button, in the HTML and the
// plain-text version alike.

const URL = "https://www.youtube.com/watch?v=dNrl-P3mNhI";

describe("setup video link in the trial emails", () => {
  it("points at the getting-started video's own YouTube page", () => {
    expect(youtubeWatchUrl(GETTING_STARTED_VIDEO.youtubeId)).toBe(URL);
  });

  it("is in the welcome and setup reminder emails, under the Connect button", () => {
    for (const email of [trialWelcomeEmail("Dana Smith"), setupReminderEmail(null, 11)]) {
      expect(email.html).toContain(`href="${URL}"`);
      expect(email.html).toContain(">Watch the 1-minute setup video</a>");
      expect(email.html.indexOf(">Connect QuickBooks</a>")).toBeLessThan(email.html.indexOf(URL));
      expect(email.text).toContain(`Watch the 1-minute setup video: ${URL}`);
      expect(email.text.indexOf("Connect QuickBooks:")).toBeLessThan(email.text.indexOf(URL));
    }
  });

  it("contains no en or em dashes", () => {
    for (const email of [trialWelcomeEmail(null), setupReminderEmail("Dana Smith", 3)]) {
      expect(email.subject + email.text + email.html).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
