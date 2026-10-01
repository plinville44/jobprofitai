import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Error and cron monitoring through Sentry (src/lib/monitoring.ts). The app
// holds contractors' QuickBooks books, so most of this is about what must
// never leave it: no figures, names, email addresses, tokens, cookies,
// headers, request bodies or query strings.

const admin = { session: null as null | { userId: string; email: string } };
vi.mock("@/lib/adminAuth", () => ({
  getAdminSession: async () => admin.session,
}));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
}));

import {
  buildErrorEvent,
  CHECKIN_MARGIN_MINUTES,
  checkInEnvelope,
  errorEnvelope,
  isCodeOrDatabaseFault,
  parseDsn,
  reportError,
  resetReportLimit,
  scrubText,
  sendEnvelope,
  withCronMonitor,
} from "../monitoring";
import { onRequestError } from "../../instrumentation";
import { GET as monitoringTestGET } from "../../app/api/admin/monitoring-test/route";

const SRC = join(__dirname, "..", "..");
const ROOT = join(SRC, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const DSN = "https://abc123def456@o4501.ingest.us.sentry.io/4507654321";
const ENVELOPE_URL = "https://o4501.ingest.us.sentry.io/api/4507654321/envelope/";

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
let sent: Sent[] = [];
const realFetch = globalThis.fetch;
const ENV_KEYS = ["SENTRY_DSN", "VERCEL_ENV", "VERCEL_GIT_COMMIT_SHA"] as const;
let savedEnv: Record<string, string | undefined> = {};

/** A fake fetch that records each request; `reply` decides the answer (default: Sentry's 200). */
function useFetch(reply?: (n: number) => Promise<unknown>) {
  globalThis.fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    const n = sent.length;
    sent.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    return reply ? reply(n) : { status: 200 };
  }) as unknown as typeof fetch;
}
/** The item payload of a one-item envelope. */
const payload = (s: Sent) => JSON.parse(s.body.split("\n")[2]);

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, values);
}

/** An error with a stack we control, as V8 writes one (newest call first). */
function errorWithStack(message: string, name = "Error") {
  const err = new Error(message);
  err.name = name;
  err.stack = [
    `${name}: ${message}`,
    "    at innerFn (/var/task/.next/server/chunks/123.js:10:5)",
    "    at async outerFn (/var/task/.next/server/app/api/jobs/route.js?v=9f8e7d&token=abc:20:7)",
    "    at /var/task/node_modules/next/dist/server/base-server.js:30:9",
    "    at async Promise.all (index 0)",
  ].join("\n");
  return err;
}

describe("monitoring", () => {
  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    sent = [];
    resetReportLimit();
    useFetch();
    setEnv({ SENTRY_DSN: DSN, VERCEL_ENV: "production" });
    admin.session = null;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  describe("parseDsn", () => {
    it("reads the key, host and project, and builds the envelope URL", () => {
      expect(parseDsn(DSN)).toEqual({
        publicKey: "abc123def456",
        host: "o4501.ingest.us.sentry.io",
        projectId: "4507654321",
        envelopeUrl: ENVELOPE_URL,
      });
    });

    it("keeps a path before the project, as self-hosted Sentry uses", () => {
      expect(parseDsn("https://k1@sentry.example.com:9000/sentry/42")?.envelopeUrl).toBe(
        "https://sentry.example.com:9000/sentry/api/42/envelope/"
      );
    });

    it("returns null for a missing or malformed DSN", () => {
      for (const bad of [
        undefined,
        null,
        "",
        "   ",
        "not a dsn",
        "http://abc@o1.ingest.sentry.io/1",
        "https://o1.ingest.sentry.io/1",
        "https://abc@o1.ingest.sentry.io/",
        "https://abc@o1.ingest.sentry.io/project",
      ]) {
        expect({ bad, parsed: parseDsn(bad) }).toEqual({ bad, parsed: null });
      }
    });
  });

  describe("scrubText", () => {
    it("removes email addresses", () => {
      const out = scrubText("Send to pat.books+jobs@firm-co.com failed, cc owner@example.org");
      expect(out).not.toContain("@");
      expect(out).toBe("Send to [email] failed, cc [email]");
    });

    it("removes bearer credentials, JWTs and secret-looking values", () => {
      const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.c2lnbmF0dXJl";
      const out = scrubText(`Authorization: Bearer abc.def-123 session ${jwt} token=s3cr3t password=hunter2`);
      for (const secret of ["abc.def-123", jwt, "eyJ", "s3cr3t", "hunter2"]) expect(out).not.toContain(secret);
      expect(out).toContain("Bearer [redacted]");
      expect(out).toContain("token=[redacted]");
    });

    it("removes long token-like strings and IDs", () => {
      const out = scrubText("refresh failed for AB12cd34EF56gh78IJ90kl12mn and cuid clx9a8b7c6d5e4f3g2h1i0jkl");
      expect(out).toBe("refresh failed for [token] and cuid [token]");
    });

    it("drops URL query strings, and long numbers such as a QuickBooks company ID", () => {
      const out = scrubText(
        "request to https://quickbooks.api.intuit.com/v3/company/9130349701234567/query?query=select%20*%20from%20Invoice&minorversion=70 failed"
      );
      expect(out).toBe("request to https://quickbooks.api.intuit.com/v3/company/[number]/query failed");
    });

    it("removes quoted text, where library errors echo back values", () => {
      const out = scrubText(`Unexpected token 'S', "Smith Kitchen Remodel" is not valid JSON; job “Oak St”; name 'Pat Jones'`);
      for (const name of ["Smith", "Kitchen", "Oak St", "Pat Jones"]) expect(out).not.toContain(name);
    });

    it("removes amounts, figures and IP addresses", () => {
      const out = scrubText("Invoice total $12,345.67 did not match 9876.50 (1,250 hours, 32.5%) from 203.0.113.9");
      for (const figure of ["12,345", "345.67", "9876", "1,250", "32.5", "203.0.113.9"]) expect(out).not.toContain(figure);
    });

    it("keeps what's useful and safe: status codes, Intuit's request ID, property names, wording", () => {
      const tid = "QuickBooks API query failed with status 500 (intuit_tid: 1-66b1f2a3-2c0d8f4e5a6b7c8d9e0f1a2b)";
      expect(scrubText(tid)).toBe(tid);
      const typeError = "Cannot read properties of undefined (reading 'companyName')";
      expect(scrubText(typeError)).toBe(typeError);
      const own = "Couldn't read your QuickBooks chart of accounts, so nothing was changed. The next sync won't skip it.";
      expect(scrubText(own)).toBe(own);
    });

    it("cuts long text to about 500 characters", () => {
      const out = scrubText("word ".repeat(400));
      expect(out.length).toBeLessThanOrEqual(500);
      expect(out.endsWith("...")).toBe(true);
    });

    it("copes with things that aren't strings", () => {
      expect(scrubText(undefined)).toBe("");
      expect(scrubText(404)).toBe("404");
    });
  });

  describe("buildErrorEvent", () => {
    const env = { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: "0123abcd", NODE_ENV: "production" };

    it("has the event fields Sentry needs, and nothing about the user or the request", () => {
      const event = buildErrorEvent(errorWithStack("boom"), { route: "/api/jobs" }, { env, now: 1_790_000_000_000, eventId: "e".repeat(32) });
      expect(Object.keys(event).sort()).toEqual(
        ["environment", "event_id", "exception", "level", "platform", "release", "tags", "timestamp"].sort()
      );
      expect(event.event_id).toBe("e".repeat(32));
      expect(event.timestamp).toBe(1_790_000_000);
      expect(event.platform).toBe("node");
      expect(event.level).toBe("error");
      expect(event.environment).toBe("production");
      expect(event.release).toBe("0123abcd");
    });

    it("makes a 32-character hex event ID, and leaves the release out without a commit", () => {
      const event = buildErrorEvent(new Error("x"), {}, { env: { NODE_ENV: "development" } });
      expect(event.event_id).toMatch(/^[0-9a-f]{32}$/);
      expect(event.environment).toBe("development");
      expect("release" in event).toBe(false);
    });

    it("scrubs the message and reads the stack into frames, oldest first, with no query strings", () => {
      const event = buildErrorEvent(errorWithStack("No job for pat@firm.com at https://app.example.com/jobs?id=42&code=xyz", "TypeError"), {}, { env });
      const ex = event.exception.values[0];
      expect(ex.type).toBe("TypeError");
      expect(ex.value).toBe("No job for [email] at https://app.example.com/jobs");
      expect(ex.stacktrace?.frames).toEqual([
        { function: "?", filename: "/var/task/node_modules/next/dist/server/base-server.js", lineno: 30, colno: 9, in_app: false },
        { function: "outerFn", filename: "/var/task/.next/server/app/api/jobs/route.js", lineno: 20, colno: 7, in_app: true },
        { function: "innerFn", filename: "/var/task/.next/server/chunks/123.js", lineno: 10, colno: 5, in_app: true },
      ]);
      const json = JSON.stringify(event);
      for (const leak of ["pat@firm.com", "route.js?", "jobs?", "token=abc", "v=9f8e7d", "code=xyz"]) expect({ leak, found: json.includes(leak) }).toEqual({ leak, found: false });
    });

    it("tags only from the allow-list, whatever else is passed", () => {
      const context = {
        route: "/dashboard/jobs/[jobId]",
        method: "post",
        routeType: "render",
        router: "App Router",
        cron: "nightly-sync",
        user: { email: "pat@firm.com" },
        headers: { cookie: "jmai_session=abc", authorization: "Bearer s3cret" },
        path: "/dashboard/jobs/clx9a8b7c6d5e4f3g2h1i0jkl?tab=costs",
        body: "{\"amount\":12345}",
        companyName: "Smith Builders",
      };
      const event = buildErrorEvent(new Error("x"), context as any, { env });
      expect(event.tags).toEqual({
        route: "/dashboard/jobs/[jobId]",
        method: "POST",
        route_type: "render",
        router: "App Router",
        cron: "nightly-sync",
      });
      const json = JSON.stringify(event);
      for (const leak of ["pat@firm.com", "jmai_session", "s3cret", "clx9a8b7", "tab=costs", "12345", "Smith Builders"]) {
        expect({ leak, found: json.includes(leak) }).toEqual({ leak, found: false });
      }
      expect(json).not.toMatch(/"(user|request|extra|contexts|breadcrumbs)"/);
    });

    it("drops a tag that isn't the shape it should be, and a query string from a route", () => {
      const event = buildErrorEvent(
        new Error("x"),
        { route: "/dashboard?token=abc", method: "GET; DROP TABLE", routeType: "Render Page!", cron: "Nightly Sync" },
        { env }
      );
      expect(event.tags).toEqual({ route: "/dashboard" });
    });

    it("sends only the code and the call for a database error, which can print the query's values", () => {
      const err = new Error(
        "\nInvalid `prisma.user.create()` invocation:\n\n{\n  data: {\n    email: \"pat@firm.com\",\n    name: \"Pat Jones\",\n    amountCents: 1234500\n  }\n}\n\nUnique constraint failed on the fields: (`email`)"
      ) as Error & { code?: string };
      err.name = "PrismaClientKnownRequestError";
      err.code = "P2002";
      const event = buildErrorEvent(err, {}, { env });
      expect(event.exception.values[0]).toMatchObject({ type: "PrismaClientKnownRequestError", value: "Database error P2002 in prisma.user.create()" });
      expect(JSON.stringify(event)).not.toMatch(/pat@firm|Pat Jones|1234500/);
    });

    it("says only the type of a thrown value that isn't an Error", () => {
      const event = buildErrorEvent("Pat Jones owes $5,000", {}, { env });
      expect(event.exception.values[0]).toEqual({ type: "NonErrorThrown", value: "A value of type string was thrown instead of an Error" });
    });
  });

  describe("envelopes", () => {
    it("sends an error as one event in an envelope, with the key in X-Sentry-Auth", async () => {
      const result = await reportError(new Error("boom"), { cron: "weekly-email" });
      expect(result).toEqual({ sent: true, status: 200 });
      expect(sent).toHaveLength(1);
      const [req] = sent;
      expect(req.url).toBe(ENVELOPE_URL);
      expect(req.method).toBe("POST");
      expect(req.headers["Content-Type"]).toBe("application/x-sentry-envelope");
      expect(req.headers["X-Sentry-Auth"]).toBe(
        "Sentry sentry_version=7, sentry_key=abc123def456, sentry_client=jobprofitai-monitoring/1.0"
      );
      // No cookies or credentials of ours go with it.
      expect(Object.keys(req.headers).sort()).toEqual(["Content-Type", "X-Sentry-Auth"]);
      const lines = req.body.split("\n");
      expect(lines).toHaveLength(4);
      expect(lines[3]).toBe("");
      const header = JSON.parse(lines[0]);
      const item = JSON.parse(lines[1]);
      const event = JSON.parse(lines[2]);
      expect(Object.keys(header).sort()).toEqual(["event_id", "sent_at"]);
      expect(header.event_id).toBe(event.event_id);
      expect(new Date(header.sent_at).toISOString()).toBe(header.sent_at);
      expect(item).toEqual({ type: "event" });
      expect(event.exception.values[0].value).toBe("boom");
      expect(event.tags).toEqual({ cron: "weekly-email" });
    });

    it("writes a check-in as a check_in item", () => {
      const body = checkInEnvelope(
        { check_in_id: "c".repeat(32), monitor_slug: "lifecycle", status: "ok", environment: "production", duration: 1.5 },
        Date.UTC(2026, 8, 30, 12)
      );
      expect(body.split("\n")).toEqual([
        '{"sent_at":"2026-09-30T12:00:00.000Z"}',
        '{"type":"check_in"}',
        `{"check_in_id":"${"c".repeat(32)}","monitor_slug":"lifecycle","status":"ok","environment":"production","duration":1.5}`,
        "",
      ]);
    });

    it("writes an event envelope header with the event's ID", () => {
      const event = buildErrorEvent(new Error("x"), {}, { env: {}, eventId: "a".repeat(32) });
      const [header, item] = errorEnvelope(event, Date.UTC(2026, 8, 30)).split("\n");
      expect(JSON.parse(header)).toEqual({ event_id: "a".repeat(32), sent_at: "2026-09-30T00:00:00.000Z" });
      expect(JSON.parse(item)).toEqual({ type: "event" });
    });
  });

  describe("when reports are sent", () => {
    it("sends nothing without a DSN, or with a malformed one", async () => {
      setEnv({ VERCEL_ENV: "production" });
      expect(await reportError(new Error("x"))).toEqual({ sent: false, reason: "no_dsn" });
      setEnv({ VERCEL_ENV: "production", SENTRY_DSN: "not a dsn" });
      expect(await reportError(new Error("x"))).toEqual({ sent: false, reason: "no_dsn" });
      expect(sent).toHaveLength(0);
    });

    it("sends nothing from a preview or development deployment", async () => {
      for (const VERCEL_ENV of ["preview", "development"]) {
        setEnv({ SENTRY_DSN: DSN, VERCEL_ENV });
        expect(await reportError(new Error("x"))).toEqual({ sent: false, reason: "not_production" });
      }
      expect(sent).toHaveLength(0);
    });

    it("sends from production, and from outside Vercel when a DSN is set", async () => {
      expect((await reportError(new Error("x"))).sent).toBe(true);
      setEnv({ SENTRY_DSN: DSN });
      expect((await reportError(new Error("x"))).sent).toBe(true);
      expect(sent).toHaveLength(2);
    });

    it("lets the admin test skip the production rule, but not the DSN rule", async () => {
      setEnv({ SENTRY_DSN: DSN, VERCEL_ENV: "preview" });
      expect(await reportError(new Error("x"), {}, { anyEnvironment: true })).toEqual({ sent: true, status: 200 });
      setEnv({ VERCEL_ENV: "preview" });
      expect(await reportError(new Error("x"), {}, { anyEnvironment: true })).toEqual({ sent: false, reason: "no_dsn" });
      expect(sent).toHaveLength(1);
    });

    it("never throws when Sentry can't be reached", async () => {
      useFetch(async () => {
        throw new TypeError("fetch failed");
      });
      expect(await reportError(new Error("x"))).toEqual({ sent: true, status: null });
      globalThis.fetch = (() => {
        throw new Error("no fetch here");
      }) as unknown as typeof fetch;
      expect(await reportError(new Error("x"))).toEqual({ sent: true, status: null });
    });

    it("gives up on a send that takes too long", async () => {
      useFetch(() => new Promise(() => {}));
      const start = Date.now();
      expect(await sendEnvelope(parseDsn(DSN)!, "{}\n", 30)).toBeNull();
      expect(Date.now() - start).toBeLessThan(1_000);
    });

    it("sends at most 20 reports a minute from one server", async () => {
      for (let i = 0; i < 25; i++) await reportError(new Error(`x${i}`));
      expect(sent).toHaveLength(20);
      expect(await reportError(new Error("again"))).toEqual({ sent: false, reason: "rate_limited" });
    });
  });

  describe("withCronMonitor", () => {
    it("checks in once, when the job ends, as ok with the schedule and how long it took, and returns the job's result unchanged", async () => {
      const response = { status: 200, body: { ok: true } };
      const result = await withCronMonitor("nightly-sync", "30 * * * *", async () => response);
      expect(result).toBe(response);
      expect(sent).toHaveLength(1);
      expect(sent[0].body.split("\n")[1]).toBe('{"type":"check_in"}');
      const checkIn = payload(sent[0]);
      expect(checkIn).toMatchObject({ monitor_slug: "nightly-sync", status: "ok", environment: "production" });
      expect(checkIn.check_in_id).toMatch(/^[0-9a-f]{32}$/);
      expect(checkIn.monitor_config).toEqual({
        schedule: { type: "crontab", value: "30 * * * *" },
        checkin_margin: 10,
        timezone: "UTC",
      });
      expect(typeof checkIn.duration).toBe("number");
      expect(checkIn.duration).toBeGreaterThanOrEqual(0);
    });

    it("sends nothing while the job runs, so no check-in can arrive out of order", async () => {
      let sentDuringRun = -1;
      await withCronMonitor("weekly-email", "*/15 * * * *", async () => {
        await new Promise((r) => setTimeout(r, 20));
        sentDuringRun = sent.length;
        return "done";
      });
      expect(sentDuringRun).toBe(0);
      expect(sent.map((s) => payload(s).status)).toEqual(["ok"]);
    });

    it("leaves Sentry room for a run that uses all of its 300 seconds before calling it missed", () => {
      // The check-in comes at the end of a run, up to 300 s after its start.
      expect(CHECKIN_MARGIN_MINUTES * 60).toBeGreaterThan(300 + 60);
      // And a missed run is still reported before the next one is due.
      expect(CHECKIN_MARGIN_MINUTES).toBeLessThan(15);
    });

    it("gives each run its own check-in ID", async () => {
      await withCronMonitor("lifecycle", "0 * * * *", async () => "a");
      await withCronMonitor("lifecycle", "0 * * * *", async () => "b");
      const [a, b] = sent.map(payload);
      expect(a.check_in_id).not.toBe(b.check_in_id);
    });

    it("checks in an error, with the schedule, and rethrows the job's own error, when the job throws", async () => {
      const boom = new Error("boom");
      let caught: unknown;
      try {
        await withCronMonitor("weekly-email", "*/15 * * * *", async () => {
          throw boom;
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBe(boom);
      expect(sent).toHaveLength(1);
      expect(payload(sent[0])).toMatchObject({
        monitor_slug: "weekly-email",
        status: "error",
        monitor_config: { schedule: { type: "crontab", value: "*/15 * * * *" } },
      });
    });

    it("checks in an error when the job answers with a 5xx response, and still returns it", async () => {
      const response = { status: 503, body: { error: "down" } };
      expect(await withCronMonitor("lifecycle", "0 * * * *", async () => response)).toBe(response);
      expect(sent.map((s) => payload(s).status)).toEqual(["error"]);
      sent = [];
      await withCronMonitor("lifecycle", "0 * * * *", async () => ({ status: 401 }));
      await withCronMonitor("lifecycle", "0 * * * *", async () => undefined);
      expect(sent.map((s) => payload(s).status)).toEqual(["ok", "ok"]);
    });

    it("never lets a monitoring failure affect the job", async () => {
      useFetch(async () => {
        throw new TypeError("fetch failed");
      });
      expect(await withCronMonitor("lifecycle", "0 * * * *", async () => 42)).toBe(42);
      const boom = new RangeError("the job's own");
      await expect(
        withCronMonitor("lifecycle", "0 * * * *", async () => {
          throw boom;
        })
      ).rejects.toBe(boom);
      expect(sent).toHaveLength(2);
    });

    it("sends no check-ins from a preview deployment or without a DSN, and still runs the job", async () => {
      setEnv({ SENTRY_DSN: DSN, VERCEL_ENV: "preview" });
      expect(await withCronMonitor("lifecycle", "0 * * * *", async () => "ran")).toBe("ran");
      setEnv({ VERCEL_ENV: "production" });
      expect(await withCronMonitor("lifecycle", "0 * * * *", async () => "ran")).toBe("ran");
      expect(sent).toHaveLength(0);
    });
  });

  describe("isCodeOrDatabaseFault", () => {
    it("picks out faults in our code or the database, not QuickBooks' errors", () => {
      const prisma = new Error("x");
      prisma.name = "PrismaClientKnownRequestError";
      expect(isCodeOrDatabaseFault(new TypeError("Cannot read properties of undefined (reading 'Line')"))).toBe(true);
      expect(isCodeOrDatabaseFault(new RangeError("Invalid time value"))).toBe(true);
      expect(isCodeOrDatabaseFault(new ReferenceError("x is not defined"))).toBe(true);
      expect(isCodeOrDatabaseFault(prisma)).toBe(true);
      expect(isCodeOrDatabaseFault(new TypeError("fetch failed"))).toBe(false);
      expect(isCodeOrDatabaseFault(new Error("QuickBooks API query failed with status 400 (intuit_tid: 1-abc)"))).toBe(false);
      expect(isCodeOrDatabaseFault(new SyntaxError("Unexpected token < in JSON"))).toBe(false);
      expect(isCodeOrDatabaseFault("a string")).toBe(false);
    });
  });

  describe("onRequestError", () => {
    it("passes on only the route pattern, the method and the router and route type", async () => {
      const err = errorWithStack("render failed");
      await onRequestError(
        err,
        {
          path: "/dashboard/jobs/clx9a8b7c6d5e4f3g2h1i0jkl?tab=costs&token=abc",
          method: "GET",
          headers: { cookie: "jmai_session=eyJhbGciOiJIUzI1NiJ9.e30.sig", authorization: "Bearer s3cret", "x-forwarded-for": "198.51.100.7" },
        },
        {
          routerKind: "App Router",
          routePath: "/dashboard/jobs/[jobId]",
          routeType: "render",
          renderSource: "react-server-components-payload",
          revalidateReason: "stale",
          renderType: "dynamic-resume",
        }
      );
      expect(sent).toHaveLength(1);
      const event = payload(sent[0]);
      expect(event.tags).toEqual({ route: "/dashboard/jobs/[jobId]", method: "GET", route_type: "render", router: "App Router" });
      for (const leak of ["clx9a8b7", "tab=costs", "token", "jmai_session", "s3cret", "198.51.100.7", "react-server-components", "stale", "dynamic-resume"]) {
        expect({ leak, found: sent[0].body.includes(leak) }).toEqual({ leak, found: false });
      }
    });

    it("doesn't report Next.js's redirect and not-found signals", async () => {
      const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
      const notFound = Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
      await onRequestError(redirect, { method: "GET" }, { routePath: "/dashboard" });
      await onRequestError(notFound, { method: "GET" }, { routePath: "/dashboard" });
      expect(sent).toHaveLength(0);
    });

    it("never throws, whatever it's given", async () => {
      await onRequestError(new Error("x"), null, undefined);
      await onRequestError(undefined, { method: 5 }, { routePath: ["/a"] });
      expect(sent.map((s) => payload(s).tags)).toEqual([{}, {}]);
    });

    it("sends nothing from a preview deployment", async () => {
      setEnv({ SENTRY_DSN: DSN, VERCEL_ENV: "preview" });
      await onRequestError(new Error("x"), { method: "GET" }, { routePath: "/" });
      expect(sent).toHaveLength(0);
    });
  });

  describe("admin monitoring test route", () => {
    const call = async () => (await monitoringTestGET()) as unknown as { status: number; body: Record<string, unknown> };

    it("refuses anyone but an admin, and sends nothing", async () => {
      const res = await call();
      expect(res.status).toBe(403);
      expect(sent).toHaveLength(0);
    });

    it("sends one test error, even from a preview deployment, and says whether Sentry took it", async () => {
      admin.session = { userId: "u1", email: "admin@jobprofitai.com" };
      setEnv({ SENTRY_DSN: DSN, VERCEL_ENV: "preview" });
      useFetch(async () => ({ status: 200 }));
      const res = await call();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ dsnSet: true, dsnValid: true, sent: true, accepted: true, status: 200 });
      expect(sent).toHaveLength(1);
      const event = payload(sent[0]);
      expect(event.exception.values[0]).toMatchObject({ type: "Error", value: "JobProfitAI monitoring test" });
      expect(JSON.stringify(event)).not.toContain("admin@jobprofitai.com");
    });

    it("says when Sentry turned it down, by status code only", async () => {
      admin.session = { userId: "u1", email: "admin@jobprofitai.com" };
      useFetch(async () => ({ status: 401 }));
      expect((await call()).body).toEqual({ dsnSet: true, dsnValid: true, sent: true, accepted: false, status: 401 });
    });

    it("says when no DSN is set, and sends nothing", async () => {
      admin.session = { userId: "u1", email: "admin@jobprofitai.com" };
      setEnv({ VERCEL_ENV: "production" });
      expect((await call()).body).toEqual({ dsnSet: false, dsnValid: false, sent: false, accepted: false, status: null, reason: "no_dsn" });
      setEnv({ VERCEL_ENV: "production", SENTRY_DSN: "https://nope" });
      expect((await call()).body).toMatchObject({ dsnSet: true, dsnValid: false, sent: false });
      expect(sent).toHaveLength(0);
    });
  });

  describe("cron routes", () => {
    const crons = (JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")).crons ?? []) as { path: string; schedule: string }[];

    it("monitor each scheduled job under its vercel.json schedule, after the auth check", () => {
      expect(crons.map((c) => c.path).sort()).toEqual(["/api/cron/lifecycle", "/api/cron/nightly-sync", "/api/cron/weekly-email"]);
      for (const { path, schedule } of crons) {
        const slug = path.split("/").pop()!;
        const src = read(`app${path}/route.ts`);
        const monitor = src.indexOf(`withCronMonitor("${slug}", "${schedule}", `);
        expect({ slug, monitored: monitor > 0 }).toEqual({ slug, monitored: true });
        expect({ slug, authFirst: src.indexOf("authorizeCron(req)") < monitor }).toEqual({ slug, authFirst: true });
        expect(src).toContain("export const maxDuration = 300;");
        expect(src).toContain(`reportError(err, { cron: "${slug}" })`);
      }
    });

    it("leave the nightly sync's QuickBooks failures out of the reports", () => {
      const src = read("app/api/cron/nightly-sync/route.ts");
      expect(src).toContain('if (!syncFailed || isCodeOrDatabaseFault(err)) await reportError(err, { cron: "nightly-sync" });');
    });
  });

  describe("what the website says", () => {
    it("lists Sentry as a service provider, saying what it gets and never gets", () => {
      const privacy = read("app/(marketing)/privacy/page.tsx");
      expect(privacy).toContain('name: "Functional Software, Inc. (Sentry)"');
      expect(privacy).toContain("its message with personal details removed");
      expect(privacy).toContain("Never QuickBooks figures, names, email addresses or tokens");
      const security = read("app/(marketing)/security/page.tsx").replace(/\s+/g, " ");
      expect(security).toContain("an error report goes to Sentry, our error monitoring service");
    });

    it("uses no em or en dashes in the new files", () => {
      const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
      for (const f of ["lib/monitoring.ts", "instrumentation.ts", "app/api/admin/monitoring-test/route.ts", "lib/__tests__/monitoring.test.ts"]) {
        expect({ f, dash: DASHES.test(read(f)) }).toEqual({ f, dash: false });
      }
    });
  });
});
