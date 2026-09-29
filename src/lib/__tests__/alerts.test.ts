import { describe, it, expect, vi, beforeEach } from "vitest";

// A small stand-in for the three tables evaluateAlerts touches, shaped to
// the queries it makes (the shared fake can't filter JobAlert by its job's
// company or upsert on the compound key).
type AlertRow = { id: string; jobId: string; kind: string; emailed: boolean };
const db: {
  connection: Record<string, any>;
  alerts: AlertRow[];
  seq: number;
  paused: boolean;
  items: { jobId: string; jobName: string; issueCode: string; issue: string; financialImpact: number | null }[];
} = { connection: {}, alerts: [], seq: 0, paused: false, items: [] };

vi.mock("@/lib/prisma", () => ({
  prisma: {
    quickBooksConnection: {
      findUniqueOrThrow: async () => ({ ...db.connection }),
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(db.connection, data),
    },
    jobAlert: {
      findMany: async () => db.alerts.map((a) => ({ ...a })),
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        db.alerts = db.alerts.filter((a) => !where.id.in.includes(a.id));
      },
      upsert: async ({ where, create }: { where: { jobId_kind: { jobId: string; kind: string } }; create: Omit<AlertRow, "id"> }) => {
        const k = where.jobId_kind;
        if (!db.alerts.some((a) => a.jobId === k.jobId && a.kind === k.kind)) db.alerts.push({ id: `a${++db.seq}`, ...create });
      },
      updateMany: async ({ where, data }: { where: { id?: { in: string[] }; jobId?: string; kind?: string }; data: Partial<AlertRow> }) => {
        for (const a of db.alerts) {
          if (where.id && !where.id.in.includes(a.id)) continue;
          if (where.jobId && (a.jobId !== where.jobId || a.kind !== where.kind)) continue;
          Object.assign(a, data);
        }
      },
    },
  },
}));
vi.mock("@/lib/planLimits", () => ({ isOverPlanLimit: async () => db.paused }));
vi.mock("@/lib/profitability", () => ({
  getConnectionProfitData: async () => ({
    jobs: db.items.map((i) => ({ jobId: i.jobId, status: "open" })),
    needsAttention: db.items.map((i) => ({ ...i, severity: "high", confidence: "high" })),
    forecasts: new Map(),
  }),
}));

import { alertsNeedBaseline, evaluateAlerts, hasCleared, markAlertsSent } from "../alerts";

const job = (over: Record<string, unknown> = {}) =>
  ({ status: "open", varianceVsEstimatePct: 0.12, targetMarginPct: 25, estimatedRevenue: 100_000, wip: null, ...over }) as any;

describe("hasCleared", () => {
  it("clears everything once the job is finished or gone", () => {
    expect(hasCleared("over_budget", job({ status: "closed" }), undefined)).toBe(true);
    expect(hasCleared("underbilled", undefined, undefined)).toBe(true);
  });

  it("re-arms over budget only once back within 5%, not while hovering near 10%", () => {
    expect(hasCleared("over_budget", job({ varianceVsEstimatePct: 0.09 }), undefined)).toBe(false);
    expect(hasCleared("over_budget", job({ varianceVsEstimatePct: 0.04 }), undefined)).toBe(true);
  });

  it("keeps an alert whose figure can't be worked out any more", () => {
    expect(hasCleared("over_budget", job({ varianceVsEstimatePct: null }), undefined)).toBe(false);
    expect(hasCleared("forecast_below_target", job(), undefined)).toBe(false);
    expect(hasCleared("forecast_below_target", job(), { available: false } as any)).toBe(false);
    expect(hasCleared("underbilled", job({ wip: null }), undefined)).toBe(false);
  });

  it("clears a forecast alert once the forecast is back at target", () => {
    expect(hasCleared("forecast_below_target", job(), { available: true, forecastMarginPct: 0.265 } as any)).toBe(true);
    expect(hasCleared("forecast_below_target", job(), { available: true, forecastMarginPct: 0.255 } as any)).toBe(false);
    expect(hasCleared("forecast_below_target", job(), { available: true, forecastMarginPct: 0.2 } as any)).toBe(false);
  });

  it("clears underbilling only once well under the raise threshold", () => {
    expect(hasCleared("underbilled", job({ wip: { overUnderBilling: -3000 } }), undefined)).toBe(false);
    expect(hasCleared("underbilled", job({ wip: { overUnderBilling: -2000 } }), undefined)).toBe(true);
  });
});

describe("alertsNeedBaseline", () => {
  const baselined = new Date("2026-09-20T00:00:00Z");
  const before = new Date("2026-09-19T00:00:00Z");
  const after = new Date("2026-09-21T00:00:00Z");

  it("records quietly on a company's first check, and after Settings clears it", () => {
    expect(alertsNeedBaseline({ alertsBaselinedAt: null })).toBe(true);
    expect(alertsNeedBaseline({ alertsBaselinedAt: baselined })).toBe(false);
  });

  it("records quietly again after any change of basis since the last baseline", () => {
    expect(alertsNeedBaseline({ alertsBaselinedAt: baselined, laborBurdenSetAt: after })).toBe(true);
    expect(alertsNeedBaseline({ alertsBaselinedAt: baselined, basisChangedAt: after })).toBe(true);
    expect(alertsNeedBaseline({ alertsBaselinedAt: baselined, laborBurdenSetAt: before, basisChangedAt: before })).toBe(false);
    // A rebuild Settings asked for that hasn't synced yet.
    expect(alertsNeedBaseline({ alertsBaselinedAt: baselined, rebuildRequestedAt: after, lastFullSyncAt: before })).toBe(true);
  });
});

describe("evaluateAlerts", () => {
  const NOW = new Date("2026-09-28T06:00:00Z");
  const over = (jobId: string) => ({ jobId, jobName: `Job ${jobId}`, issueCode: "over_budget", issue: "Over its estimate", financialImpact: 5_000 });

  beforeEach(() => {
    db.connection = {
      userId: "owner",
      alertsBaselinedAt: new Date("2026-09-01T00:00:00Z"),
      laborBurdenSetAt: null,
      basisChangedAt: null,
      rebuildRequestedAt: null,
      lastFullSyncAt: new Date("2026-09-27T00:00:00Z"),
    };
    db.alerts = [];
    db.items = [];
    db.paused = false;
  });

  it("emails a condition that's new since the last check", async () => {
    db.items = [over("a")];
    const r = await evaluateAlerts("c1", NOW);
    expect(r.baseline).toBe(false);
    expect(r.pending.map((p) => p.jobId)).toEqual(["a"]);
  });

  it("sends nothing after a labor burden change, including alerts still waiting from before it", async () => {
    // Waiting from before: recorded, but the owner hadn't verified yet.
    db.alerts = [{ id: "old", jobId: "a", kind: "over_budget", emailed: false }];
    db.items = [over("a"), over("b"), over("c")];
    db.connection.laborBurdenSetAt = new Date("2026-09-27T12:00:00Z");
    const r = await evaluateAlerts("c1", NOW);
    expect(r.baseline).toBe(true);
    expect(r.pending).toEqual([]);
    expect(db.alerts.every((a) => a.emailed)).toBe(true);
    expect(db.connection.alertsBaselinedAt).toEqual(NOW);
    // The next night, only what's really new goes out.
    db.items = [over("a"), over("b"), over("c"), over("d")];
    const next = await evaluateAlerts("c1", new Date("2026-09-29T06:00:00Z"));
    expect(next.pending.map((p) => p.jobId)).toEqual(["d"]);
  });

  it("sends nothing after a switch of job setup, whose jobs all have new ids", async () => {
    db.alerts = [{ id: "old", jobId: "old-job", kind: "over_budget", emailed: true }];
    db.items = [over("new-1"), over("new-2")];
    db.connection.basisChangedAt = new Date("2026-09-27T12:00:00Z");
    const r = await evaluateAlerts("c1", NOW);
    expect(r).toMatchObject({ baseline: true, pending: [] });
  });

  it("stays quiet while a rebuild Settings asked for is still waiting, and once more after it", async () => {
    db.items = [over("a")];
    db.connection.alertsBaselinedAt = null;
    db.connection.rebuildRequestedAt = new Date("2026-09-27T12:00:00Z");
    db.connection.lastFullSyncAt = null;
    expect((await evaluateAlerts("c1", NOW)).pending).toEqual([]);
    expect(db.connection.alertsBaselinedAt).toBeNull();
    // The rebuild syncs: its figures are recorded quietly too.
    db.connection.lastFullSyncAt = new Date("2026-09-28T05:00:00Z");
    db.items = [over("a"), over("b")];
    const r = await evaluateAlerts("c1", NOW);
    expect(r).toMatchObject({ baseline: true, pending: [] });
    expect(db.connection.alertsBaselinedAt).toEqual(NOW);
  });

  it("sends nothing for a company the plan doesn't cover, and records quietly once it's covered again", async () => {
    db.paused = true;
    db.items = [over("a")];
    const r = await evaluateAlerts("c1", NOW);
    expect(r).toMatchObject({ pending: [], paused: true });
    expect(db.connection.alertsBaselinedAt).toBeNull();
    db.paused = false;
    expect((await evaluateAlerts("c1", NOW)).pending).toEqual([]);
  });

  it("marks what was sent", async () => {
    db.items = [over("a")];
    const r = await evaluateAlerts("c1", NOW);
    await markAlertsSent(r.pending);
    expect((await evaluateAlerts("c1", NOW)).pending).toEqual([]);
  });
});
