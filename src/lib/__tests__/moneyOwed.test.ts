import { describe, it, expect, vi } from "vitest";

// profitability.ts imports the Prisma client for its async wrappers; the
// pure functions tested here never touch it.
vi.mock("../prisma", () => ({ prisma: {} }));

import { computeJobFinancials, type FinancialContext, type JobFinancials } from "../profitability";
import { computeMoneyOwed } from "../moneyOwed";
import { buildWipSchedule } from "../wipSchedule";

const NOW = new Date("2026-09-28T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const ctx: FinancialContext = {
  now: NOW,
  targetMarginPct: 25,
  categoryTargetMarginPct: {},
  overheadEnabled: false,
  overheadMethod: null,
  overheadValue: null,
  lastSyncedAt: daysAgo(1),
};

function openJob(id: string, p: { contract: number | null; estimate: number | null; spent: number; billed: number; percent?: number; lastActivityDaysAgo?: number }): JobFinancials {
  const when = daysAgo(p.lastActivityDaysAgo ?? 5);
  return computeJobFinancials(
    {
      id,
      name: id,
      customerName: null,
      status: "open",
      category: null,
      estimatedRevenue: p.contract,
      estimatedCost: p.estimate,
      percentCompleteOverride: p.percent ?? null,
      qboCreatedAt: daysAgo(300),
      startDate: null,
      endDate: null,
      updatedAt: when,
      costEntries: p.spent > 0 ? [{ category: "materials", amount: p.spent, txnDate: when }] : [],
      invoices: p.billed > 0 ? [{ amount: p.billed, status: "open", txnDate: when }] : [],
    },
    ctx
  );
}

describe("money owed: work done, not billed (U5, C15g)", () => {
  it("doesn't say billing is keeping up when nothing could be checked, and says what's missing", () => {
    const jobs = [
      openJob("NoContract", { contract: null, estimate: 40_000, spent: 10_000, billed: 5_000 }),
      openJob("NoProgress", { contract: 50_000, estimate: null, spent: 10_000, billed: 5_000 }),
      openJob("PastEstimate", { contract: 100_000, estimate: 80_000, spent: 85_000, billed: 60_000 }),
    ];
    const owed = computeMoneyOwed({ now: NOW, jobs, openInvoices: [] });
    expect(owed.unbilled.checked).toBe(0);
    expect(owed.unbilled.notChecked).toEqual({ contract: 1, progress: 1, estimate_passed: 1 });
    expect(owed.unbilled.jobs).toEqual([]);
    // The job past its estimate isn't counted as $40,000 under billed.
    expect(owed.unbilled.total).toBe(0);
  });

  it("uses the WIP schedule's figures, so the two tie", () => {
    const jobs = [
      openJob("Big", { contract: 100_000, estimate: 60_000, spent: 30_000, billed: 20_000 }), // 50% done, $30,000 under
      openJob("Small", { contract: 100_000, estimate: 80_000, spent: 40_000, billed: 48_000 }), // $2,000 under: timing
      openJob("Ahead", { contract: 50_000, estimate: 40_000, spent: 10_000, billed: 20_000 }), // over billed
      openJob("Idle", { contract: 50_000, estimate: 40_000, spent: 20_000, billed: 0, lastActivityDaysAgo: 200 }),
      openJob("PastEstimate", { contract: 100_000, estimate: 80_000, spent: 85_000, billed: 60_000 }),
    ];
    const owed = computeMoneyOwed({ now: NOW, jobs, openInvoices: [] });
    const wip = buildWipSchedule(jobs, NOW);
    expect(owed.unbilled.jobs.map((j) => [j.jobId, j.amount])).toEqual([["Big", 30_000]]);
    expect(owed.unbilled.smallTotal).toBe(2_000);
    expect(owed.unbilled.total + owed.unbilled.smallTotal).toBe(wip.totals.underBilled);
    expect(owed.unbilled.checked).toBe(wip.inProgress.length);
    expect(owed.unbilled.checked).toBe(3);
  });
});

describe("money owed: unpaid invoices (U5, C15g)", () => {
  const row = (p: { jobId: string; txn: number; due?: number; balance: number; id?: string }) => ({
    jobId: p.jobId,
    jobName: p.jobId,
    customerName: null,
    qboInvoiceId: p.id ?? null,
    txnDate: daysAgo(p.txn),
    dueDate: p.due == null ? null : daysAgo(p.due),
    openBalance: p.balance,
  });

  it("ages from the invoice date when due dates aren't stored, and lists each invoice oldest first", () => {
    const owed = computeMoneyOwed({
      now: NOW,
      jobs: [],
      openInvoices: [row({ jobId: "A", txn: 10, balance: 5_000, id: "1" }), row({ jobId: "A", txn: 75, balance: 2_000, id: "2" })],
    });
    expect(owed.unpaid.agedFrom).toBe("invoice_date");
    const a = owed.unpaid.jobs[0];
    expect(a.buckets).toEqual([5_000, 0, 2_000, 0]);
    expect(a.invoiceList.map((i) => [i.qboInvoiceId, i.ageDays, i.openBalance])).toEqual([
      ["2", 75, 2_000],
      ["1", 10, 5_000],
    ]);
    expect(owed.unpaid.over60).toBe(2_000);
  });

  it("ages from the due date when every invoice has one", () => {
    const owed = computeMoneyOwed({
      now: NOW,
      jobs: [],
      openInvoices: [row({ jobId: "A", txn: 75, due: 45, balance: 2_000 }), row({ jobId: "A", txn: 20, due: -10, balance: 1_000 })],
    });
    expect(owed.unpaid.agedFrom).toBe("due_date");
    expect(owed.unpaid.jobs[0].buckets).toEqual([1_000, 2_000, 0, 0]);
    expect(owed.unpaid.jobs[0].invoiceList.map((i) => i.ageDays)).toEqual([45, 0]);
    // Due in 10 days: not "0 days past due".
    expect(owed.unpaid.jobs[0].invoiceList.map((i) => i.notYetDue)).toEqual([false, true]);
    expect(owed.unpaid.over60).toBe(0);
  });

  it("keeps each invoice's number and due date, and ages from invoice dates if any due date is missing", () => {
    const owed = computeMoneyOwed({
      now: NOW,
      jobs: [],
      openInvoices: [
        { ...row({ jobId: "A", txn: 75, due: 45, balance: 2_000, id: "9" }), docNumber: "1042" },
        row({ jobId: "A", txn: 20, balance: 1_000, id: "10" }),
      ],
    });
    // One invoice has no due date stored, so none is aged from it: the buckets never mix two meanings.
    expect(owed.unpaid.agedFrom).toBe("invoice_date");
    const [first, second] = owed.unpaid.jobs[0].invoiceList;
    expect(first.docNumber).toBe("1042");
    expect(first.dueDate).toEqual(daysAgo(45));
    expect(first.ageDays).toBe(75);
    expect(second.docNumber).toBeNull();
    expect(owed.unpaid.jobs[0].invoiceList.every((i) => !i.notYetDue)).toBe(true);
  });

  it("counts an invoice split across jobs by class once", () => {
    const owed = computeMoneyOwed({
      now: NOW,
      jobs: [],
      openInvoices: [row({ jobId: "A", txn: 10, balance: 600, id: "7" }), row({ jobId: "B", txn: 10, balance: 400, id: "7" })],
    });
    expect(owed.unpaid.invoices).toBe(1);
    expect(owed.unpaid.total).toBe(1_000);
    expect(owed.unpaid.jobs.map((j) => j.invoices)).toEqual([1, 1]);
  });
});
