import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeModel } from "./support/fakePrisma";

// Audit of 2026-10-19, the routes: the weekly brief job (refusals on our
// side held and reported, the week's last attempt reported once, a full
// sync partway waited for, a second brief when the send day moves later, no
// retry of a company QuickBooks refused, a fair order, summaries missing
// reported, a failed check-in when refusals are high), the Generate and
// Refresh Analysis buttons (paused, disconnected and partway companies, AI
// failures reported) and the Settings save (stale lists refused).

// --- Stand-ins ----------------------------------------------------------------

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body, json: async () => body }),
  },
}));

/** The weekly digests, keyed the way the routes ask for them. */
function digestModel() {
  const rows: any[] = [];
  const key = (w: any) => w.connectionId_weekStarting;
  const find = (w: any) => rows.find((r) => r.connectionId === key(w).connectionId && r.weekStarting.getTime() === key(w).weekStarting.getTime());
  return {
    rows,
    findUnique: async ({ where }: any) => {
      db.calls.push(`weeklyDigest.findUnique:${key(where).connectionId}`);
      const r = find(where);
      return r ? { ...r } : null;
    },
    upsert: async ({ where, create, update }: any) => {
      const r = find(where);
      if (r) return Object.assign(r, update);
      const row = { id: `d${rows.length + 1}`, emailedAt: null, ...create };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: any) => Object.assign(rows.find((r) => r.id === where.id), data),
    groupBy: async ({ where }: any) => {
      const out = new Map<string, Date>();
      for (const r of rows) {
        if (!where.connectionId.in.includes(r.connectionId) || !r.emailedAt) continue;
        const cur = out.get(r.connectionId);
        if (!cur || r.emailedAt > cur) out.set(r.connectionId, r.emailedAt);
      }
      return [...out].map(([connectionId, emailedAt]) => ({ connectionId, _max: { emailedAt } }));
    },
  };
}

const db: {
  quickBooksConnection: FakeModel;
  user: FakeModel;
  weeklyDigest: ReturnType<typeof digestModel>;
  calls: string[];
  [k: string]: any;
} = { quickBooksConnection: new FakeModel("c"), user: new FakeModel("u"), weeklyDigest: digestModel(), calls: [] };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return db;
  },
}));

const reports: { err: any; ctx: any }[] = [];
const checkIns: unknown[] = [];
vi.mock("@/lib/monitoring", () => ({
  reportError: async (err: unknown, ctx: unknown) => {
    reports.push({ err, ctx });
    return { sent: false, reason: "no_dsn" };
  },
  withCronMonitor: async (_slug: string, _schedule: string, run: () => Promise<unknown>) => {
    const result = await run();
    checkIns.push(result);
    return result;
  },
}));
vi.mock("@/lib/cronAuth", () => ({ authorizeCron: () => ({ ok: true }) }));

class SummaryOutOfTimeError extends Error {}
const brief = {
  summaryMissing: false,
  fail: null as Error | null,
  calls: [] as { connectionId: string; opts: any }[],
};
vi.mock("@/lib/digest", () => ({
  SummaryOutOfTimeError,
  summaryToReuse: () => null,
  withSummaryForRetry: (m: unknown) => m,
  generateWeeklyDigestForConnection: async (connectionId: string, _week: Date, _name: string, opts: any) => {
    brief.calls.push({ connectionId, opts });
    if (brief.fail) throw brief.fail;
    return {
      narrative: "n", kind: "narrative", metrics: { jobs: [] }, body: "b", weekOverWeek: {}, headline: null, tiles: {}, summaryMissing: brief.summaryMissing,
      summaryFailure: brief.summaryMissing ? { kind: "refused", message: "400 inference_geo is not supported for this model" } : null,
    };
  },
}));
const syncs: string[] = [];
vi.mock("@/lib/quickbooksSync", () => ({
  COST_SYNC_VERSION: 1,
  SYNC_VERSION: 1,
  SyncAlreadyRunningError: class extends Error {},
  FullSyncNotAllowedError: class extends Error {},
  runSyncForConnection: async (id: string) => {
    syncs.push(id);
    return { ok: true };
  },
}));
vi.mock("@/lib/jobSetup", () => ({ jobSourceQuestionPending: () => false }));
vi.mock("@/lib/email/briefEmail", () => ({ renderBriefEmail: () => ({ subject: "s", html: "h", text: "t", headers: {} }) }));
const sends: { sendDay: Date | null | undefined; connectionId: string; recipient: string }[] = [];
const sendResult: { next: Record<string, unknown> } = { next: { ok: true } };
vi.mock("@/lib/email/lifecycle", () => ({
  sendBriefOnHold: async () => ({ ok: true }),
  sendWeeklyBrief: async (input: any) => {
    sends.push({ sendDay: input.sendDay, connectionId: input.connectionId, recipient: input.recipient });
    return sendResult.next;
  },
  tryAnnounceAnalysisReady: async () => {},
}));
const plan = { paused: new Set<string>() };
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: async () => ({ active: true, access: "active", limits: { maxConnections: 1 }, has: () => true }),
  inactiveMessage: () => "inactive",
}));
vi.mock("@/lib/planLimits", () => ({
  overLimitConnectionIds: async () => plan.paused,
  pausedCompaniesMessage: (names: string[]) => `${names.join(", ")} is paused.`,
}));
const login: { account: any; connection: any } = { account: null, connection: null };
vi.mock("@/lib/account", () => ({
  getAccount: async () => login.account,
  refuseClient: () => null,
  connectionForAccount: async () => login.connection,
  canSeeConnection: () => true,
}));
vi.mock("@/lib/trial", () => ({ tryMarkFirstAnalysis: async () => {} }));
const insights: { fail: Error | null } = { fail: null };
vi.mock("@/lib/intelligence", () => ({
  generateProfitInsights: async () => {
    if (insights.fail) throw insights.fail;
    return [];
  },
}));
vi.mock("@/lib/opportunityData", () => ({
  getOpportunityData: async () => ({
    feed: { items: [{ section: "now", kind: "open_job_forecast", title: "MX04", finding: "f", cause: null, action: "a", impactKind: "profit", impact: 100, confidence: "high", jobIds: ["j1"] }] },
    profitData: { needsAttention: [] },
  }),
}));
vi.mock("@/lib/jobTypesServer", () => ({ getJobTypes: async () => [] }));
vi.mock("@/lib/sameOrigin", () => ({ refuseCrossSite: () => null }));
class SuggestionCooldownError extends Error {}
const suggest: { fail: Error | null; calls: number } = { fail: null, calls: 0 };
vi.mock("@/lib/jobTypeSuggestions", () => ({
  SuggestionCooldownError,
  suggestJobTypesWithAI: async () => {
    suggest.calls++;
    if (suggest.fail) throw suggest.fail;
    return { asked: 1, suggested: 1 };
  },
}));

import { GET as weeklyEmail } from "../../app/api/cron/weekly-email/route";
import { POST as generate } from "../../app/api/digest/generate/route";
import { POST as refresh } from "../../app/api/analysis/refresh/route";
import { POST as saveSettings } from "../../app/api/settings/profile/route";
import { POST as suggestTypes } from "../../app/api/jobs/suggest-types/route";
import { lastScheduledSend } from "../schedule";

// --- The weekly brief job --------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Due now: scheduled for this hour, in UTC. */
function schedule() {
  const now = new Date();
  return { emailDay: now.getUTCDay(), emailHour: now.getUTCHours(), emailTimezone: "UTC" };
}
const thisWeek = () => lastScheduledSend(new Date(), { day: new Date().getUTCDay(), hour: new Date().getUTCHours(), timeZone: "UTC" }).weekStarting;

async function company(id: string, over: Record<string, unknown> = {}) {
  await db.quickBooksConnection.create({
    data: {
      id, userId: "owner", realmIdHash: id, companyName: id, disconnectedAt: null, emailEnabled: true, emailRecipients: ["pm@example.com"],
      ...schedule(), briefAttemptWeek: null, briefAttempts: 0, briefClaimedAt: null, syncVersion: 1,
      lastSyncedAt: new Date(), lastSyncStatus: "success", lastSyncError: null, lastSyncAttemptAt: new Date(Date.now() - 2 * HOUR),
      lastFullSyncAt: new Date(), fullSyncContinueAt: null, jobSource: "projects",
      ...over,
    },
  });
}
const row = (id: string): any => db.quickBooksConnection.rows.find((r: any) => r.id === id);
const run = async () => {
  const res: any = await weeklyEmail({} as any);
  return { status: res.status as number, body: res.body as any, result: (id: string) => res.body.results.find((r: any) => r.connectionId === id) };
};
const reported = () => reports.map((r) => r.err.name);

beforeEach(async () => {
  db.quickBooksConnection = new FakeModel("c");
  db.user = new FakeModel("u");
  db.weeklyDigest = digestModel();
  db.calls = [];
  await db.user.create({ data: { id: "owner", email: "owner@example.com", emailVerifiedAt: new Date() } });
  reports.length = 0;
  checkIns.length = 0;
  sends.length = 0;
  syncs.length = 0;
  brief.calls = [];
  brief.fail = null;
  brief.summaryMissing = false;
  sendResult.next = { ok: true };
  plan.paused = new Set();
});

describe("4. a brief refused on our side is held, not given up on", () => {
  it("gives the attempt back, holds the company an hour, reports it once and fails the check-in", async () => {
    await company("a");
    await company("b");
    sendResult.next = { ok: false, senderSide: true, error: "The jobprofitai.com domain is not verified." };
    const r = await run();
    expect(r.result("a")).toMatchObject({ status: "held", senderRefused: true });
    expect(row("a").briefAttempts).toBe(0);
    expect(row("a").briefClaimedAt.getTime()).toBeGreaterThan(Date.now() + 45 * 60_000);
    expect(reported()).toEqual(["BriefSendRefused"]);
    expect(reports[0].err.message).toContain("2 weekly briefs");
    expect(reports[0].ctx).toEqual({ cron: "weekly-email" });
    expect(r.status).toBe(500);
    expect(r.body.ok).toBe(false);
  });

  it("uses the attempt for a refused address, and says nothing until the week's last one", async () => {
    await company("a");
    sendResult.next = { ok: false, error: "Invalid `to` field." };
    const r = await run();
    expect(r.result("a")).toMatchObject({ status: "generated_not_sent" });
    expect(r.result("a").endsUnsent).toBeUndefined();
    expect(row("a").briefAttempts).toBe(1);
    expect(reports).toHaveLength(0);
    expect(r.status).toBe(200);
  });

  it("reports a brief whose last attempt failed, once, and marks it so", async () => {
    await company("a", { briefAttemptWeek: thisWeek(), briefAttempts: 4 });
    sendResult.next = { ok: false, error: "Invalid `to` field." };
    const r = await run();
    expect(r.result("a")).toMatchObject({ status: "generated_not_sent", endsUnsent: true });
    expect(row("a").briefAttempts).toBe(6);
    expect(reported()).toEqual(["BriefNotSent"]);
    reports.length = 0;
    expect((await run()).result("a").status).toBe("gave_up");
    expect(reports).toHaveLength(0);
  });

  it("reports one whose last attempt's run died before it could say, once", async () => {
    await company("a", { briefAttemptWeek: thisWeek(), briefAttempts: 5 });
    expect((await run()).result("a")).toMatchObject({ status: "gave_up", endsUnsent: true });
    expect(reported()).toEqual(["BriefNotSent"]);
    reports.length = 0;
    await run();
    expect(reports).toHaveLength(0);
  });

  it("doesn't call a brief that went out on its last attempt given up", async () => {
    await company("a", { briefAttemptWeek: thisWeek(), briefAttempts: 5 });
    await db.weeklyDigest.upsert({
      where: { connectionId_weekStarting: { connectionId: "a", weekStarting: thisWeek() } },
      create: { connectionId: "a", weekStarting: thisWeek(), emailedAt: new Date(Date.now() - HOUR) },
      update: {},
    });
    expect((await run()).result("a")).toMatchObject({ status: "skipped" });
    expect(reports).toHaveLength(0);
  });
});

describe("3. a run reports the briefs that went without their summary", () => {
  it("once, with the count", async () => {
    await company("a");
    await company("b");
    brief.summaryMissing = true;
    const r = await run();
    expect(r.result("a")).toMatchObject({ status: "sent", summaryMissing: true });
    expect(reports.map((x) => [x.err.name, x.err.message])).toEqual([
      [
        "BriefSummaryMissing",
        "2 weekly briefs went out without the written summary in this run (refused by Anthropic: 2). The first refusal said: 400 inference_geo is not supported for this model",
      ],
    ]);
    expect(r.status).toBe(200);
  });
});

describe("5. a company whose full sync is partway waits, without using an attempt", () => {
  it("is deferred before it's claimed", async () => {
    await company("a", { fullSyncContinueAt: new Date() });
    const r = await run();
    expect(r.result("a")).toEqual({ connectionId: "a", status: "deferred", detail: "waiting for the full sync to finish" });
    expect(row("a").briefAttempts).toBe(0);
    expect(row("a").briefClaimedAt).toBeNull();
    expect(brief.calls).toHaveLength(0);
    expect(reports).toHaveLength(0);
  });

  it("still waits when the read's last try failed: it's tried again within hours", async () => {
    await company("a", { fullSyncContinueAt: new Date(Date.now() + 2 * HOUR), lastSyncStatus: "error", lastSyncError: "QuickBooks API query failed" });
    expect((await run()).result("a")).toMatchObject({ status: "deferred", detail: "waiting for the full sync to finish" });
    expect(reports).toHaveLength(0);
  });

  it("waits a day past the brief's time at most, then goes from what's synced and is reported, failing or not", async () => {
    const then = new Date(Date.now() - 25 * HOUR);
    await company("b", {
      fullSyncContinueAt: new Date(Date.now() + DAY), lastSyncStatus: "error", lastSyncError: "QuickBooks API query failed",
      emailDay: then.getUTCDay(), emailHour: then.getUTCHours(),
    });
    expect((await run()).result("b")).toMatchObject({ status: "sent", sentPartway: true });
    expect(reported()).toEqual(["BriefSentPartway"]);
  });

  it("waits a day past the brief's time at most", async () => {
    const then = new Date(Date.now() - 25 * HOUR);
    await company("a", { fullSyncContinueAt: new Date(), emailDay: then.getUTCDay(), emailHour: then.getUTCHours() });
    expect((await run()).result("a")).toMatchObject({ status: "sent", sentPartway: true });
    expect(reported()).toEqual(["BriefSentPartway"]);
  });
});

describe("7. a sent brief gives its attempts back", () => {
  it("starts the week's count again, so a second brief this week isn't given up on", async () => {
    await company("a", { briefAttemptWeek: thisWeek(), briefAttempts: 3 });
    expect((await run()).result("a").status).toBe("sent");
    expect(row("a").briefAttempts).toBe(0);
  });
});

describe("7. a send day moved later in the week sends the next brief", () => {
  it("sends again when the week's brief went out more than six days ago, with its own keys", async () => {
    await company("a");
    await db.weeklyDigest.upsert({
      where: { connectionId_weekStarting: { connectionId: "a", weekStarting: thisWeek() } },
      create: { connectionId: "a", weekStarting: thisWeek(), emailedAt: new Date(Date.now() - 6 * DAY - HOUR) },
      update: {},
    });
    expect((await run()).result("a").status).toBe("sent");
    expect(sends).toHaveLength(1);
    expect(sends[0].sendDay).toBeInstanceOf(Date);
    // Compared with the brief already sent this week (point 6 of the review).
    expect(brief.calls[0].opts.secondThisWeek).toBe(true);
  });

  it("doesn't when it went out within the six days", async () => {
    await company("a");
    await db.weeklyDigest.upsert({
      where: { connectionId_weekStarting: { connectionId: "a", weekStarting: thisWeek() } },
      create: { connectionId: "a", weekStarting: thisWeek(), emailedAt: new Date(Date.now() - 2 * DAY) },
      update: {},
    });
    expect((await run()).result("a")).toMatchObject({ status: "skipped", detail: "already emailed this week" });
    expect(sends).toHaveLength(0);
  });

  it("sends a first brief of the week with the usual keys", async () => {
    await company("a");
    await run();
    expect(sends[0].sendDay).toBeNull();
    expect(brief.calls[0].opts.secondThisWeek).toBe(false);
  });
});

describe("12. the weekly brief doesn't retry a company QuickBooks refused", () => {
  it("syncs a stale company first, but not one waiting for a reconnect", async () => {
    const stale = { lastSyncedAt: new Date(Date.now() - 2 * DAY), lastSyncAttemptAt: new Date(Date.now() - 2 * DAY) };
    await company("ok", stale);
    await company("refused", {
      ...stale,
      lastSyncStatus: "error",
      lastSyncError: "Your QuickBooks connection has expired or was disconnected. Reconnect it in Settings.",
    });
    await run();
    expect(syncs).toEqual(["ok"]);
  });
});

describe("15. companies due at the same moment go oldest brief first", () => {
  it("starts the one whose last brief went out longest ago", async () => {
    await company("recent");
    await company("never");
    await company("older");
    const lastWeek = new Date(thisWeek().getTime() - 7 * DAY);
    for (const [id, at] of [["recent", 6.5 * DAY], ["older", 8 * DAY]] as const) {
      await db.weeklyDigest.upsert({
        where: { connectionId_weekStarting: { connectionId: id, weekStarting: lastWeek } },
        create: { connectionId: id, weekStarting: lastWeek, emailedAt: new Date(Date.now() - at) },
        update: {},
      });
    }
    await run();
    const firstLook = db.calls.filter((c) => c.startsWith("weeklyDigest.findUnique")).slice(0, 3);
    expect(firstLook).toEqual(["weeklyDigest.findUnique:never", "weeklyDigest.findUnique:older", "weeklyDigest.findUnique:recent"]);
  });
});

// --- The Generate and Refresh Analysis buttons -----------------------------------

const post = (body: unknown) => ({ json: async () => body }) as any;
const BAD_REQUEST = Object.assign(new Error("400 inference_geo is not supported for this model"), { status: 400 });
const TIMED_OUT = Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" });

describe("14 and 5. the Generate button", () => {
  beforeEach(async () => {
    login.account = { userId: "owner", ownerId: "owner", role: "owner", connectionId: null };
    login.connection = { id: "a", userId: "owner", companyName: "Acme", emailTimezone: "UTC", fullSyncContinueAt: null, lastSyncError: null };
    db.quickBooksConnection = new FakeModel("c");
    await db.quickBooksConnection.create({ data: { id: "a", aiBriefAt: null } });
  });

  it("makes no brief for a disconnected company or one past the plan's limit", async () => {
    login.connection = null;
    expect((await generate(post({ connectionId: "a" }))).status).toBe(404);
    login.connection = { id: "a", userId: "owner", companyName: "Acme" };
    plan.paused = new Set(["a"]);
    const res: any = await generate(post({ connectionId: "a" }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("company_paused");
    expect(brief.calls).toHaveLength(0);
  });

  it("waits while a full sync is partway", async () => {
    login.connection = { ...login.connection, fullSyncContinueAt: new Date() };
    const res: any = await generate(post({ connectionId: "a" }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "Your QuickBooks history is still being read, so the brief would show costs without their invoices. It's made once the read finishes, usually overnight.",
      code: "sync_partway",
    });
    expect(brief.calls).toHaveLength(0);
    // Not once the read's last try failed: a stuck read would hold it for good.
    login.connection = { ...login.connection, lastSyncStatus: "error" };
    expect((await generate(post({ connectionId: "a" }))).status).toBe(200);
  });

  it("reports a refused AI request, and not a timeout or a run out of time", async () => {
    brief.fail = BAD_REQUEST;
    expect((await generate(post({ connectionId: "a" }))).status).toBe(500);
    expect(reports.map((r) => r.ctx)).toEqual([{ route: "/api/digest/generate", method: "POST", feature: "brief-summary" }]);
    reports.length = 0;
    for (const fail of [TIMED_OUT, new SummaryOutOfTimeError("no time")]) {
      db.quickBooksConnection.rows[0].aiBriefAt = null;
      brief.fail = fail;
      expect((await generate(post({ connectionId: "a" }))).status).toBe(500);
    }
    expect(reports).toHaveLength(0);
  });

  it("makes the brief for a company it covers", async () => {
    expect((await generate(post({ connectionId: "a" }))).status).toBe(200);
  });
});

describe("14. Refresh Analysis", () => {
  beforeEach(async () => {
    login.account = { userId: "owner", ownerId: "owner", role: "owner", connectionId: null };
    login.connection = { id: "a", userId: "owner", companyName: "Acme", lastSyncedAt: new Date() };
    insights.fail = null;
    db.quickBooksConnection = new FakeModel("c");
    await db.quickBooksConnection.create({ data: { id: "a", aiAnalysisAt: null } });
    db.analysisRun = { findFirst: async () => null, create: async () => ({}) };
    db.profitInsight = { findMany: async () => [], count: async () => 0, deleteMany: async () => ({}), createMany: async () => ({}) };
    db.$transaction = async (ops: unknown[]) => Promise.all(ops);
  });

  it("does nothing for a disconnected company or one past the plan's limit", async () => {
    login.connection = null;
    expect((await refresh(post({ connectionId: "a" }))).status).toBe(404);
    login.connection = { id: "a", userId: "owner", companyName: "Acme" };
    plan.paused = new Set(["a"]);
    const res: any = await refresh(post({ connectionId: "a" }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("company_paused");
  });

  it("reports a refused AI request with the feature named", async () => {
    insights.fail = Object.assign(new Error("401 invalid x-api-key"), { status: 401 });
    expect((await refresh(post({ connectionId: "a", force: true }))).status).toBe(500);
    expect(reports.map((r) => r.ctx)).toEqual([{ route: "/api/analysis/refresh", method: "POST", feature: "profit-insights" }]);
  });

  it("refreshes for a company it covers", async () => {
    expect((await refresh(post({ connectionId: "a", force: true }))).body).toMatchObject({ ok: true, refreshed: true });
  });
});

describe("14 and 3. AI job type suggestions", () => {
  beforeEach(() => {
    login.account = { userId: "owner", ownerId: "owner", role: "owner", connectionId: null };
    login.connection = { id: "a", userId: "owner", companyName: "Acme" };
    suggest.fail = null;
    suggest.calls = 0;
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  it("does nothing for a company past the plan's limit", async () => {
    plan.paused = new Set(["a"]);
    const res: any = await suggestTypes(post({ connectionId: "a" }));
    expect(res.status).toBe(403);
    expect(suggest.calls).toBe(0);
  });

  it("reports a refused AI request, and not the cooldown or a timeout", async () => {
    suggest.fail = BAD_REQUEST;
    expect((await suggestTypes(post({ connectionId: "a" }))).status).toBe(500);
    expect(reports.map((r) => r.ctx)).toEqual([{ route: "/api/jobs/suggest-types", method: "POST", feature: "job-type-suggestions" }]);
    reports.length = 0;
    suggest.fail = new SuggestionCooldownError("wait");
    expect((await suggestTypes(post({ connectionId: "a" }))).status).toBe(429);
    suggest.fail = TIMED_OUT;
    expect((await suggestTypes(post({ connectionId: "a" }))).status).toBe(500);
    expect(reports).toHaveLength(0);
  });
});

// --- The Settings save -------------------------------------------------------------

describe("6. a Settings save opened before an unsubscribe can't undo it", () => {
  const stored = { emailEnabled: true, emailRecipients: ["owner@acme.com"], alertsEnabled: true };
  let writes: any[];
  let changedMeanwhile: boolean;
  beforeEach(() => {
    login.account = { userId: "owner", ownerId: "owner", role: "owner", connectionId: null };
    writes = [];
    changedMeanwhile = false;
    db.quickBooksConnection = {
      findUnique: async () => ({ id: "a", userId: "owner", jobSource: "projects", laborFromTimeEntries: true, laborBurdenPct: null, ...stored }),
      updateMany: async ({ where, data }: any) => {
        const same =
          !changedMeanwhile &&
          where.emailEnabled === stored.emailEnabled &&
          where.alertsEnabled === stored.alertsEnabled &&
          JSON.stringify(where.emailRecipients.equals) === JSON.stringify(stored.emailRecipients);
        if (same) writes.push(data);
        return { count: same ? 1 : 0 };
      },
    } as any;
  });
  const form = (loaded: unknown, recipients = ["owner@acme.com", "pm@acme.com"]) =>
    post({
      connectionId: "a", targetMarginPct: 25, overheadEnabled: false, emailEnabled: true, emailRecipients: recipients,
      emailDay: 1, emailHour: 8, emailTimezone: "America/New_York", alertsEnabled: true, marginTargets: {}, ...(loaded ? { loaded } : {}),
    });

  it("refuses to put back an address removed after the page loaded", async () => {
    const res: any = await saveSettings(form({ emailEnabled: true, emailRecipients: ["owner@acme.com", "pm@acme.com"], alertsEnabled: true }));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("These settings changed since you opened this page. Reload to see the latest, then save again.");
    expect(writes).toHaveLength(0);
  });

  it("saves when nothing changed after the page loaded, and says what it saved", async () => {
    const res: any = await saveSettings(form({ emailEnabled: true, emailRecipients: ["owner@acme.com"], alertsEnabled: true }));
    expect(res.status).toBe(200);
    expect(res.body.saved).toEqual({ emailEnabled: true, emailRecipients: ["owner@acme.com", "pm@acme.com"], alertsEnabled: true });
    expect(writes[0].emailRecipients).toEqual(["owner@acme.com", "pm@acme.com"]);
  });

  it("refuses when the list changes between the check and the write", async () => {
    changedMeanwhile = true;
    expect((await saveSettings(form({ emailEnabled: true, emailRecipients: ["owner@acme.com"], alertsEnabled: true }))).status).toBe(409);
  });

  it("still saves from a page that sends nothing to check against", async () => {
    expect((await saveSettings(form(null))).status).toBe(200);
  });
});
