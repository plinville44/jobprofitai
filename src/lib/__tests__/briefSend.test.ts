import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));

// Resend's v3 contract: send() resolves with { data, error } and doesn't throw.
const sent: { to: unknown; subject: string }[] = [];
let nextErrors: ({ message: string; name?: string } | "throw")[] = [];
vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (payload: any) => {
        const err = nextErrors.shift();
        if (err === "throw") throw new Error("fetch failed");
        if (err) return { data: null, error: err };
        sent.push({ to: payload.to, subject: payload.subject });
        return { data: { id: `msg_${sent.length}` }, error: null };
      },
    };
  },
}));

import { customerSyncError, syncLooksFailed } from "../briefSend";
import { sendEmail } from "../email/client";
import { sendBriefOnHold, sendWeeklyBrief } from "../email/lifecycle";
import { briefOnHoldEmail, trialExpiredEmail } from "../email/templates";

const NOW = new Date("2026-09-28T12:00:00Z").getTime();
const WEEK = new Date("2026-09-28T04:00:00Z");
const EMAIL = { subject: "Acme: Weekly Profit Brief", html: "<p>hi</p>", text: "hi" };

beforeEach(() => {
  fake.client = createFakePrisma();
  sent.length = 0;
  nextErrors = [];
  process.env.RESEND_API_KEY = "re_test_key";
  delete process.env.EMAIL_DEV_REDIRECT;
});

describe("the brief job's view of a sync", () => {
  it("counts a sync stuck 'in progress' past 10 minutes as failed", () => {
    expect(syncLooksFailed({ lastSyncStatus: "error", lastSyncAttemptAt: new Date(NOW) }, NOW)).toBe(true);
    expect(syncLooksFailed({ lastSyncStatus: "in_progress", lastSyncAttemptAt: new Date(NOW - 5 * 60_000) }, NOW)).toBe(false);
    expect(syncLooksFailed({ lastSyncStatus: "in_progress", lastSyncAttemptAt: new Date(NOW - 11 * 60_000) }, NOW)).toBe(true);
    expect(syncLooksFailed({ lastSyncStatus: "in_progress", lastSyncAttemptAt: null }, NOW)).toBe(true);
    expect(syncLooksFailed({ lastSyncStatus: "success", lastSyncAttemptAt: new Date(NOW) }, NOW)).toBe(false);
  });

  it("only puts a sync error in an email when it's written for customers", () => {
    const classes =
      "Your jobs are set to come from QuickBooks Classes, but QuickBooks sent no classes. If your jobs aren't classes, change how your jobs are set up in Settings.";
    expect(customerSyncError(classes)).toBe(classes);
    expect(customerSyncError("QuickBooks API query failed with status 500 (intuit_tid: abc)")).toBeNull();
    expect(customerSyncError("fetch failed")).toBeNull();
    expect(customerSyncError(null)).toBeNull();
  });
});

describe("sending the weekly brief", () => {
  const brief = (recipient: string) =>
    sendWeeklyBrief({ ownerId: "owner", connectionId: "c1", weekStarting: WEEK, recipient, email: EMAIL });

  it("sends each recipient one copy a week, even when a run dies partway and another picks it up", async () => {
    expect((await brief("a@example.com")).ok).toBe(true);
    // The retry run: a@ already has it, b@ doesn't.
    const again = await brief("A@example.com");
    expect(again).toMatchObject({ ok: true, skipped: true });
    expect((await brief("b@example.com")).ok).toBe(true);
    expect(sent.map((s) => s.to)).toEqual([["a@example.com"], ["b@example.com"]]);
  });

  it("tries a failed send again, and says whether the failure was on the sending side", async () => {
    nextErrors = [{ message: "Too many requests", name: "rate_limit_exceeded" }];
    const busy = await brief("a@example.com");
    expect(busy).toMatchObject({ ok: false, transient: true });
    expect((await brief("a@example.com")).ok).toBe(true);

    nextErrors = [{ message: "Invalid `to` field", name: "validation_error" }];
    expect(await sendEmail({ to: "nope", ...EMAIL })).toMatchObject({ ok: false, transient: false });
    nextErrors = ["throw"];
    expect(await sendEmail({ to: "x@example.com", ...EMAIL })).toMatchObject({ ok: false, transient: true });
  });
});

describe("a brief held back by a failing upgrade sync", () => {
  beforeEach(async () => {
    await fake.client.user.create({ data: { id: "owner", email: "owner@example.com", name: "Pat" } });
  });
  const hold = (lastSyncedAt: Date | null) =>
    sendBriefOnHold({ ownerId: "owner", connectionId: "c1", companyName: "Acme", lastSyncedAt, reason: null });

  it("tells the owner once, not every week", async () => {
    const lastGood = new Date("2026-09-20T00:00:00Z");
    expect((await hold(lastGood)).skipped).toBeFalsy();
    expect((await hold(lastGood)).skipped).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ["owner@example.com"], subject: "Acme: the Weekly Profit Brief is on hold" });
    // A new problem after a sync worked again is a new email.
    expect((await hold(new Date("2026-10-01T00:00:00Z"))).skipped).toBeFalsy();
    expect(sent).toHaveLength(2);
  });

  it("says what happened in plain words, and links to this company's Settings", () => {
    const email = briefOnHoldEmail("Acme", "Your jobs are set to come from QuickBooks Classes, but QuickBooks sent no classes.", "https://x/api/company/open?company=c1&next=%2Fdashboard%2Fsettings");
    expect(email.text).toContain("QuickBooks sent no classes");
    expect(email.text).toContain("We'll only email you about this once");
    expect(email.text).toContain("company=c1");
    expect(email.text + email.html).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("the trial-ended email", () => {
  it("mentions the Firm plan when Billing offers it", () => {
    expect(trialExpiredEmail().text).not.toContain("Firm");
    const firm = trialExpiredEmail({ firmOffered: true }).text;
    expect(firm).toContain("Keeping the books for several contractors? The Firm plan is $79 per client company a month, 4 companies minimum");
    expect(firm).toContain("Firm is $79 per company/month (4 minimum)");
    expect(firm).not.toMatch(/[\u2013\u2014]/);
  });
});
