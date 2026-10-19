import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { createFakePrisma, FakeModel, type FakePrisma } from "./support/fakePrisma";

// Audit of 2026-10-19, the library side of the brief and email fixes: the
// email provider's refusals on our side, a second brief in the same week,
// the order and reports of a weekly run, stale Settings saves, alerts held
// while a full sync is partway, the 7 days' grace before a refused company
// is disconnected, and testimonial requests.

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));
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
const ent: { active: boolean; access: string; calls: string[] } = { active: false, access: "trial_expired", calls: [] };
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: async (ownerId: string) => {
    ent.calls.push(ownerId);
    return { active: ent.active, access: ent.access };
  },
}));
vi.mock("@/lib/teamRemoval", () => ({ removeClientLoginsForCompany: async () => [] }));
vi.mock("@/lib/stripe/firmQuantity", () => ({ syncFirmQuantity: async () => {} }));
vi.mock("@/lib/auth", () => ({ revokeAllSessions: async () => {} }));
vi.mock("@/lib/planLimits", () => ({ isOverPlanLimit: async () => false }));
const profit = { calls: 0 };
vi.mock("@/lib/profitability", () => ({
  getConnectionProfitData: async () => {
    profit.calls++;
    throw new Error("figures were read");
  },
}));
vi.mock("@/lib/jobTypesServer", () => ({ getJobTypes: async () => [] }));

import { sendEmail, senderSideError } from "../email/client";
import { sendWeeklyBrief } from "../email/lifecycle";
import { RESEND_AFTER_MS, lastScheduledSend, sentForThisSchedule, withinCatchUp } from "../schedule";
import { briefRunProblems, briefRunReports, orderDueBriefs } from "../briefSend";
import { loadedEmailSettings, staleEmailSettings } from "../emailPreferences";
import { evaluateAlerts } from "../alerts";
import { accessEndedAt, disconnectLapsedCompanies, disconnectRevokedGrants, revokedGraceOver } from "../companyData";
import { getJobTypeSuggestions } from "../jobTypeSuggestions";

const DAY = 86_400_000;
const NOW = new Date("2026-10-19T15:00:00Z");
const EMAIL = { subject: "Acme: Weekly Profit Brief", html: "<p>hi</p>", text: "hi" };

beforeEach(() => {
  fake.client = createFakePrisma();
  sent.length = 0;
  nextErrors = [];
  process.env.RESEND_API_KEY = "re_test_key";
  delete process.env.EMAIL_DEV_REDIRECT;
});

describe("4. a refusal on our side is told apart from a bad address", () => {
  it("names the sending domain, the from address and the key as ours", () => {
    expect(senderSideError("validation_error", "The jobprofitai.com domain is not verified. Please, add and verify your domain on https://resend.com/domains")).toBe(true);
    expect(senderSideError("validation_error", "You can only send testing emails to your own email address (a@b.com).")).toBe(true);
    expect(senderSideError("validation_error", "Invalid `from` field. The email address needs to follow the `email@example.com` format.")).toBe(true);
    expect(senderSideError("invalid_api_key", "API key is invalid")).toBe(true);
    expect(senderSideError("restricted_api_key", "This API key is restricted to only send emails")).toBe(true);
    expect(senderSideError("validation_error", "Invalid `to` field. The email address needs to follow the `email@example.com` format.")).toBe(false);
    expect(senderSideError("rate_limit_exceeded", "Too many requests")).toBe(false);
    expect(senderSideError(undefined, "something")).toBe(false);
  });

  it("marks sends refused that way, and a missing key, as on our side", async () => {
    nextErrors = [{ name: "validation_error", message: "The jobprofitai.com domain is not verified." }];
    expect(await sendEmail({ to: "pm@example.com", ...EMAIL })).toMatchObject({ ok: false, transient: false, senderSide: true });
    nextErrors = [{ name: "validation_error", message: "Invalid `to` field." }];
    expect(await sendEmail({ to: "nope", ...EMAIL })).toMatchObject({ ok: false, senderSide: false });
    delete process.env.RESEND_API_KEY;
    expect(await sendEmail({ to: "pm@example.com", ...EMAIL })).toMatchObject({ ok: false, skipped: true, senderSide: true });
  });

  it("passes the refusal through the weekly brief's send", async () => {
    nextErrors = [{ name: "invalid_from_address", message: "Invalid from address" }];
    const r = await sendWeeklyBrief({ ownerId: "u1", connectionId: "c1", weekStarting: new Date("2026-10-19T00:00:00Z"), recipient: "pm@example.com", email: EMAIL });
    expect(r).toMatchObject({ ok: false, senderSide: true });
  });
});

describe("7. moving the send day later in the week doesn't skip a week", () => {
  const ny = (day: number) => ({ day, hour: 8, timeZone: "America/New_York" });

  it("counts a brief emailed more than six days ago as last week's, even under the same week", () => {
    // Monday Oct 12's brief went out at 8:05; the owner then chose Sunday.
    const mondaySent = new Date("2026-10-12T12:05:00Z");
    const sundayRun = new Date("2026-10-18T12:15:00Z");
    const { scheduledAt, weekStarting } = lastScheduledSend(sundayRun, ny(0));
    expect(weekStarting.toISOString().slice(0, 10)).toBe("2026-10-12");
    expect(withinCatchUp(sundayRun, scheduledAt)).toBe(true);
    expect(sentForThisSchedule(mondaySent, sundayRun)).toBe(false);
    // Within the normal two-day window it still stands for this week's send.
    expect(sentForThisSchedule(mondaySent, new Date("2026-10-14T11:00:00Z"))).toBe(true);
    expect(sentForThisSchedule(null, sundayRun)).toBe(false);
    expect(RESEND_AFTER_MS).toBe(6 * DAY);
  });

  it("gives the second brief its own email keys, so the first one's don't stop it", async () => {
    const week = new Date("2026-10-12T00:00:00Z");
    const first = await sendWeeklyBrief({ ownerId: "u1", connectionId: "c1", weekStarting: week, recipient: "PM@example.com", email: EMAIL });
    const again = await sendWeeklyBrief({
      ownerId: "u1", connectionId: "c1", weekStarting: week, recipient: "pm@example.com", email: EMAIL, sendDay: new Date("2026-10-18T12:00:00Z"),
    });
    const retry = await sendWeeklyBrief({
      ownerId: "u1", connectionId: "c1", weekStarting: week, recipient: "pm@example.com", email: EMAIL, sendDay: new Date("2026-10-18T12:00:00Z"),
    });
    expect(first.ok && !first.skipped).toBe(true);
    expect(again.ok && !again.skipped).toBe(true);
    expect(retry).toMatchObject({ ok: true, skipped: true });
    expect(sent).toHaveLength(2);
    expect(fake.client.emailEvent.rows.map((r: any) => r.dedupeKey)).toEqual([
      "weekly_brief:c1:2026-10-12:pm@example.com",
      "weekly_brief:c1:2026-10-12:pm@example.com:2026-10-18",
    ]);
  });
});

describe("15. due briefs are worked in a fair order, and a run behind is reported", () => {
  const at = (iso: string) => new Date(iso);
  const due = (id: string, scheduled: string) => ({ connection: { id }, scheduledAt: at(scheduled) });

  it("puts the longest overdue first, then the company whose last brief went out longest ago", () => {
    const list = [due("b", "2026-10-19T12:00:00Z"), due("a", "2026-10-19T12:00:00Z"), due("c", "2026-10-19T12:00:00Z"), due("old", "2026-10-19T11:00:00Z"), due("new", "2026-10-19T12:00:00Z")];
    const last = new Map<string, Date | null>([
      ["a", at("2026-10-12T12:30:00Z")],
      ["b", at("2026-10-12T12:01:00Z")],
      ["c", at("2026-10-12T12:01:00Z")],
    ]);
    expect(orderDueBriefs(list, last).map((d) => d.connection.id)).toEqual(["old", "new", "b", "c", "a"]);
  });

  it("reports a brief left waiting for room more than an hour past its time", () => {
    const now = at("2026-10-19T13:30:00Z");
    expect(briefRunProblems([{ status: "deferred", waitingSince: at("2026-10-19T13:00:00Z") }], now).minutesLate).toBeNull();
    const behind = briefRunProblems([{ status: "deferred", waitingSince: at("2026-10-19T12:00:00Z") }, { status: "sent" }], now);
    expect(behind.minutesLate).toBe(90);
    expect(briefRunReports(behind).map((r) => [r.name, r.message])).toEqual([
      ["BriefRunBehind", "The weekly brief run is behind: the brief waiting longest is 90 minutes past its scheduled time."],
    ]);
  });
});

describe("3 and 4. a weekly run says what went wrong, once per kind", () => {
  it("counts briefs sent without the summary, refusals on our side and briefs that won't go out", () => {
    const p = briefRunProblems(
      [
        { status: "sent", summaryMissing: true },
        { status: "sent", summaryMissing: true },
        { status: "sent" },
        { status: "held", senderRefused: true },
        { status: "generated_not_sent", endsUnsent: true },
        { status: "gave_up", endsUnsent: true },
      ],
      NOW
    );
    expect(p).toEqual({ summariesMissing: 2, senderRefused: 1, refusedCompanies: 2, endedUnsent: 2, minutesLate: null, failed: true });
    expect(briefRunReports(p).map((r) => [r.name, r.message])).toEqual([
      ["BriefSummaryMissing", "2 weekly briefs went out without the written summary in this run."],
      [
        "BriefSendRefused",
        "The email provider refused every recipient of 1 weekly brief for a reason on our side (the sending domain, from address or API key). Each is tried again in an hour without using an attempt.",
      ],
      ["BriefNotSent", "2 weekly briefs won't go out this week: the last attempt failed, or every recipient was refused as the week's window closed."],
    ]);
  });

  it("counts the run as failed for a refusal on our side, or three companies refused, and not for one bad address", () => {
    expect(briefRunProblems([{ status: "generated_not_sent" }], NOW).failed).toBe(false);
    expect(briefRunProblems([{ status: "generated_not_sent" }, { status: "generated_not_sent" }, { status: "generated_not_sent" }], NOW).failed).toBe(true);
    expect(briefRunProblems([{ status: "held", senderRefused: true }], NOW).failed).toBe(true);
    expect(briefRunProblems([{ status: "sent" }, { status: "retry_later" }], NOW)).toMatchObject({ failed: false, summariesMissing: 0 });
    expect(briefRunReports(briefRunProblems([{ status: "sent" }], NOW))).toEqual([]);
  });
});

describe("6. a stale Settings save can't undo an unsubscribe", () => {
  const s = (emailRecipients: string[], emailEnabled = true, alertsEnabled = true) => ({ emailEnabled, emailRecipients, alertsEnabled });

  it("is stale when the stored list changed after the page loaded and the save would change it back", () => {
    const loaded = s(["owner@acme.com", "pm@acme.com"]);
    const current = s(["owner@acme.com"]);
    expect(staleEmailSettings(loaded, current, loaded)).toBe(true);
    // Brief switched off by the last recipient leaving.
    expect(staleEmailSettings(s(["pm@acme.com"]), s([], false), s(["pm@acme.com"]))).toBe(true);
    expect(staleEmailSettings(s(["a@x.com"], true, true), s(["a@x.com"], true, false), s(["a@x.com"], true, true))).toBe(true);
  });

  it("isn't when nothing changed meanwhile, or the save agrees with what's stored", () => {
    expect(staleEmailSettings(s(["a@x.com"]), s(["a@x.com"]), s(["a@x.com", "b@x.com"]))).toBe(false);
    expect(staleEmailSettings(s(["a@x.com", "b@x.com"]), s(["a@x.com"]), s(["a@x.com"]))).toBe(false);
    // Order, case and spacing don't count.
    expect(staleEmailSettings(s(["B@x.com", "a@x.com"]), s(["a@x.com", " b@x.com"]), s(["a@x.com", "c@x.com"]))).toBe(false);
  });

  it("reads what the page loaded from the save, and nothing from a page that sent none", () => {
    expect(loadedEmailSettings({ loaded: { emailEnabled: true, alertsEnabled: false, emailRecipients: ["a@x.com", 4] } })).toEqual({
      emailEnabled: true,
      alertsEnabled: false,
      emailRecipients: ["a@x.com"],
    });
    expect(loadedEmailSettings({})).toBeNull();
    expect(loadedEmailSettings({ loaded: { emailEnabled: "yes" } })).toBeNull();
  });

  it("sends what it loaded, and keeps what it saved as the new starting point", () => {
    const form = readFileSync(join(__dirname, "..", "..", "app", "dashboard", "settings", "SettingsForm.tsx"), "utf8");
    expect(form).toMatch(/marginTargets,\s+loaded,\s+\}\),/);
    expect(form).toContain("if (data?.saved) setLoaded(data.saved);");
  });
});

describe("5. alerts wait while a full sync is partway", () => {
  beforeEach(() => {
    profit.calls = 0;
  });

  it("judges, sends and settles nothing until the full read finishes", async () => {
    await fake.client.quickBooksConnection.create({
      data: { id: "c1", userId: "u1", realmIdHash: "h1", alertsBaselinedAt: NOW, fullSyncContinueAt: NOW, lastSyncError: null },
    });
    expect(await evaluateAlerts("c1", NOW)).toEqual({ pending: [], baseline: false, partway: true });
    expect(profit.calls).toBe(0);
  });

  it("goes ahead once it's finished, or when the read is down to once a day", async () => {
    await fake.client.quickBooksConnection.create({ data: { id: "c2", userId: "u1", realmIdHash: "h2", alertsBaselinedAt: NOW, fullSyncContinueAt: null } });
    expect((await evaluateAlerts("c2", NOW).catch((e) => e)).message).toBe("figures were read");
    await fake.client.quickBooksConnection.create({
      data: {
        id: "c3", userId: "u1", realmIdHash: "h3", alertsBaselinedAt: NOW, fullSyncContinueAt: NOW,
        lastSyncError: "Reading this company's QuickBooks history keeps running out of time, so some of its figures may be out of date.",
      },
    });
    expect((await evaluateAlerts("c3", NOW).catch((e) => e)).message).toBe("figures were read");
    expect(profit.calls).toBe(2);
  });
});

describe("12. a company QuickBooks refused gets its 7 days, counted from the refusal", () => {
  const RECONNECT = "Your QuickBooks connection has expired or was disconnected. Reconnect it in Settings.";
  const company = (id: string, over: Record<string, unknown>) =>
    fake.client.quickBooksConnection.create({
      data: {
        id, userId: "u1", realmIdHash: id, refreshToken: "x", connectedAt: new Date(NOW.getTime() - 400 * DAY),
        lastSyncStatus: "error", lastSyncError: RECONNECT, lastSyncedAt: new Date(NOW.getTime() - 120 * DAY), lastSyncAttemptAt: null, ...over,
      },
    });
  const rulesStart = new Date("2026-09-01T00:00:00Z");

  it("counts from the last attempt, never earlier than the rules began", () => {
    const base = { lastSyncedAt: new Date(NOW.getTime() - 120 * DAY), connectedAt: new Date(NOW.getTime() - 400 * DAY) };
    expect(revokedGraceOver({ ...base, lastSyncAttemptAt: new Date(NOW.getTime() - DAY) }, NOW, rulesStart)).toBe(false);
    expect(revokedGraceOver({ ...base, lastSyncAttemptAt: new Date(NOW.getTime() - 8 * DAY) }, NOW, rulesStart)).toBe(true);
    expect(revokedGraceOver({ ...base, lastSyncAttemptAt: new Date(NOW.getTime() - 8 * DAY) }, NOW, new Date(NOW.getTime() - 3 * DAY))).toBe(false);
    expect(revokedGraceOver({ lastSyncAttemptAt: null, lastSyncedAt: null, connectedAt: new Date(NOW.getTime() - 2 * DAY) }, NOW, rulesStart)).toBe(false);
  });

  it("leaves a returning customer whose first sync back was just refused, and disconnects one refused 8 days ago", async () => {
    await company("back", { lastSyncAttemptAt: new Date(NOW.getTime() - 3_600_000) });
    await company("gone", { lastSyncAttemptAt: new Date(NOW.getTime() - 8 * DAY) });
    await company("fine", { lastSyncStatus: "success", lastSyncError: null, lastSyncAttemptAt: new Date(NOW.getTime() - 8 * DAY) });
    const done = await disconnectRevokedGrants(NOW, rulesStart);
    expect(done.map((c) => c.id)).toEqual(["gone"]);
    const rows = fake.client.quickBooksConnection.rows;
    expect(rows.find((r: any) => r.id === "back").disconnectedAt).toBeNull();
  });

  it("starts no clock before the rules began", async () => {
    await company("old", { lastSyncAttemptAt: new Date(NOW.getTime() - 30 * DAY) });
    expect(await disconnectRevokedGrants(NOW, new Date(NOW.getTime() - 2 * DAY))).toEqual([]);
  });

  it("is what the lifecycle job runs, with the rules' start", () => {
    const cron = readFileSync(join(__dirname, "..", "..", "app", "api", "cron", "lifecycle", "route.ts"), "utf8");
    expect(cron).toContain("await disconnectRevokedGrants(now, rulesStart)");
    // And the weekly brief doesn't retry a refused company, which would move the refusal's time.
    const weekly = readFileSync(join(__dirname, "..", "..", "app", "api", "cron", "weekly-email", "route.ts"), "utf8");
    expect(weekly).toContain("!waitingForReconnect &&");
  });
});

describe("12. an account is disconnected as lapsed only if it still is", () => {
  const lapsedOwner = (sub: Record<string, unknown>) => {
    const row = {
      id: "c1", userId: "u1", realmIdHash: "h1", refreshToken: "x", disconnectedAt: null, connectedAt: new Date("2026-01-01T00:00:00Z"),
      user: { createdAt: new Date("2026-01-01T00:00:00Z"), subscription: { trialEndsAt: null, currentPeriodEnd: null, canceledAt: null, stripeSubscriptionId: null, ...sub } },
    };
    fake.client.quickBooksConnection.rows.push({ ...row, user: undefined });
    fake.client.quickBooksConnection.findMany = async () => [row];
  };
  const longAgo = new Date(NOW.getTime() - 200 * DAY);
  const rulesStart = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    ent.active = false;
    ent.access = "trial_expired";
    ent.calls = [];
  });

  it("disconnects an account still without a plan after 90 days", async () => {
    lapsedOwner({ status: "trial_expired", trialEndsAt: longAgo, updatedAt: longAgo });
    expect((await disconnectLapsedCompanies(NOW, rulesStart)).map((c) => c.id)).toEqual(["c1"]);
  });

  it("leaves one that is live again by the time it's reached", async () => {
    lapsedOwner({ status: "trial_expired", trialEndsAt: longAgo, updatedAt: longAgo });
    ent.active = true;
    ent.access = "active";
    expect(await disconnectLapsedCompanies(NOW, rulesStart)).toEqual([]);
    expect(ent.calls).toEqual(["u1"]);
  });

  it("reads a Stripe subscription stored as trialing or trial_expired as live, as getEntitlements does", async () => {
    for (const status of ["trialing", "trial_expired"]) {
      expect(accessEndedAt({ status, trialEndsAt: longAgo, currentPeriodEnd: null, canceledAt: null, updatedAt: longAgo, stripeSubscriptionId: "sub_1" } as any, longAgo, NOW)).toBeNull();
      expect(accessEndedAt({ status, trialEndsAt: longAgo, currentPeriodEnd: null, canceledAt: null, updatedAt: longAgo, stripeSubscriptionId: null } as any, longAgo, NOW)).toEqual(longAgo);
    }
    lapsedOwner({ status: "trial_expired", trialEndsAt: longAgo, updatedAt: longAgo, stripeSubscriptionId: "sub_1" });
    expect(await disconnectLapsedCompanies(NOW, rulesStart)).toEqual([]);
    const lib = readFileSync(join(__dirname, "..", "companyData.ts"), "utf8");
    expect(lib).toContain('{ subscription: { status: "trialing", trialEndsAt: { lt: now }, stripeSubscriptionId: null } }');
  });
});

describe("13. testimonial requests move on to people not yet asked", () => {
  it("leaves out those already asked or with tips off, in a fixed order", () => {
    const cron = readFileSync(join(__dirname, "..", "..", "app", "api", "cron", "lifecycle", "route.ts"), "utf8").replace(/\s+/g, " ");
    expect(cron).toContain('emailEvents: { none: { emailType: "testimonial_request", status: "sent" } }');
    expect(cron).toContain("tipsEmailsOffAt: null,");
    expect(cron).toContain('orderBy: [{ firstPaidAt: "asc" }, { userId: "asc" }], take: 200,');
  });
});

describe("job type suggestions read an estimate on a parent customer as the job's only from shortly before the job", () => {
  beforeEach(() => {
    fake.client.jobEstimate = new FakeModel("jobEstimate");
  });
  const setup = async (estimateDate: string) => {
    await fake.client.job.create({
      data: {
        id: "j1", connectionId: "c1", qboId: "P1:1", parentQboId: "P1", qboCreatedAt: new Date("2026-06-01T00:00:00Z"),
        name: "Smith Residence", customerName: "Smith", status: "open", statusOverride: null, missingSince: null, category: null,
        suggestedCategory: null, suggestionSource: null, suggestionReason: null,
      },
    });
    await fake.client.jobEstimate.create({
      data: {
        connectionId: "c1", customerQboId: "P1", amount: 20_000, status: "Accepted", txnDate: new Date(estimateDate),
        lines: [{ n: "Roof tear-off and shingles", c: "materials", a: 20_000 }],
      },
    });
    const types = [{ value: "roofing", label: "Roofing", hidden: false, builtIn: true }];
    return (await getJobTypeSuggestions("c1", types)).rows[0];
  };

  it("uses one dated just before the job was set up", async () => {
    expect(await setup("2026-05-01T00:00:00Z")).toMatchObject({ suggested: "roofing", source: "estimate" });
  });

  it("leaves one from the customer's history before this job", async () => {
    expect(await setup("2025-01-01T00:00:00Z")).toMatchObject({ suggested: null, source: null });
  });
});
