import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { FakeModel } from "./support/fakePrisma";

// Audit of 2026-10-27, the Weekly Profit Brief, profit alerts, scheduled jobs
// and emails (E1 to E13, SEC1, SEC2/E8, SEC4). The weekly run is driven end
// to end here: the real route, digest, email rendering, email client and
// Sentry reporting, with the database, the Anthropic SDK, Resend, the
// QuickBooks sync and fetch (for Sentry) stood in for.

// --- Stand-ins ----------------------------------------------------------------

// Made in vi.hoisted: the vi.mock factories below run before the rest of this
// file, so whatever they use is declared here.
const h = vi.hoisted(() => ({
  db: {} as any,
  ai: {
    replies: [] as (string | Error | { stop: string; text?: string })[],
    calls: [] as any[],
    /** Runs while the write-up is being asked for (a test moves the clock in it). */
    during: null as null | (() => void),
  },
  mail: {
    sent: [] as { to: string; subject: string; text: string; html: string }[],
    /** What the next send to an address does: refused for being busy, no answer at all, or no answer until it's aborted. */
    behave: {} as Record<string, "busy" | "hang" | "abortable">,
    /** The status of each address's send record at the moment Resend was called. */
    statusAtSend: [] as (string | null)[],
    /** Whether each send was given an abort signal. */
    signals: [] as boolean[],
  },
  sync: { calls: [] as string[], during: null as null | (() => Promise<unknown>) },
  /** What routes handed to next/server's after(). */
  after: [] as Promise<unknown>[],
  entitled: true,
  login: { account: null as any },
  stripe: {
    subscriptions: {} as Record<string, any>,
    lists: {} as Record<string, any[]>,
    retrieved: [] as string[],
    events: [] as any[],
  },
  SyncAlreadyRunningError: class SyncAlreadyRunningError extends Error {},
}));

vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return h.db;
  },
}));
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages: { create: (params: any) => Promise<any> };
    constructor() {
      this.messages = {
        create: async (params: any) => {
          h.ai.calls.push(params);
          h.ai.during?.();
          const next = h.ai.replies.shift() ?? "Torres Kitchen has $30,000 spent so far. It has $25,000 billed.";
          if (next instanceof Error) throw next;
          if (typeof next === "object") return { stop_reason: next.stop, content: next.text == null ? [] : [{ type: "text", text: next.text }] };
          return { stop_reason: "end_turn", content: [{ type: "text", text: next }] };
        },
      };
    }
  }
  return { __esModule: true, default: FakeAnthropic };
});
// Resend's v3 contract: send() resolves with { data, error } and doesn't throw.
vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: (payload: any, options?: any) => {
        const to = String(payload.to[0]).toLowerCase();
        const row = (h.db.emailEvent?.rows ?? []).find((r: any) => r.toEmail.toLowerCase() === to && !r.dedupeKey.startsWith("failed:"));
        h.mail.statusAtSend.push(row?.status ?? null);
        h.mail.signals.push(options?.signal instanceof AbortSignal);
        const behave = h.mail.behave[to];
        delete h.mail.behave[to];
        if (behave === "hang") return new Promise(() => {});
        // What Resend 3.5.0 returns when fetch is aborted (its fetchRequest catch).
        if (behave === "abortable") {
          return new Promise((resolve) =>
            options.signal.addEventListener("abort", () =>
              resolve({ data: null, error: { name: "application_error", message: "Unable to fetch data. The request could not be resolved." } })
            )
          );
        }
        if (behave === "busy") return Promise.resolve({ data: null, error: { name: "rate_limit_exceeded", message: "Too many requests" } });
        h.mail.sent.push({ to, subject: payload.subject, text: payload.text, html: payload.html });
        return Promise.resolve({ data: { id: `msg_${h.mail.sent.length}` }, error: null });
      },
    };
  },
}));
vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) },
  after: (task: Promise<unknown> | (() => unknown)) => {
    h.after.push(Promise.resolve(typeof task === "function" ? task() : task));
  },
}));
vi.mock("@/lib/cronAuth", () => ({ authorizeCron: () => ({ ok: true }) }));
vi.mock("@/lib/quickbooksSync", () => ({
  COST_SYNC_VERSION: 7,
  SYNC_VERSION: 7,
  SyncAlreadyRunningError: h.SyncAlreadyRunningError,
  FullSyncNotAllowedError: class extends Error {},
  FULL_SYNC_TOO_LONG_MESSAGE: "Reading this company's QuickBooks history keeps running out of time.",
  fullSyncDue: () => false,
  holdFullSyncForSkippedCompany: async () => {},
  runSyncForConnection: async (id: string) => {
    h.sync.calls.push(id);
    if (h.sync.during) return h.sync.during();
    return { ok: true };
  },
}));
vi.mock("@/lib/profitability", () => ({
  computeConnectionMetrics: async (connectionId: string, weekStarting: Date) => ({
    connectionId,
    weekStarting,
    jobs: [],
    briefJobIds: [],
    topConcerns: [],
    totals: { activeJobs: 2, totalActualCost: 34_000, totalActualRevenue: 24_000, blendedMarginPct: 0.1 },
    dataHealth: {},
    briefDataHealth: {
      overallConfidence: "high", jobsMissingEstimates: [], jobsMissingCosts: [], untaggedJobCostCount: 0,
      timeEntriesWithoutPayRate: 0, possibleDuplicates: [], idleOpenJobs: [],
    },
  }),
}));
vi.mock("@/lib/opportunityData", () => ({
  getOpportunityData: async () => {
    throw new Error("not needed here");
  },
}));
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: async () => (h.entitled ? { active: true, access: "active" } : { active: false, access: "lapsed" }),
}));
vi.mock("@/lib/planLimits", () => ({ overLimitConnectionIds: async () => new Set<string>() }));
vi.mock("@/lib/account", () => ({
  getAccount: async () => h.login.account,
  refuseClient: () => null,
  canSeeConnection: () => true,
}));
vi.mock("@/lib/jobTypesServer", () => ({ getJobTypes: async () => [] }));
vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    subscriptions: {
      retrieve: async (id: string) => {
        h.stripe.retrieved.push(id);
        const sub = h.stripe.subscriptions[id];
        if (!sub) throw Object.assign(new Error(`No such subscription: ${id}`), { name: "StripeInvalidRequestError" });
        return sub;
      },
      list: async ({ customer }: { customer: string }) => ({ data: h.stripe.lists[customer] ?? [] }),
    },
  }),
  isPlanOffered: () => false,
  isStripeConfigured: () => false,
  priceIdForPlan: () => null,
  planForPriceId: () => null,
}));
// The webhook's own handling of subscription events has its own suite (stripeWebhook.test.ts).
vi.mock("@/lib/stripe/webhookHandlers", () => ({
  processStripeEvent: async (event: any) => {
    h.stripe.events.push(event);
    // As the real one does: the event's id is recorded, and an active
    // subscription on the row's customer (not a set-aside duplicate) is
    // taken onto the row.
    await h.db.stripeEvent.create({ data: { id: event.id, type: event.type } });
    const sub = event.data?.object;
    if (event.type === "customer.subscription.updated" && sub?.status === "active" && !sub?.metadata?.jobprofitaiDuplicateOf && sub?.customer) {
      const row = await h.db.subscription.findFirst({ where: { stripeCustomerId: sub.customer } });
      if (row) await h.db.subscription.update({ where: { userId: row.userId }, data: { stripeSubscriptionId: sub.id } });
    }
    return { handled: true, detail: "ok" };
  },
}));

import { GET as weeklyEmail } from "../../app/api/cron/weekly-email/route";
import { GET as lifecycle } from "../../app/api/cron/lifecycle/route";
import { createFakePrisma } from "./support/fakePrisma";
import { POST as saveSettings } from "../../app/api/settings/profile/route";
import { lastScheduledSend } from "../schedule";
import { SEND_TIMEOUT_MS, sendEmail, sendLifecycleEmail, sendLifecycleEmailOncePerKey, SENDING_STALE_MS } from "../email/client";
import {
  alertsDelivered,
  alertSendFailure,
  briefDueFirst,
  briefRunProblems,
  briefRunReports,
  byDeadline,
  customerSyncError,
  lastRunFor,
  nextRetryAt,
  staleDataAsOf,
} from "../briefSend";
import { generateWeeklyDigestForConnection, partlySentFor, SUMMARY_UNAVAILABLE, summaryToReuse, withPartlySent } from "../digest";
import { findSummaryProblems, withoutUnknownContacts, type SummaryJobFacts } from "../digestText";
import { renderBriefEmail } from "../email/briefEmail";
import { computeWeekOverWeek, renderWeekOverWeek, type WeekOverWeekReport } from "../weekOverWeek";
import { describeError } from "../scrub";
import { resetReportLimit, RunErrors } from "../monitoring";
import { generateProfitInsights } from "../intelligence";
import { qboQuery, QboTemporarilyUnavailableError } from "../quickbooks";

// --- Helpers ------------------------------------------------------------------

const HOUR = 3_600_000;
const MIN = 60_000;
const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** The weekly digests, keyed the way the routes ask for them. */
function digestModel() {
  const rows: any[] = [];
  const find = (w: any) => {
    const k = w.connectionId_weekStarting;
    return rows.find((r) => r.connectionId === k.connectionId && r.weekStarting.getTime() === k.weekStarting.getTime());
  };
  return {
    rows,
    findUnique: async ({ where }: any) => {
      const r = find(where);
      return r ? { ...r } : null;
    },
    // The latest emailed row (the weekly run), or the week before (the digest), as asked.
    findFirst: async ({ where }: any) => {
      const found = rows
        .filter((r) => r.connectionId === where.connectionId)
        .filter((r) => typeof where.emailedAt?.getTime !== "function" || (r.emailedAt && r.emailedAt.getTime() === where.emailedAt.getTime()))
        .filter((r) => !where.weekStarting?.lt || r.weekStarting.getTime() < where.weekStarting.lt.getTime())
        .sort((a, b) => b.weekStarting.getTime() - a.weekStarting.getTime());
      return found[0] ? { ...found[0] } : null;
    },
    upsert: async ({ where, create, update }: any) => {
      const r = find(where);
      if (r) return { ...Object.assign(r, update) };
      const row = { id: `d${rows.length + 1}`, emailedAt: null, createdAt: new Date(), ...create };
      rows.push(row);
      return { ...row };
    },
    update: async ({ where, data }: any) => Object.assign(rows.find((r) => r.id === where.id), data),
    // Each company's latest emailedAt, as the routes ask for it.
    groupBy: async ({ where }: any) => {
      const latest = new Map<string, Date>();
      for (const r of rows) {
        if (!where.connectionId.in.includes(r.connectionId) || !r.emailedAt) continue;
        const cur = latest.get(r.connectionId);
        if (!cur || r.emailedAt.getTime() > cur.getTime()) latest.set(r.connectionId, r.emailedAt);
      }
      return [...latest].map(([connectionId, emailedAt]) => ({ connectionId, _max: { emailedAt } }));
    },
  };
}

/** Sentry envelopes posted through fetch, as { type, value } of each error event. */
const sentry: { events: { type: string; value: string }[] } = { events: [] };
const realFetch = globalThis.fetch;

function schedule(at: Date = new Date()) {
  return { emailDay: at.getUTCDay(), emailHour: at.getUTCHours(), emailTimezone: "UTC" };
}
const week = (at: Date = new Date()) => lastScheduledSend(at, { day: at.getUTCDay(), hour: at.getUTCHours(), timeZone: "UTC" });

async function company(id: string, over: Record<string, unknown> = {}) {
  await h.db.quickBooksConnection.create({
    data: {
      id, userId: "owner", companyName: id, disconnectedAt: null, emailEnabled: true, alertsEnabled: true,
      emailRecipients: ["a@acme.test", "b@acme.test"], ...schedule(), briefAttemptWeek: null, briefAttempts: 0, briefClaimedAt: null,
      syncVersion: 7, lastSyncedAt: new Date(Date.now() - 2 * HOUR), lastSyncStatus: "success", lastSyncError: null,
      lastSyncAttemptAt: new Date(Date.now() - 2 * HOUR), lastFullSyncAt: new Date(), fullSyncContinueAt: null, jobSource: "projects",
      laborBurdenSetAt: null, basisChangedAt: null, rebuildRequestedAt: null, alertsBaselinedAt: new Date(Date.now() - 30 * 24 * HOUR),
      ...over,
    },
  });
}
const row = (id: string): any => h.db.quickBooksConnection.rows.find((r: any) => r.id === id);
const digestRow = (id: string): any => h.db.weeklyDigest.rows.find((r: any) => r.connectionId === id);
const briefKey = (id: string, to: string) => `weekly_brief:${id}:${week().weekStarting.toISOString().slice(0, 10)}:${to}`;
const run = async () => {
  const res: any = await weeklyEmail({} as any);
  return { status: res.status as number, body: res.body as any, result: (id: string) => res.body.results.find((r: any) => r.connectionId === id) };
};
const sentTo = () => h.mail.sent.map((m) => m.to);

beforeEach(async () => {
  h.db = {};
  h.db.emailEvent = new FakeModel("emailEvent", [{ fields: ["dedupeKey"] }], () => ({ sentAt: new Date() }));
  h.db.quickBooksConnection = new FakeModel("c");
  h.db.user = new FakeModel("u");
  h.db.job = new FakeModel("job");
  h.db.weeklyDigest = digestModel();
  await h.db.user.create({ data: { id: "owner", email: "owner@acme.test", name: "Pat", emailVerifiedAt: new Date() } });
  h.ai.replies = [];
  h.ai.calls = [];
  h.ai.during = null;
  h.sync.during = null;
  h.after = [];
  h.entitled = true;
  h.mail.signals = [];
  h.mail.sent = [];
  h.mail.behave = {};
  h.mail.statusAtSend = [];
  h.sync.calls = [];
  process.env.RESEND_API_KEY = "re_test_key";
  delete process.env.EMAIL_DEV_REDIRECT;
  process.env.SENTRY_DSN = "https://abc123@o1.ingest.sentry.io/42";
  delete process.env.VERCEL_ENV;
  resetReportLimit();
  sentry.events = [];
  globalThis.fetch = (async (_url: unknown, init: any) => {
    const lines = String(init?.body ?? "").split("\n");
    for (let i = 1; i + 1 < lines.length; i += 2) {
      if (JSON.parse(lines[i]).type !== "event") continue;
      const v = JSON.parse(lines[i + 1]).exception.values[0];
      sentry.events.push({ type: v.type, value: v.value });
    }
    return { status: 200 } as any;
  }) as any;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.SENTRY_DSN;
});

// --- E1: a send cut off before Resend answered -------------------------------------

describe("E1. a send cut off before Resend answered is sent by the next run", () => {
  const email = { userId: "owner", emailType: "weekly_brief", to: "b@acme.test", subject: "Brief", html: "<p>b</p>", text: "b" };

  it("records the send as sending while Resend is asked, and as sent once it answers", async () => {
    const r = await sendLifecycleEmail({ ...email, dedupeKey: "k1" });
    expect(r.ok).toBe(true);
    expect(h.mail.statusAtSend).toEqual(["sending"]);
    const rec = await h.db.emailEvent.findUnique({ where: { dedupeKey: "k1" } });
    expect([rec.status, rec.providerMessageId]).toEqual(["sent", "msg_1"]);
    // And a repeat is skipped, as before.
    expect(await sendLifecycleEmail({ ...email, dedupeKey: "k1" })).toEqual({ ok: true, skipped: true });
    expect(h.mail.sent).toHaveLength(1);
  });

  it("sends one left sending past 15 minutes, and leaves one sending a moment ago to the run sending it", async () => {
    await h.db.emailEvent.create({ data: { dedupeKey: "old", toEmail: "b@acme.test", emailType: "weekly_brief", status: "sending", sentAt: new Date(Date.now() - SENDING_STALE_MS - MIN) } });
    await h.db.emailEvent.create({ data: { dedupeKey: "new", toEmail: "b@acme.test", emailType: "weekly_brief", status: "sending", sentAt: new Date(Date.now() - 2 * MIN) } });
    expect((await sendLifecycleEmail({ ...email, dedupeKey: "old" })).ok).toBe(true);
    const inFlight = await sendLifecycleEmail({ ...email, dedupeKey: "new" });
    // Not counted as sent: that run may still fail.
    expect(inFlight).toMatchObject({ ok: false, transient: true });
    expect(h.mail.sent).toHaveLength(1);
    expect((await h.db.emailEvent.findUnique({ where: { dedupeKey: "old" } })).status).toBe("sent");
  });

  it("keeps an alert that another run is still sending waiting, and sends one left sending to its recipient", async () => {
    const render = (keys: string[]) => ({ subject: `${keys.length} alerts`, html: "<p>a</p>", text: keys.join(",") });
    await h.db.emailEvent.create({ data: { dedupeKey: "alert:ja1:b", toEmail: "b@acme.test", emailType: "profit_alert", status: "sending", sentAt: new Date(Date.now() - 20 * MIN) } });
    await h.db.emailEvent.create({ data: { dedupeKey: "alert:ja2:b", toEmail: "b@acme.test", emailType: "profit_alert", status: "sending", sentAt: new Date() } });
    const r = await sendLifecycleEmailOncePerKey({ userId: "owner", emailType: "profit_alert", to: "b@acme.test", keys: ["alert:ja1:b", "alert:ja2:b"], render });
    expect([r.sentNow, r.inFlight, r.alreadySent]).toEqual([["alert:ja1:b"], ["alert:ja2:b"], []]);
    expect(h.mail.sent.map((m) => m.text)).toEqual(["alert:ja1:b"]);
    // The nightly job then marks ja1 sent and keeps ja2 waiting for the next run.
    expect(alertSendFailure(r)).toBe("retry");
    expect(alertsDelivered(["ja1", "ja2"], [{ has: ["ja1"], failed: alertSendFailure(r) }])).toEqual(["ja1"]);
  });

  it("gives up on a Resend request with no answer, frees the key and calls it worth retrying", async () => {
    // The 10 second limit, made a few milliseconds here.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: any, ms?: number, ...rest: any[]) => realSetTimeout(fn, (ms ?? 0) >= SEND_TIMEOUT_MS ? 5 : ms, ...rest)) as any;
    try {
      h.mail.behave["b@acme.test"] = "hang";
      expect(await sendEmail(email)).toMatchObject({ ok: false, transient: true, error: "No answer from the email provider within 10 seconds." });
      h.mail.behave["b@acme.test"] = "hang";
      expect((await sendLifecycleEmail({ ...email, dedupeKey: "k2" })).ok).toBe(false);
      expect(await h.db.emailEvent.findUnique({ where: { dedupeKey: "k2" } })).toBeNull();
      expect((await sendLifecycleEmail({ ...email, dedupeKey: "k2" })).ok).toBe(true);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it("brings the weekly brief to the recipient whose send was cut off, and only to them", async () => {
    await company("a");
    await h.db.emailEvent.create({ data: { dedupeKey: briefKey("a", "a@acme.test"), toEmail: "a@acme.test", emailType: "weekly_brief", status: "sent" } });
    await h.db.emailEvent.create({
      data: { dedupeKey: briefKey("a", "b@acme.test"), toEmail: "b@acme.test", emailType: "weekly_brief", status: "sending", sentAt: new Date(Date.now() - 20 * MIN) },
    });
    const r = await run();
    expect(r.result("a")).toMatchObject({ status: "sent" });
    expect(sentTo()).toEqual(["b@acme.test"]);
    expect(digestRow("a").emailedAt).toBeInstanceOf(Date);
  });

  it("doesn't count a brief another run is still sending as sent", async () => {
    await company("a", { emailRecipients: ["b@acme.test"] });
    await h.db.emailEvent.create({
      data: { dedupeKey: briefKey("a", "b@acme.test"), toEmail: "b@acme.test", emailType: "weekly_brief", status: "sending", sentAt: new Date(Date.now() - 2 * MIN) },
    });
    const r = await run();
    expect(r.result("a")).toMatchObject({ status: "retry_later" });
    expect(digestRow("a").emailedAt).toBeNull();
  });

  it("waits for the brief's sync only until the run's deadline", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200));
    expect(await byDeadline(slow, Date.now() + 10)).toEqual({ done: false });
    expect(await byDeadline(Promise.resolve("ok"), Date.now() + 1_000)).toEqual({ done: true, value: "ok" });
    await expect(byDeadline(Promise.reject(new Error("sync failed")), Date.now() + 1_000)).rejects.toThrow("sync failed");
    // One that fails after the deadline is nobody's problem: no unhandled rejection.
    await byDeadline(new Promise((_, reject) => setTimeout(() => reject(new Error("too late")), 20)), Date.now() + 5);
    await new Promise((r) => setTimeout(r, 40));
    const route = read("app/api/cron/weekly-email/route.ts");
    expect(route).toContain("const synced = await byDeadline(syncing, runStartedAt + SYNC_DONE_BY_MS);");
    expect(route).toContain("if (Date.now() - runStartedAt > STOP_SENDING_AFTER_MS)");
  });

  it("gives up on a QuickBooks request with no answer after one more try, not three", async () => {
    const calls: any[] = [];
    globalThis.fetch = (async (_url: unknown, init: any) => {
      calls.push(init);
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as any;
    const err = await qboQuery("realm", "token", "SELECT * FROM Bill").catch((e) => e);
    expect(err).toBeInstanceOf(QboTemporarilyUnavailableError);
    expect(err.message).toContain("no answer in time");
    // One more try (review of audit Oct 27), not the three a busy reply gets.
    expect(calls).toHaveLength(2);
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    // Every request to Intuit has a time limit.
    const qbo = read("lib/quickbooks.ts");
    expect(qbo.match(/await fetch\(/g)?.length).toBe(qbo.match(/signal: AbortSignal\.timeout\(/g)?.length);
  });
});

// --- E2: a brief held for an upgrade sync -----------------------------------------

describe("E2. a brief held for an upgrade sync isn't dropped quietly", () => {
  it("tells the owner a day after the brief's time when the upgrade sync is failing", async () => {
    await company("a", { syncVersion: 6, ...schedule(new Date(Date.now() - 26 * HOUR)), lastSyncStatus: "error", lastSyncAttemptAt: new Date(Date.now() - HOUR) });
    const r = await run();
    expect(r.result("a")).toMatchObject({ status: "deferred", detail: "waiting for the upgrade sync, which is failing; owner told" });
    expect(h.mail.sent.map((m) => [m.to, m.subject])).toEqual([["owner@acme.test", "a: the Weekly Profit Brief is on hold"]]);
    // Once.
    await run();
    expect(h.mail.sent).toHaveLength(1);
  });

  it("says nothing before a day has passed", async () => {
    await company("a", { syncVersion: 6 });
    expect((await run()).result("a")).toMatchObject({ status: "deferred", detail: "waiting for the upgrade sync to finish" });
    expect(h.mail.sent).toHaveLength(0);
  });

  it("knows the run that is a brief's last chance, and reports one still waiting then", () => {
    const scheduledAt = new Date("2026-10-26T12:00:00Z");
    expect(lastRunFor(scheduledAt, Date.parse("2026-10-28T11:40:00Z"))).toBe(false);
    expect(lastRunFor(scheduledAt, Date.parse("2026-10-28T11:50:00Z"))).toBe(true);
    const p = briefRunProblems([{ status: "deferred", endsWaiting: true }], new Date());
    expect(p.endedWaiting).toBe(1);
    expect(briefRunReports(p).map((x) => [x.name, x.message])).toEqual([
      ["BriefNotSent", "1 weekly brief won't go out this week: still waiting for a sync or for room in a run when the week's window closed."],
    ]);
    const route = read("app/api/cron/weekly-email/route.ts");
    expect(route).toContain('r.status === "deferred" && !r.endsUnsent && lastRunFor(scheduledAt) ? { ...r, endsWaiting: true } : r');
  });

  it("puts companies whose held brief is due soonest first in the nightly full-sync queue", () => {
    const now = new Date("2026-10-26T05:00:00Z"); // a Monday
    const c = (id: string, emailDay: number, emailHour: number, held = true, emailEnabled = true) => ({
      id, held, emailEnabled, emailRecipients: ["x@acme.test"], emailDay, emailHour, emailTimezone: "UTC",
    });
    const queue = [
      c("other", 1, 8, false), // not held: the brief goes from what's synced
      c("thursday", 4, 8), // due in 3 days
      c("monday8", 1, 8), // due in 3 hours
      c("sunday", 0, 8), // waiting since yesterday
      c("off", 1, 6, true, false), // no brief at all
      c("monday6", 1, 6), // due in an hour
    ];
    expect(briefDueFirst(queue, now, (x) => x.held).map((x) => x.id)).toEqual(["sunday", "monday6", "monday8", "other", "thursday", "off"]);
    expect(read("app/api/cron/nightly-sync/route.ts")).toContain("const fullQueue = briefDueFirst(fullCandidates, now, briefHeld, ");
  });
});

// --- E3: negations ---------------------------------------------------------------

describe("E3. a negation only counts for the phrase right after it", () => {
  const jobs: SummaryJobFacts[] = [
    { jobName: "Harbor Deck", status: "open", marginPct: -0.4, forecastMarginPct: null },
    { jobName: "Smith Remodel", status: "open", marginPct: 0.05, forecastMarginPct: null },
    { jobName: "Ruiz Kitchen", status: "closed", marginPct: 0.22 },
  ];
  const rules = (s: string) => findSummaryProblems(s, { jobs, comparison: "changes", input: "" }).map((p) => p.rule);

  it("catches a false claim after a negation about something else", () => {
    expect(rules("Harbor Deck has no invoices yet and is losing money.")).toEqual(["loss_without_loss"]);
    expect(rules("Smith Remodel isn't finished but is forecast to close at an 8% margin.")).toEqual(["forecast_without_forecast"]);
    expect(rules("Ruiz Kitchen didn't need a change order and lost money.")).toEqual(["loss_without_loss"]);
    expect(rules("Smith Remodel hasn't gone over its estimate and is heading for a 4% margin.")).toEqual(["forecast_without_forecast"]);
    expect(rules("Harbor Deck, with no invoices so far, is losing money.")).toEqual(["loss_without_loss"]);
  });

  it("still reads a negation of the phrase itself", () => {
    expect(rules("Harbor Deck isn't losing money.")).toEqual([]);
    expect(rules("Harbor Deck is not yet losing money.")).toEqual([]);
    expect(rules("Smith Remodel has no firm forecast yet.")).toEqual([]);
    expect(rules("It's too early for a forecast on Smith Remodel.")).toEqual([]);
    expect(rules("Smith Remodel doesn't have a firm forecast.")).toEqual([]);
    expect(rules("Ruiz Kitchen didn't lose money.")).toEqual([]);
  });
});

// --- SEC2 and E8: why a summary failed, readable after the scrub -------------------

describe("SEC2 and E8. why a summary failed survives the scrub", () => {
  const sdkError = (status: number, type: string, message: string) =>
    Object.assign(new Error(`${status} ${JSON.stringify({ type: "error", error: { type, message } })}`), {
      status,
      error: { type: "error", error: { type, message } },
    });

  it("records Anthropic's reason without the JSON, and the report says it in words the scrub keeps", async () => {
    h.ai.replies = [sdkError(404, "not_found_error", "model: claude-old-1")];
    const r = await generateWeeklyDigestForConnection("c1", week().weekStarting, "Acme", { allowMissingSummary: true, deadline: Date.now() + 200_000 });
    expect(r.summaryFailure).toEqual({ kind: "refused", message: "404 not_found_error: model: claude-old-1" });
    const reports = briefRunReports(
      briefRunProblems(
        [
          { status: "sent", summaryMissing: true, summaryFailure: r.summaryFailure },
          { status: "sent", summaryMissing: true, summaryFailure: { kind: "other", message: "TypeError: Cannot read properties of undefined (reading 'trim')" } },
        ],
        new Date()
      )
    );
    const value = describeError(reports[0]).value;
    expect(value).toContain("The first refusal said: 404 not_found_error: model: claude-old-1");
    expect(value).toContain("The first failure of kind other said: TypeError: Cannot read properties of undefined (reading 'trim')");
    expect(value).not.toContain("[redacted]");
  });
});

// --- E4: a brief built from old data ------------------------------------------------

describe("E4. a brief built from old data says when QuickBooks was last read", () => {
  it("counts the data as old once the last sync failed or the last good one is a day and a half old", () => {
    const now = Date.parse("2026-10-27T12:00:00Z");
    const at = (h: number) => new Date(now - h * HOUR);
    expect(staleDataAsOf({ lastSyncedAt: at(3), lastSyncStatus: "success", lastSyncAttemptAt: at(3) }, now)).toBeNull();
    expect(staleDataAsOf({ lastSyncedAt: at(37), lastSyncStatus: "success", lastSyncAttemptAt: at(37) }, now)).toEqual(at(37));
    expect(staleDataAsOf({ lastSyncedAt: at(3), lastSyncStatus: "error", lastSyncAttemptAt: at(1) }, now)).toEqual(at(3));
    expect(staleDataAsOf({ lastSyncedAt: null, lastSyncStatus: "error", lastSyncAttemptAt: at(1) }, now)).toBeNull();
  });

  it("says so in the email and tells the model, after a failed sync", async () => {
    await company("a", {
      emailRecipients: ["a@acme.test"],
      lastSyncStatus: "error",
      lastSyncedAt: new Date("2026-10-20T09:00:00Z"),
      lastSyncAttemptAt: new Date(Date.now() - 30 * MIN),
    });
    expect((await run()).result("a")).toMatchObject({ status: "sent" });
    const [mail] = h.mail.sent;
    expect(mail.text).toContain("These figures are from QuickBooks as it was on Oct 20, 2026. We haven't been able to read it since, so anything entered after that isn't in this brief yet.");
    expect(mail.html).toContain("calculated from your QuickBooks data as it was on Oct 20, 2026.");
    expect(h.ai.calls[0].messages[0].content).toContain('"quickBooksLastReadOn": "Oct 20, 2026"');
    expect(h.ai.calls[0].system).toContain("If weekOverWeek.quickBooksLastReadOn is set");
  });

  it("says nothing changed in what could be read, not that nothing changed", () => {
    const report: WeekOverWeekReport = {
      comparedToWeekStarting: new Date("2026-10-19T00:00:00Z"), noComparisonReason: null, revenueAdded: 0, costAdded: 0,
      marginBefore: 0.1, marginAfter: 0.1, changes: [], unchangedJobs: 3, dataLastReadOn: "Oct 20, 2026",
    };
    expect(renderWeekOverWeek(report)).toContain("Nothing changed in what we could read from QuickBooks since then. It was last read on Oct 20, 2026.");
    const email = renderBriefEmail({
      connectionId: "a", companyName: "Acme", weekStarting: new Date("2026-10-26T00:00:00Z"), kind: "narrative", body: "Summary.",
      weekOverWeek: report, metrics: { totals: { activeJobs: 1, totalActualCost: 0, totalActualRevenue: 0 }, jobs: [] } as any,
      tiles: { overEstimate: [], unbilled: [] } as any, recipient: "a@acme.test", ownerEmail: "a@acme.test",
    });
    expect(email.text).toContain("Nothing changed in what we could read from QuickBooks since the brief for the week of Oct 19, 2026.");
    expect(email.text).not.toContain("Nothing changed on your jobs");
    // Current figures read as before.
    expect(renderWeekOverWeek({ ...report, dataLastReadOn: null })).toContain("Nothing changed on your jobs in QuickBooks since then.");
  });
});

// --- E5: a retry after a sync writes a new summary -----------------------------------

describe("E5. a retry doesn't put an old summary beside new figures", () => {
  it("reuses the summary on a retry with nothing synced since, and writes a new one after a sync", async () => {
    await company("a", { emailRecipients: ["a@acme.test"] });
    h.mail.behave["a@acme.test"] = "busy";
    expect((await run()).result("a")).toMatchObject({ status: "retry_later" });
    expect(h.ai.calls).toHaveLength(1);
    const builtAt = Date.parse(digestRow("a").metrics.builtAt);
    expect(summaryToReuse(digestRow("a").metrics, null, new Date(builtAt - 1))).toBe("Torres Kitchen has $30,000 spent so far. It has $25,000 billed.");
    expect(summaryToReuse(digestRow("a").metrics, null, new Date(builtAt + 1))).toBeNull();

    // A sync since: the retry writes a new summary for the new figures.
    row("a").briefClaimedAt = null;
    row("a").lastSyncedAt = new Date(builtAt + 1);
    h.mail.behave["a@acme.test"] = "busy";
    h.ai.replies = ["Torres Kitchen has $31,000 spent so far. It has $26,000 billed."];
    await run();
    expect(h.ai.calls).toHaveLength(2);

    // None since: the same words go.
    row("a").briefClaimedAt = null;
    expect((await run()).result("a")).toMatchObject({ status: "sent" });
    expect(h.ai.calls).toHaveLength(2);
    expect(h.mail.sent[0].text).toContain("Torres Kitchen has $31,000 spent so far.");
  });
});

// --- E6: a reply that isn't a finished summary --------------------------------------

describe("E6. only a finished reply is used as the summary", () => {
  const build = () => generateWeeklyDigestForConnection("c1", week().weekStarting, "Acme", { allowMissingSummary: true, deadline: Date.now() + 200_000 });

  it("sends the figures only for a refusal with text in it, a reply with another stop reason, or an empty one", async () => {
    for (const reply of [{ stop: "refusal", text: "I can't help with that." }, { stop: "pause_turn", text: "Torres Kitchen has" }, "   \n ", "Subject: Brief\n\nHi team,"]) {
      h.ai.replies = [reply];
      const r = await build();
      expect({ reply, missing: r.summaryMissing, body: r.body, kind: r.summaryFailure?.kind }).toEqual({ reply, missing: true, body: SUMMARY_UNAVAILABLE, kind: "other" });
    }
    h.ai.replies = [{ stop: "refusal", text: "No." }];
    expect((await build()).summaryFailure?.message).toBe("Claude's reply for the digest didn't finish as a summary (stop reason: refusal).");
    h.ai.replies = [{ stop: "stop_sequence", text: "Torres Kitchen has $30,000 spent so far. It has $25,000 billed." }];
    expect((await build()).summaryMissing).toBe(false);
  });
});

// --- E7: a brief some recipients have ------------------------------------------------

describe("E7. a brief some recipients have is marked emailed, and the rest still get it", () => {
  it("marks it emailed as it goes out, keeps sending it to the rest, and finishes it once they have it", async () => {
    await company("a");
    h.mail.behave["b@acme.test"] = "busy";
    const first = await run();
    expect(first.result("a")).toMatchObject({ status: "retry_later" });
    expect(sentTo()).toEqual(["a@acme.test"]);
    const emailedAt = digestRow("a").emailedAt;
    expect(emailedAt).toBeInstanceOf(Date);
    // Marked with the week, so a send time moved meanwhile still finds it (review of audit Oct 27).
    expect(partlySentFor(digestRow("a").metrics, week().weekStarting)).toEqual({ scheduledAt: week().weekStarting.toISOString(), sendAgain: false });
    expect(row("a").briefClaimedAt.getTime()).toBeGreaterThan(Date.now() + 45 * MIN);

    // The hour has passed.
    row("a").briefClaimedAt = null;
    const second = await run();
    expect(second.result("a")).toMatchObject({ status: "sent" });
    expect(sentTo()).toEqual(["a@acme.test", "b@acme.test"]);
    expect(digestRow("a").emailedAt).toEqual(emailedAt);
    expect(partlySentFor(digestRow("a").metrics, week().weekStarting)).toBeNull();
    // The summary went to both in the same words.
    expect(h.ai.calls).toHaveLength(1);

    expect((await run()).result("a")).toMatchObject({ status: "skipped", detail: "already emailed this week" });
  });

  it("retries early enough to stay inside the week's window, and says when it can't", () => {
    const scheduledAt = new Date("2026-10-26T12:00:00Z");
    const at = (iso: string) => Date.parse(iso);
    expect(nextRetryAt(at("2026-10-26T13:00:00Z"), scheduledAt, HOUR)).toBe(at("2026-10-26T14:00:00Z"));
    // Half an hour left: the retry comes sooner, with a run still inside the window after it.
    expect(nextRetryAt(at("2026-10-28T11:30:00Z"), scheduledAt, HOUR)).toBe(at("2026-10-28T11:45:00Z"));
    expect(nextRetryAt(at("2026-10-28T11:50:00Z"), scheduledAt, HOUR)).toBeNull();
    const p = briefRunProblems([{ status: "sent", partlySent: true }], new Date());
    expect(briefRunReports(p).map((x) => x.message)).toEqual([
      "1 weekly brief reached only some of their recipients, and the rest won't get it: the email provider couldn't take theirs before the week's window closed or the send day was moved.",
    ]);
    expect(withPartlySent({ jobs: [], briefPartlySent: { scheduledAt: "x", sendAgain: false } }, null)).toEqual({ jobs: [] });
  });
});

// --- E9: one report per kind of error in a run ---------------------------------------

describe("E9. a run's unexpected errors are one report per kind, with the count", () => {
  it("sends each kind once, saying how many times it happened", async () => {
    const errors = new RunErrors();
    errors.add(new RangeError("Invalid time value"));
    // The same fault for each company: its ID differs, and is scrubbed out.
    for (let i = 0; i < 30; i++) errors.add(new TypeError(`Cannot read properties of undefined (reading 'id') for cm${i}abcdefghijklmnopqrstuvwxyz`));
    // Another fault of the same class is its own report.
    errors.add(new TypeError("Assignment to constant variable."));
    expect(errors.count).toBe(32);
    await errors.report({ cron: "weekly-email" });
    expect(sentry.events).toEqual([
      { type: "TypeError", value: "30 times in this run, one report for all of them. The first: Cannot read properties of undefined (reading 'id') for [token]" },
      { type: "RangeError", value: "Invalid time value" },
      { type: "TypeError", value: "Assignment to constant variable." },
    ]);
  });

  it("is how every scheduled job reports a company's or row's unexpected error", () => {
    expect(read("app/api/cron/weekly-email/route.ts")).toContain("errors.add(err);");
    expect(read("app/api/cron/nightly-sync/route.ts")).toContain("if (!syncFailed || isCodeOrDatabaseFault(err)) errors.add(err);");
    const lifecycle = read("app/api/cron/lifecycle/route.ts");
    expect(lifecycle).not.toContain("reportError(");
    expect(lifecycle.match(/counters\.faults\.add\(err\)/g)).toHaveLength(5);
  });
});

// --- E10: alerts switched back on ----------------------------------------------------

describe("E10. alerts switched back on don't send everything that built up meanwhile", () => {
  const save = (over: Record<string, unknown>) =>
    saveSettings({
      json: async () => ({
        connectionId: "a", targetMarginPct: 20, overheadEnabled: false, emailEnabled: true, emailRecipients: ["a@acme.test"],
        emailDay: 1, emailHour: 8, emailTimezone: "UTC", alertsEnabled: true, ...over,
      }),
    } as any);

  beforeEach(() => {
    h.login.account = { ownerId: "owner", userId: "owner", role: "owner" };
  });

  it("clears the alerts baseline when alerts, or the brief they go with, come back on", async () => {
    const baselined = new Date(Date.now() - 30 * 24 * HOUR);
    for (const off of [{ alertsEnabled: false }, { emailEnabled: false }, { emailRecipients: [] }]) {
      h.db.quickBooksConnection = new FakeModel("c");
      await company("a", { ...off, alertsBaselinedAt: baselined });
      expect(((await save({})) as any).status).toBe(200);
      expect({ off, baselinedAt: row("a").alertsBaselinedAt }).toEqual({ off, baselinedAt: null });
    }
  });

  it("leaves it alone when they were on already, or stay off", async () => {
    const baselined = new Date(Date.now() - 30 * 24 * HOUR);
    await company("a", { emailRecipients: ["a@acme.test"], alertsBaselinedAt: baselined });
    await save({});
    expect(row("a").alertsBaselinedAt).toEqual(baselined);
    await save({ alertsEnabled: false });
    expect(row("a").alertsBaselinedAt).toEqual(baselined);
  });
});

// --- E11, E12, SEC4: the lifecycle job ------------------------------------------------

describe("E11, E12 and SEC4. the lifecycle job", () => {
  const src = read("app/api/cron/lifecycle/route.ts");

  it("sends trial emails only to verified addresses", () => {
    expect(src).toMatch(/const where = \{\s*OR: \[[\s\S]*?\],\s*user: \{ emailVerifiedAt: \{ not: null \} \},\s*\};/);
  });

  it("doesn't ask someone who just cancelled for a testimonial", () => {
    expect(src).toMatch(/status: "active",[\s\S]{0,300}cancelAtPeriodEnd: false,/);
  });

  it("logs a failed stage's name where the scrub can't hide it", () => {
    expect(src).toContain("console.error(`cron/lifecycle: stage ${name} failed: ${message}`);");
    expect(src).not.toContain('stage "${name}"');
  });
});

// --- B6: a lost "subscription deleted" webhook ------------------------------------------

describe("B6. a subscription still live on file long after its period ended is read back from Stripe", () => {
  const DAY = 24 * HOUR;
  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  async function subscriptions() {
    h.db = createFakePrisma();
    h.stripe.retrieved = [];
    h.stripe.events = [];
    const sub = (userId: string, id: string, status: string, periodEndDaysAgo: number) =>
      h.db.subscription.create({
        data: { userId, stripeCustomerId: `cus_${userId}`, stripeSubscriptionId: id, status, currentPeriodEnd: new Date(Date.now() - periodEndDaysAgo * DAY) },
      });
    await sub("u1", "sub_gone", "active", 5);
    await sub("u2", "sub_renewed", "active", 3);
    await sub("u3", "sub_late", "past_due", 4);
    await sub("u4", "sub_recent", "active", 1); // within the two days Stripe gets to renew it
    await sub("u5", "sub_current", "active", -20);
    await sub("u6", "sub_done", "canceled", 30);
    h.stripe.subscriptions = {
      sub_gone: { id: "sub_gone", status: "canceled", livemode: false },
      sub_renewed: { id: "sub_renewed", status: "active", livemode: false },
      sub_late: { id: "sub_late", status: "past_due", livemode: false },
    };
  }

  it("applies what Stripe says through the webhook's own handling, once a day", async () => {
    await subscriptions();
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    const res: any = await lifecycle({} as any);
    expect(h.stripe.retrieved).toEqual(["sub_gone", "sub_late", "sub_renewed"]);
    const day = new Date().toISOString().slice(0, 10);
    expect(h.stripe.events.map((e) => [e.id, e.type, e.data.object.id])).toEqual([
      [`reconcile_sub_gone_${day}`, "customer.subscription.deleted", "sub_gone"],
      [`reconcile_sub_late_${day}`, "customer.subscription.updated", "sub_late"],
      [`reconcile_sub_renewed_${day}`, "customer.subscription.updated", "sub_renewed"],
    ]);
    // Stamped with when Stripe was read, so an older event can't undo it.
    expect(Math.abs(h.stripe.events[0].created * 1000 - Date.now())).toBeLessThan(60_000);
    expect(res.body.subscriptionsReconciled).toBe(3);
  });

  it("does nothing where Stripe isn't set up", async () => {
    await subscriptions();
    const res: any = await lifecycle({} as any);
    expect(h.stripe.retrieved).toEqual([]);
    expect(res.body.subscriptionsReconciled).toBe(0);
  });
});

// --- E13: the Profit Insight cards ----------------------------------------------------

describe("E13. Profit Insight cards get the brief's contact check", () => {
  const opportunity = { type: "recurring_underestimate", title: "Roofing runs over", description: "3 roofing jobs ran 14% over.", financialImpact: 4200, confidence: "high" as const, supportingJobIds: ["j1"] };

  it("takes out a link, email address or phone number that wasn't in the input", async () => {
    h.ai.replies = [
      JSON.stringify([
        {
          evidence: "Call 555-201-7788 about it. Three roofing jobs ran 14% over.",
          recommendedAction: "Book a crew at www.cheap-roofers.example.com before the next bid.",
        },
      ]),
    ];
    const [card] = await generateProfitInsights([opportunity]);
    expect(card.evidence).toBe("Three roofing jobs ran 14% over.");
    // Nothing of the model's left: a line that claims nothing.
    expect(card.recommendedAction).toBe("Look through the jobs behind this note to decide what to change.");
    expect([card.financialImpact, card.confidence, card.sourceJobIds]).toEqual([4200, "high", ["j1"]]);
  });

  it("leaves text with nothing to take out as it was, and keeps contact details that were in the input", () => {
    expect(withoutUnknownContacts("Margins slipped. Price the next one higher.", "")).toBe("Margins slipped. Price the next one higher.");
    expect(withoutUnknownContacts("Ask Bob at bob@acme.test. Then reprice.", "Customer: bob@acme.test")).toBe("Ask Bob at bob@acme.test. Then reprice.");
    expect(read("lib/intelligence.ts")).not.toContain("every number in the model's response is discarded");
  });
});

// --- SEC1: what the on-hold email may quote ----------------------------------------------

describe("SEC1. the brief on hold email quotes only a message written for customers", () => {
  it("keeps the app's own sentences and drops database and library text", () => {
    const classes = "Your jobs are set to come from QuickBooks Classes, but QuickBooks sent no classes. If your jobs aren't classes, change how your jobs are set up in Settings.";
    expect(customerSyncError(classes)).toBe(classes);
    const tooLong =
      "Reading this company's QuickBooks history keeps running out of time, so some of its figures may be out of date. It's tried again once a day. If this hasn't cleared in a few days, email support@jobprofitai.com.";
    expect(customerSyncError(tooLong)).toBe(tooLong);
    expect(customerSyncError("Interrupted before it finished (time limit). Retried automatically.")).toBe("Interrupted before it finished (time limit). Retried automatically.");
    for (const raw of [
      "Invalid `prisma.quickBooksConnection.update()` invocation: Unique constraint failed.",
      "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.",
      "Unsupported state or unable to authenticate data",
      'Cannot read properties of undefined (reading "Line").',
      "Email bob@acme.test about the bill.",
    ]) {
      expect({ raw, shown: customerSyncError(raw) }).toEqual({ raw, shown: null });
    }
  });
});

// ============================================================================
// Review of the audit Oct 27 fixes
// ============================================================================

import { GET as nightlySync } from "../../app/api/cron/nightly-sync/route";

const RealDate = Date;
let clockOffset = 0;
/** One class for every move of the clock, so dates made under one move are still dates under the next (the fake database checks instanceof Date). */
class Shifted extends RealDate {
  constructor(...a: any[]) {
    if (a.length === 0) super(RealDate.now() + clockOffset);
    else super(...(a as [any]));
  }
  static now() {
    return RealDate.now() + clockOffset;
  }
}
/** Moves the clock so that Date.now() and new Date() read `at` (epoch ms) from this moment on. Rows are made after it, so their dates are the moved kind. */
function clockAt(at: number) {
  clockOffset = at - RealDate.now();
  (globalThis as any).Date = Shifted;
}
function realClock() {
  (globalThis as any).Date = RealDate;
}
/** The window's last run for a brief scheduled this hour: 47 hours 50 minutes after it. */
const lastRunOf = (scheduledAt: Date) => scheduledAt.getTime() + 47 * HOUR + 50 * MIN;

describe("review: the on-hold notices, one of each, each when it's true", () => {
  const classes = "Your jobs are set to come from QuickBooks Classes, but QuickBooks sent no classes. If your jobs aren't classes, change how your jobs are set up in Settings.";
  afterEach(realClock);

  it("doesn't tell the owner of a queued re-read at a day: the brief may still go inside the window", async () => {
    await company("a", { syncVersion: 6, emailRecipients: ["a@acme.test"], ...schedule(new Date(Date.now() - 26 * HOUR)) });
    expect((await run()).result("a")).toMatchObject({ status: "deferred", detail: "waiting for the upgrade sync to finish" });
    expect(h.mail.sent).toHaveLength(0);
  });

  it("tells the owner of a queued re-read on the window's last run, and still sends the failing notice if it fails after", async () => {
    const scheduledAt = week().scheduledAt;
    clockAt(lastRunOf(scheduledAt));
    await company("a", { syncVersion: 6, emailRecipients: ["a@acme.test"], ...schedule(new RealDate(scheduledAt.getTime())), lastSyncedAt: new Date(Date.now() - 4 * 24 * HOUR) });
    const waiting = await run();
    expect(waiting.result("a")).toMatchObject({ status: "deferred", detail: "waiting for the upgrade sync; owner told", endsWaiting: true });
    expect(h.mail.sent).toHaveLength(1);
    expect(h.mail.sent[0].text).toContain("There's nothing you need to do.");

    // The re-read then fails for a reason the owner has to fix; the last good sync hasn't moved.
    Object.assign(row("a"), { lastSyncStatus: "error", lastSyncError: classes, lastSyncAttemptAt: new Date(Date.now() - 30 * MIN) });
    const failing = await run();
    expect(failing.result("a")).toMatchObject({ detail: "waiting for the upgrade sync, which is failing; owner told" });
    expect(h.mail.sent).toHaveLength(2);
    expect(h.mail.sent[1].text).toContain("QuickBooks sent no classes");
    // At most one of each.
    await run();
    expect(h.mail.sent).toHaveLength(2);
    expect(h.db.emailEvent.rows.map((r: any) => r.dedupeKey.endsWith(":waiting"))).toEqual([true, false]);
  });
});

describe("review: a Resend request with no answer is aborted, not only given up on", () => {
  it("passes an abort signal, and an aborted request comes back as worth retrying", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realAbortTimeout = AbortSignal.timeout;
    // The 10 second abort made 5 ms, and the fallback race after it 200 ms, so the abort lands first.
    AbortSignal.timeout = ((ms: number) => realAbortTimeout.call(AbortSignal, ms >= SEND_TIMEOUT_MS ? 5 : ms)) as any;
    globalThis.setTimeout = ((fn: any, ms?: number, ...rest: any[]) => realSetTimeout(fn, (ms ?? 0) >= SEND_TIMEOUT_MS ? 200 : ms, ...rest)) as any;
    try {
      h.mail.behave["b@acme.test"] = "abortable";
      const r = await sendEmail({ to: "b@acme.test", subject: "Brief", html: "<p>b</p>", text: "b" });
      expect(r).toMatchObject({ ok: false, transient: true, error: "No answer from the email provider within 10 seconds." });
      expect(h.mail.signals).toEqual([true]);
    } finally {
      AbortSignal.timeout = realAbortTimeout;
      globalThis.setTimeout = realSetTimeout;
    }
    // Only the signal goes in Resend's options: headers there would replace its own, the API key included.
    expect(read("lib/email/client.ts")).toContain("}, { signal } as never)]);");
  });
});

describe("review: the nightly full-sync queue", () => {
  it("doesn't count a brief that already went out as waiting, and keeps reads put first in line ahead", () => {
    const now = new Date("2026-10-28T05:00:00Z"); // a Wednesday
    const c = (id: string, emailDay: number, fullSyncContinueAt: Date | null = null) => ({
      id, emailEnabled: true, emailRecipients: ["x@acme.test"], emailDay, emailHour: 8, emailTimezone: "UTC", fullSyncContinueAt,
    });
    const queue = [
      c("partway_first_in_line", 0, new Date(1)),
      c("owed_first_in_line", 5, new Date(0)),
      c("monday_sent", 1),
      c("tuesday_sent", 2),
      c("wednesday_due_in_3h", 3),
    ];
    const emailed = new Map<string, Date | null>([
      ["monday_sent", new Date("2026-10-26T08:05:00Z")],
      ["tuesday_sent", new Date("2026-10-27T08:05:00Z")],
      ["wednesday_due_in_3h", new Date("2026-10-21T08:05:00Z")],
    ]);
    expect(briefDueFirst(queue, now, () => true, emailed).map((x) => x.id)).toEqual([
      "partway_first_in_line",
      "owed_first_in_line",
      "wednesday_due_in_3h",
      "monday_sent",
      "tuesday_sent",
    ]);
  });
});

describe("review: a sync still running at the run's deadline is kept alive", () => {
  afterEach(realClock);

  it("hands the sync to after(), and the brief waits for the next run", async () => {
    await company("a", { emailRecipients: ["a@acme.test"], lastSyncedAt: new Date(Date.now() - 10 * HOUR) });
    let finish = () => {};
    let finished = false;
    h.sync.during = () => {
      // The sync takes 210 seconds of the run.
      clockAt(Date.now() + 210_000);
      return new Promise((resolve) => {
        finish = () => {
          finished = true;
          resolve({ ok: true });
        };
      });
    };
    const r = await run();
    expect(r.result("a")).toMatchObject({ status: "deferred", detail: "the sync before the brief ran past this run's time for it" });
    expect(h.mail.sent).toHaveLength(0);
    expect(h.after).toHaveLength(1);
    finish();
    await Promise.all(h.after);
    expect(finished).toBe(true);
  });
});

describe("review: B6 reads back each row once a day and keeps a customer's live subscription", () => {
  const DAY = 24 * HOUR;
  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });
  async function onFile(rows: [string, string][]) {
    h.db = createFakePrisma();
    h.stripe.retrieved = [];
    h.stripe.events = [];
    h.stripe.subscriptions = {};
    h.stripe.lists = {};
    for (const [userId, id] of rows) {
      await h.db.subscription.create({
        data: { userId, stripeCustomerId: `cus_${userId}`, stripeSubscriptionId: id, status: "active", currentPeriodEnd: new Date(Date.now() - 5 * DAY) },
      });
    }
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
  }

  it("applies the customer's live subscription instead of cancelling one who pays on another", async () => {
    await onFile([["u1", "sub_old"]]);
    h.stripe.subscriptions = { sub_old: { id: "sub_old", status: "canceled", customer: "cus_u1", livemode: false, created: 1 } };
    h.stripe.lists = {
      cus_u1: [
        { id: "sub_old", status: "canceled", created: 1, customer: "cus_u1" },
        { id: "sub_new", status: "active", created: 2, livemode: false, customer: "cus_u1" },
        { id: "sub_abandoned", status: "incomplete_expired", created: 3, customer: "cus_u1" },
      ],
    };
    await lifecycle({} as any);
    const day = new Date().toISOString().slice(0, 10);
    expect(h.stripe.events.map((e) => [e.id, e.type, e.data.object.id])).toEqual([[`reconcile_sub_old_${day}_moved`, "customer.subscription.updated", "sub_new"]]);
    expect((await h.db.subscription.findUnique({ where: { userId: "u1" } })).stripeSubscriptionId).toBe("sub_new");
    // Read back today: not again until tomorrow.
    expect(await h.db.stripeEvent.findUnique({ where: { id: `reconcile_sub_old_${day}` } })).not.toBeNull();
  });

  it("applies the cancellation, then a replacement that's live but not active; a set-aside duplicate never", async () => {
    // Review of audit Oct 27, B6: a past due, unpaid or trialing one isn't
    // taken over while the row says active, so the row stayed active on a
    // canceled subscription every day. Third review: cancelled with nothing
    // after it, access then stayed off through a Stripe trial or the card
    // retries, so that one is applied after the cancellation.
    const day = new Date().toISOString().slice(0, 10);
    for (const status of ["past_due", "unpaid", "trialing"]) {
      await onFile([["u1", "sub_old"]]);
      h.stripe.subscriptions = { sub_old: { id: "sub_old", status: "canceled", customer: "cus_u1", livemode: false, created: 1 } };
      h.stripe.lists = { cus_u1: [{ id: "sub_old", status: "canceled", created: 1, customer: "cus_u1" }, { id: "sub_other", status, created: 2, customer: "cus_u1" }] };
      await lifecycle({} as any);
      expect(h.stripe.events.map((e) => [e.id, e.type, e.data.object.id])).toEqual([
        [`reconcile_sub_old_${day}`, "customer.subscription.deleted", "sub_old"],
        [`reconcile_sub_old_${day}_moved`, "customer.subscription.updated", "sub_other"],
      ]);
    }
    await onFile([["u1", "sub_old"]]);
    h.stripe.subscriptions = { sub_old: { id: "sub_old", status: "canceled", customer: "cus_u1", livemode: false, created: 1 } };
    h.stripe.lists = {
      cus_u1: [
        { id: "sub_old", status: "canceled", created: 1, customer: "cus_u1" },
        { id: "sub_other", status: "active", created: 2, customer: "cus_u1", metadata: { jobprofitaiDuplicateOf: "sub_old" } },
      ],
    };
    await lifecycle({} as any);
    expect(h.stripe.events.map((e) => [e.id, e.type, e.data.object.id])).toEqual([[`reconcile_sub_old_${day}`, "customer.subscription.deleted", "sub_old"]]);
  });

  it("takes the oldest paying subscription when there are two, as the duplicate rule keeps the oldest", async () => {
    await onFile([["u1", "sub_old"]]);
    h.stripe.subscriptions = { sub_old: { id: "sub_old", status: "canceled", customer: "cus_u1", livemode: false, created: 1 } };
    h.stripe.lists = {
      cus_u1: [
        { id: "sub_b_newer", status: "active", created: 5, customer: "cus_u1" },
        { id: "sub_a_older", status: "active", created: 3, customer: "cus_u1" },
      ],
    };
    await lifecycle({} as any);
    expect((await h.db.subscription.findUnique({ where: { userId: "u1" } })).stripeSubscriptionId).toBe("sub_a_older");
  });

  it("reads each row back at most once a day, failures too, and reports a run's Stripe errors once", async () => {
    await onFile([["u1", "sub_gone"], ["u2", "sub_missing1"], ["u3", "sub_missing2"]]);
    h.stripe.subscriptions = { sub_gone: { id: "sub_gone", status: "canceled", customer: "cus_u1", livemode: false } };
    const first: any = await lifecycle({} as any);
    expect(h.stripe.retrieved).toEqual(["sub_gone", "sub_missing1", "sub_missing2"]);
    expect(first.body.subscriptionsReconciled).toBe(1);
    expect(sentry.events.filter((e) => e.type === "StripeInvalidRequestError")).toEqual([
      { type: "StripeInvalidRequestError", value: "2 times in this run, one report for all of them. The first: No such subscription: sub_missing1" },
    ]);
    // The next hour: nothing read back again today.
    h.stripe.retrieved = [];
    sentry.events = [];
    resetReportLimit();
    await lifecycle({} as any);
    expect(h.stripe.retrieved).toEqual([]);
    expect(sentry.events.filter((e) => e.type === "StripeInvalidRequestError")).toEqual([]);
  });
});

describe("review: no send starts after 265 seconds into the run", () => {
  afterEach(realClock);

  it("leaves the brief for the next run, which sends the stored summary", async () => {
    await company("a", { emailRecipients: ["a@acme.test"] });
    const startedAround = Date.now();
    // The write-up ends 270 seconds into the run.
    h.ai.during = () => clockAt(startedAround + 270_000);
    const r = await run();
    expect(r.result("a")).toMatchObject({ status: "retry_later" });
    expect(r.result("a").detail).toContain("no time left in this run");
    expect(h.mail.sent).toHaveLength(0);
    h.ai.during = null;
    // Not held for an hour: only time ran out, so the next run, 15 minutes after this one started, sends it.
    expect(row("a").briefClaimedAt.getTime()).toBeLessThanOrEqual(Date.now());
    clockAt(startedAround + 15 * MIN);
    expect((await run()).result("a")).toMatchObject({ status: "sent" });
    expect(h.ai.calls).toHaveLength(1);
  });
});

describe("review: a partly sent brief whose send time then moves", () => {
  it("still goes to the rest of its recipients", async () => {
    await company("a");
    h.mail.behave["b@acme.test"] = "busy";
    expect((await run()).result("a")).toMatchObject({ status: "retry_later" });
    // An hour earlier, the same week.
    Object.assign(row("a"), { ...schedule(new Date(Date.now() - HOUR)), briefClaimedAt: null });
    expect(week(new Date(Date.now() - HOUR)).weekStarting.getTime()).toBe(week().weekStarting.getTime());
    expect((await run()).result("a")).toMatchObject({ status: "sent" });
    expect(sentTo()).toEqual(["a@acme.test", "b@acme.test"]);
  });
});

describe("review: E3, phrases that put a claim in doubt, and idioms that make one", () => {
  const jobs: SummaryJobFacts[] = [
    { jobName: "Harbor Deck", status: "open", marginPct: -0.4, forecastMarginPct: null },
    { jobName: "Smith Remodel", status: "open", marginPct: 0.05, forecastMarginPct: null },
  ];
  const rules = (s: string) => findSummaryProblems(s, { jobs, comparison: "changes", input: "" }).map((p) => p.rule);

  it("doesn't take out a sentence that says there's no sign of a loss, or that it's too soon to forecast", () => {
    expect(rules("There's no sign that Harbor Deck is losing money.")).toEqual([]);
    expect(rules("There is no evidence yet that Harbor Deck is losing money.")).toEqual([]);
    expect(rules("Smith Remodel isn't far enough along to forecast.")).toEqual([]);
    expect(rules("We can't tell yet whether Harbor Deck is losing money.")).toEqual([]);
  });

  it("catches a loss claimed through an idiom with a negating word in it", () => {
    expect(rules("Harbor Deck can't avoid losing money at this rate.")).toEqual(["loss_without_loss"]);
    expect(rules("Harbor Deck is no doubt losing money.")).toEqual(["loss_without_loss"]);
    expect(rules("Harbor Deck won't stop losing money until it is billed.")).toEqual(["loss_without_loss"]);
    // And the audit's cases still.
    expect(rules("Harbor Deck has no invoices yet and is losing money.")).toEqual(["loss_without_loss"]);
    expect(rules("There's no sign of billing and Harbor Deck is losing money.")).toEqual(["loss_without_loss"]);
  });
});

describe("review: E10 for a company skipped while lapsed or paused", () => {
  it("clears its alerts baseline, so what built up meanwhile isn't sent as new when it's back", async () => {
    h.entitled = false;
    const baselined = new Date(Date.now() - 30 * 24 * HOUR);
    await company("a", { lastSyncedAt: new Date(Date.now() - 40 * HOUR), lastSyncAttemptAt: new Date(Date.now() - 40 * HOUR), alertsBaselinedAt: baselined });
    const res: any = await nightlySync({} as any);
    expect(res.body.results).toEqual([{ connectionId: "a", status: "skipped", detail: "no active entitlement (lapsed)" }]);
    expect(row("a").alertsBaselinedAt).toBeNull();
  });
});

describe("review: a sync running on the window's last run", () => {
  afterEach(realClock);

  it("sends the brief from what's synced, instead of putting it off past the window", async () => {
    const scheduledAt = week().scheduledAt;
    clockAt(lastRunOf(scheduledAt));
    await company("a", { emailRecipients: ["a@acme.test"], ...schedule(new RealDate(scheduledAt.getTime())), lastSyncedAt: new Date(Date.now() - 10 * HOUR) });
    h.sync.during = async () => {
      throw new h.SyncAlreadyRunningError("A sync is already running.");
    };
    expect((await run()).result("a")).toMatchObject({ status: "sent" });
    expect(sentTo()).toEqual(["a@acme.test"]);
  });

  it("still puts it off to the next run before then", async () => {
    await company("a", { emailRecipients: ["a@acme.test"], lastSyncedAt: new Date(Date.now() - 10 * HOUR) });
    h.sync.during = async () => {
      throw new h.SyncAlreadyRunningError("A sync is already running.");
    };
    expect((await run()).result("a")).toMatchObject({ status: "deferred", detail: "a sync is running" });
  });
});

describe("review: a QuickBooks request that times out once", () => {
  it("is tried once more, so a slow page isn't a missing data type", async () => {
    const calls: any[] = [];
    globalThis.fetch = (async (_url: unknown, init: any) => {
      calls.push(init);
      if (calls.length === 1) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return new Response(JSON.stringify({ QueryResponse: { Bill: [{ Id: "1" }] } }), { status: 200 });
    }) as any;
    expect(await qboQuery("realm", "token", "SELECT * FROM Bill")).toEqual({ QueryResponse: { Bill: [{ Id: "1" }] } });
    expect(calls).toHaveLength(2);
  });
});

describe("review: the send day moved earlier just after the brief went", () => {
  afterEach(realClock);

  it("doesn't send a second brief, labelled with the week before", async () => {
    clockAt(Date.parse("2026-11-02T10:00:05Z")); // a Monday
    await company("a", { emailRecipients: ["a@acme.test"], emailDay: 1, emailHour: 8, emailTimezone: "UTC" });
    // Last week's brief, sent last Monday.
    h.db.weeklyDigest.rows.push({
      id: "prev", connectionId: "a", weekStarting: new Date("2026-10-26T00:00:00Z"), emailedAt: new Date("2026-10-26T08:00:30Z"),
      metrics: { jobs: [], builtAt: "2026-10-26T08:00:00Z" }, createdAt: new Date("2026-10-26T08:00:00Z"),
    });
    expect((await run()).result("a")).toMatchObject({ status: "sent" });
    // Moved to Sunday, 15 minutes later.
    Object.assign(row("a"), { emailDay: 0, briefClaimedAt: null });
    clockAt(Date.parse("2026-11-02T10:15:05Z"));
    expect((await run()).result("a")).toMatchObject({ status: "skipped", detail: "a brief already went out after this send's time" });
    expect(h.mail.sent.map((m) => m.subject)).toEqual(["a: Weekly Profit Brief, week of Nov 2, 2026"]);
  });
});

// ============================================================================
// Second review of the audit Oct 27 fixes
// ============================================================================

describe("review 2: the on-hold notices don't contradict each other", () => {
  const classes = "Your jobs are set to come from QuickBooks Classes, but QuickBooks sent no classes. If your jobs aren't classes, change how your jobs are set up in Settings.";
  afterEach(realClock);

  it("sends no waiting notice once the failing one went for the same problem", async () => {
    const scheduledAt = week().scheduledAt;
    clockAt(scheduledAt.getTime() + 25 * HOUR);
    await company("a", {
      syncVersion: 6, emailRecipients: ["a@acme.test"], ...schedule(new RealDate(scheduledAt.getTime())),
      lastSyncedAt: new Date(Date.now() - 4 * 24 * HOUR), lastSyncStatus: "error", lastSyncError: classes, lastSyncAttemptAt: new Date(Date.now() - 30 * MIN),
    });
    expect((await run()).result("a")).toMatchObject({ detail: "waiting for the upgrade sync, which is failing; owner told" });
    // The owner fixes the setting, and the re-read resumes: partway on the last run.
    clockAt(lastRunOf(scheduledAt));
    Object.assign(row("a"), { lastSyncStatus: "success", lastSyncError: null, lastSyncAttemptAt: new Date(Date.now() - 20 * MIN), fullSyncContinueAt: new Date(Date.now() - 20 * MIN) });
    expect((await run()).result("a")).toMatchObject({ detail: "waiting for the upgrade sync; owner already told", endsWaiting: true });
    expect(h.mail.sent).toHaveLength(1);
  });

  it("says the brief hasn't gone out yet in the failing notice, which goes while it still can", async () => {
    const { briefOnHoldEmail } = await import("../email/templates");
    const failing = briefOnHoldEmail("Acme", null, "https://x/settings").text;
    expect(failing).toContain("so its Weekly Profit Brief hasn't gone out yet.");
    expect(failing).not.toContain("didn't go out this week");
    expect(failing).toContain("We'll only email you about this once");
    expect(read("lib/email/templates.ts")).not.toContain("sends this notice after a day either way");
  });
});

describe("review 2: a partly sent brief whose send day then moves earlier", () => {
  afterEach(realClock);

  it("is reported once, not dropped silently", async () => {
    clockAt(Date.parse("2026-11-02T10:00:05Z")); // a Monday
    await company("a", { emailDay: 1, emailHour: 8, emailTimezone: "UTC" });
    h.mail.behave["b@acme.test"] = "busy";
    expect((await run()).result("a")).toMatchObject({ status: "retry_later" });
    // The owner moves the brief to Sunday 8am, before b@ has it.
    Object.assign(row("a"), { emailDay: 0, briefClaimedAt: null });
    clockAt(Date.parse("2026-11-02T11:15:05Z"));
    sentry.events = [];
    resetReportLimit();
    const moved = await run();
    expect(moved.result("a")).toMatchObject({ status: "skipped", partlySent: true });
    expect(sentry.events.filter((e) => e.type === "BriefNotSent").map((e) => e.value)).toEqual([
      "1 weekly brief reached only some of their recipients, and the rest won't get it: the email provider couldn't take theirs before the week's window closed or the send day was moved.",
    ]);
    // Once.
    clockAt(Date.parse("2026-11-03T07:45:05Z"));
    sentry.events = [];
    resetReportLimit();
    expect((await run()).result("a")).toEqual({ connectionId: "a", status: "skipped", detail: "a brief already went out after this send's time" });
    expect(sentry.events.filter((e) => e.type === "BriefNotSent")).toEqual([]);
    expect(sentTo()).toEqual(["a@acme.test"]);
  });
});

describe("review 2: E3, a doubt that's no doubt", () => {
  const jobs: SummaryJobFacts[] = [
    { jobName: "Harbor Deck", status: "open", marginPct: -0.4, forecastMarginPct: null },
    { jobName: "Smith Remodel", status: "open", marginPct: 0.05, forecastMarginPct: null },
  ];
  const rules = (s: string) => findSummaryProblems(s, { jobs, comparison: "changes", input: "" }).map((p) => p.rule);

  it("catches a loss claimed after regardless of whether, no matter whether, no longer whether, or will stop", () => {
    for (const s of [
      "Regardless of whether the deposit is counted Smith Remodel is losing money.",
      "No matter whether you count labor Smith Remodel is losing money.",
      "The question is no longer whether Smith Remodel is losing money but by how much.",
      "There's no sign that Smith Remodel will stop losing money.",
      "Smith Remodel isn't far enough along to stop losing money.",
    ]) {
      expect({ s, rules: rules(s) }).toEqual({ s, rules: ["loss_without_loss"] });
    }
  });

  it("still reads the true ones as true", () => {
    // Third review: "will stop" about something else leaves the doubt.
    expect(rules("We can't tell whether the crew will stop work before Smith Remodel is losing money.")).toEqual([]);
    expect(rules("We can't tell whether Harbor Deck is losing money.")).toEqual([]);
    expect(rules("There's no sign that Harbor Deck is losing money.")).toEqual([]);
    expect(rules("Smith Remodel isn't far enough along to forecast.")).toEqual([]);
  });
});

describe("review 2: a QuickBooks request that never answers stays inside about 46 seconds", () => {
  afterEach(realClock);

  it("gives the one more try 15 seconds, not 30", async () => {
    const limits: number[] = [];
    const realAbortTimeout = AbortSignal.timeout;
    AbortSignal.timeout = ((ms: number) => {
      limits.push(ms);
      return realAbortTimeout.call(AbortSignal, ms);
    }) as any;
    try {
      globalThis.fetch = (async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }) as any;
      await expect(qboQuery("realm", "token", "SELECT * FROM Bill")).rejects.toThrow("no answer in time");
      expect(limits).toEqual([30_000, 15_000]);
    } finally {
      AbortSignal.timeout = realAbortTimeout;
    }
  });

  it("doesn't wait out a throttle that would take it past the budget", async () => {
    const calls: number[] = [];
    clockAt(Date.now());
    globalThis.fetch = (async () => {
      calls.push(Date.now());
      if (calls.length === 1) {
        // No answer for 30 seconds.
        clockAt(Date.now() + 30_000);
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      // The one more try is throttled 15 seconds in, with Retry-After 10.
      clockAt(Date.now() + 15_000);
      return new Response("{}", { status: 429, headers: { "retry-after": "10" } });
    }) as any;
    const err = await qboQuery("realm", "token", "SELECT * FROM Bill").catch((e) => e);
    expect(err).toBeInstanceOf(QboTemporarilyUnavailableError);
    expect(err.message).toContain("status 429");
    expect(calls).toHaveLength(2);
  });
});

