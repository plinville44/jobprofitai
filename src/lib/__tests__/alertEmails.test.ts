import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

// Profit alert emails go one per recipient, and each alert goes to each
// address once. Before, the nightly job marked alerts sent as soon as any
// one recipient got them, so a recipient whose send failed never got them,
// and a run cut off partway through the list sent them to everyone again.

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));

// Resend's v3 contract: send() resolves with { data, error } and doesn't throw.
const sent: { to: string; subject: string; text: string }[] = [];
/** Errors to return, by recipient, for the next send to that address. */
let failFor: Record<string, { message: string; name?: string }> = {};
vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (payload: any) => {
        const to = String(payload.to[0]);
        const err = failFor[to];
        if (err) {
          delete failFor[to];
          return { data: null, error: err };
        }
        sent.push({ to, subject: payload.subject, text: payload.text });
        return { data: { id: `msg_${sent.length}` }, error: null };
      },
    };
  },
}));

import { sendProfitAlerts } from "../email/lifecycle";
import { alertsDelivered, alertSendFailure } from "../briefSend";

const A = "owner@acme.test";
const B = "pm@acme.test";
const busy = { message: "Too many requests", name: "rate_limit_exceeded" };
const refused = { message: "Invalid `to` field", name: "validation_error" };
const alert = (alertId: string, jobName: string) => ({ alertId, jobName });
const render = (alerts: { jobName: string }[]) => ({
  subject: alerts.length === 1 ? `${alerts[0].jobName} needs a look` : `${alerts.length} jobs need a look`,
  html: "<p>alerts</p>",
  text: alerts.map((a) => a.jobName).join(", "),
});

/** One nightly run's sends for these recipients, and the alerts it would mark sent. */
async function run(recipients: string[], alerts: { alertId: string; jobName: string }[]) {
  const outcomes = [];
  for (const recipient of recipients) {
    const { result, has } = await sendProfitAlerts({ ownerId: "u1", recipient, alerts, render });
    outcomes.push({ has, failed: alertSendFailure(result) });
  }
  return alertsDelivered(alerts.map((a) => a.alertId), outcomes);
}

beforeEach(() => {
  fake.client = createFakePrisma();
  sent.length = 0;
  failFor = {};
  process.env.RESEND_API_KEY = "re_test_key";
  delete process.env.EMAIL_DEV_REDIRECT;
});

describe("profit alert emails", () => {
  const a1 = alert("ja1", "Smith kitchen");
  const a2 = alert("ja2", "Jones deck");

  it("keeps an alert waiting for a recipient whose send failed, and sends it to that recipient alone next time", async () => {
    failFor[B] = busy;
    expect(await run([A, B], [a1])).toEqual([]);
    expect(sent.map((s) => s.to)).toEqual([A]);

    expect(await run([A, B], [a1])).toEqual(["ja1"]);
    expect(sent.map((s) => s.to)).toEqual([A, B]);
  });

  it("sends nothing twice when a run cut off partway through the list is run again", async () => {
    // The first run died after the first recipient.
    await run([A], [a1, a2]);
    expect(await run([A, B], [a1, a2])).toEqual(["ja1", "ja2"]);
    expect(sent.map((s) => s.to)).toEqual([A, B]);
  });

  it("sends a recipient only the alerts they haven't had", async () => {
    failFor[B] = busy;
    await run([A, B], [a1]);
    // By the next run a second alert has fired.
    expect(await run([A, B], [a1, a2])).toEqual(["ja1", "ja2"]);
    expect(sent.map((s) => [s.to, s.text])).toEqual([
      [A, "Smith kitchen"],
      [A, "Jones deck"],
      [B, "Smith kitchen, Jones deck"],
    ]);
  });

  it("doesn't hold alerts back for an address that was refused, but keeps them when nobody got them", async () => {
    failFor[B] = refused;
    expect(await run([A, B], [a1])).toEqual(["ja1"]);

    fake.client = createFakePrisma();
    failFor = { [A]: refused, [B]: refused };
    expect(await run([A, B], [a1])).toEqual([]);
  });

  it("treats the same address in another case as one recipient", async () => {
    await run([A, A.toUpperCase()], [a1]);
    expect(sent).toHaveLength(1);
  });

  it("frees a failed send's keys for the retry and keeps the failure on record", async () => {
    failFor[A] = busy;
    await run([A], [a1]);
    const failed = (fake.client as any).emailEvent.rows.filter((r: any) => r.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].dedupeKey.startsWith("failed:")).toBe(true);
    await run([A], [a1]);
    expect(sent).toHaveLength(1);
    const ok = (fake.client as any).emailEvent.rows.filter((r: any) => r.status === "sent");
    expect(ok.map((r: any) => r.dedupeKey)).toEqual([`profit_alert:ja1:${A}`]);
    expect(ok[0].subject).toBe("Smith kitchen needs a look");
  });

  it("sorts send results into sent, worth retrying and refused", () => {
    expect(alertSendFailure({ ok: true })).toBeNull();
    expect(alertSendFailure({ ok: true, skipped: true })).toBeNull();
    expect(alertSendFailure({ ok: false, transient: true })).toBe("retry");
    expect(alertSendFailure({ ok: false, skipped: true })).toBe("retry");
    expect(alertSendFailure({ ok: false })).toBe("refused");
  });

  it("is how the nightly job sends them", () => {
    const route = readFileSync(join(__dirname, "..", "..", "app", "api", "cron", "nightly-sync", "route.ts"), "utf8");
    expect(route).toContain("sendProfitAlerts(");
    expect(route).toContain("alertsDelivered(");
    expect(route).not.toContain("sendEmail(");
  });
});
