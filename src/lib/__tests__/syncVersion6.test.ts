import { describe, expect, it } from "vitest";
import {
  costAccountKind,
  customersCreatedSince,
  depositCostLines,
  depositRevenueLines,
  emptyLookups,
  expenseLines,
  expenseRevenueLines,
  parentsNeedingFullSync,
  revenueByClass,
  timeActivityHours,
} from "../qboNormalize";

// The rules that changed with sync version 6. Payload shapes are trimmed
// copies of what the QuickBooks Online v3 API returns for each entity.

const lookups = emptyLookups();
lookups.accounts.set("13", { name: "Construction in Progress", fullName: "Construction in Progress", type: "Other Current Asset", subType: "OtherCurrentAssets" });
lookups.accounts.set("14", { name: "Retainage receivable", fullName: "Retainage receivable", type: "Other Current Asset", subType: "Retainage" });
lookups.accounts.set("16", { name: "Retention held", fullName: "Retention held", type: "Other Current Asset", subType: "OtherCurrentAssets" });
lookups.accounts.set("17", { name: "Undeposited Funds", fullName: "Undeposited Funds", type: "Other Current Asset", subType: "UndepositedFunds" });
lookups.accounts.set("11", { name: "Accounts Receivable", fullName: "Accounts Receivable (A/R)", type: "Accounts Receivable", subType: "AccountsReceivable" });
lookups.accounts.set("35", { name: "Checking", fullName: "Checking", type: "Bank", subType: "Checking" });
lookups.accounts.set("40", { name: "Construction Income", fullName: "Construction Income", type: "Income", subType: "SalesOfProductIncome" });
lookups.accounts.set("45", { name: "Refunds and Allowances", fullName: "Refunds and Allowances", type: "Income", subType: "DiscountsRefundsGiven" });
lookups.accounts.set("48", { name: "Interest earned", fullName: "Interest earned", type: "Other Income", subType: "InterestEarned" });
lookups.accounts.set("60", { name: "Office payroll", fullName: "Office payroll", type: "Expense", subType: "PayrollExpenses" });
lookups.accounts.set("80", { name: "Job Materials", fullName: "Job Materials", type: "Cost of Goods Sold", subType: "SuppliesMaterialsCogs" });

const jeLine = (id: string, amount: number, posting: "Debit" | "Credit", accountId: string, customer?: string) => ({
  Id: id,
  Amount: amount,
  JournalEntryLineDetail: {
    PostingType: posting,
    AccountRef: { value: accountId },
    ...(customer ? { Entity: { Type: "Customer", EntityRef: { value: customer, name: "Smith" } } } : {}),
  },
});
const acctLine = (id: string, amount: number, accountId: string, customer?: string, classId?: string) => ({
  Id: id,
  Amount: amount,
  DetailType: "AccountBasedExpenseLineDetail",
  AccountBasedExpenseLineDetail: {
    AccountRef: { value: accountId },
    ...(customer ? { CustomerRef: { value: customer, name: "Smith" } } : {}),
    ...(classId ? { ClassRef: { value: classId } } : {}),
  },
});
const total = (lines: { amount: number }[]) => lines.reduce((s, l) => s + l.amount, 0);

describe("journal entries use the same account rule as bills (C6)", () => {
  it("counts a job held in Construction in Progress once after the closing entry", () => {
    const bill = expenseLines({ Id: "501", TxnDate: "2026-06-01", Line: [acctLine("1", 10_000, "13", "21")] }, "Bill", lookups);
    const closing = expenseLines(
      { Id: "77", TxnDate: "2026-09-01", Line: [jeLine("0", 10_000, "Debit", "80", "21"), jeLine("1", 10_000, "Credit", "13", "21")] },
      "JournalEntry",
      lookups
    );
    expect(closing.map((l) => l.amount)).toEqual([10_000, -10_000]);
    expect(total([...bill, ...closing])).toBe(10_000);
  });

  it("counts an ordinary cost of goods sold or expense entry exactly as before", () => {
    const lines = expenseLines(
      {
        Id: "78",
        TxnDate: "2026-09-01",
        Line: [
          jeLine("0", 1_500, "Debit", "80", "21"),
          jeLine("1", 1_500, "Credit", "35"),
          // Untagged expense lines still come through, for the overhead tally.
          jeLine("2", 4_000, "Debit", "60"),
          jeLine("3", 4_000, "Credit", "35"),
        ],
      },
      "JournalEntry",
      lookups
    );
    expect(lines.map((l) => [l.lineId, l.amount, l.customerQboId])).toEqual([["0", 1_500, "21"], ["2", 4_000, null]]);
  });

  it("never counts retainage moved to a receivable, even with the customer named", () => {
    const retainage = expenseLines(
      { Id: "79", TxnDate: "2026-09-01", Line: [jeLine("0", 5_000, "Debit", "14", "21"), jeLine("1", 5_000, "Credit", "11", "21")] },
      "JournalEntry",
      lookups
    );
    expect(retainage).toEqual([]);
    // Named "retention" under a generic detail type, and on a bill too.
    expect(expenseLines({ Id: "80", TxnDate: "2026-09-01", Line: [jeLine("0", 900, "Debit", "16", "21")] }, "JournalEntry", lookups)).toEqual([]);
    expect(expenseLines({ Id: "81", TxnDate: "2026-09-01", Line: [acctLine("1", 900, "14", "21")] }, "Bill", lookups)).toEqual([]);
  });

  it("leaves out asset lines that name no job, rather than calling them overhead", () => {
    const lines = expenseLines(
      { Id: "82", TxnDate: "2026-09-01", Line: [jeLine("0", 3_000, "Debit", "80"), jeLine("1", 3_000, "Credit", "13")] },
      "JournalEntry",
      lookups
    );
    expect(lines.map((l) => l.lineId)).toEqual(["0"]);
  });

  describe("asset accounts on journal entries: only work in progress counts", () => {
    const l = emptyLookups();
    for (const [id, a] of lookups.accounts) l.accounts.set(id, a);
    l.accounts.set("19", { name: "Costs in excess of billings", fullName: "Costs in excess of billings", type: "Other Current Asset", subType: "OtherCurrentAssets" });
    l.accounts.set("20", { name: "Inventory Asset", fullName: "Inventory Asset", type: "Other Current Asset", subType: "Inventory" });
    l.accounts.set("21", { name: "Stock on hand", fullName: "Stock on hand", type: "Other Current Asset", subType: "Inventory" });
    l.accounts.set("22", { name: "Prepaid insurance", fullName: "Prepaid insurance", type: "Other Current Asset", subType: "OtherCurrentAssets" });
    l.accounts.set("23", { name: "Work-in-progress", fullName: "Work-in-progress", type: "Other Current Asset", subType: "OtherCurrentAssets" });
    l.accounts.set("24", { name: "WIP", fullName: "WIP", type: "Other Current Asset", subType: "OtherCurrentAssets" });
    l.accounts.set("25", { name: "WIP inventory", fullName: "WIP inventory", type: "Other Current Asset", subType: "OtherCurrentAssets" });

    it("adds no cost for a year-end costs in excess of billings entry", () => {
      // Debit the asset $20,000 and credit income $20,000, both naming Smith.
      const entry = { Id: "90", TxnDate: "2026-12-31", Line: [jeLine("0", 20_000, "Debit", "19", "21"), jeLine("1", 20_000, "Credit", "40", "21")] };
      expect(expenseLines(entry, "JournalEntry", l)).toEqual([]);
    });

    it("keeps inventory used on a job as one cost, not zero", () => {
      // Debit Job Materials $5,000, credit Inventory Asset, both naming the job.
      const relief = { Id: "91", TxnDate: "2026-09-01", Line: [jeLine("0", 5_000, "Debit", "80", "21"), jeLine("1", 5_000, "Credit", "20", "21")] };
      const lines = expenseLines(relief, "JournalEntry", l);
      expect(lines.map((x) => [x.lineId, x.amount])).toEqual([["0", 5_000]]);
      expect(total(lines)).toBe(5_000);
      // An inventory account under any name, and a prepaid expense, are left out too.
      expect(expenseLines({ Id: "92", TxnDate: "2026-09-01", Line: [jeLine("0", 700, "Credit", "21", "21")] }, "JournalEntry", l)).toEqual([]);
      expect(expenseLines({ Id: "93", TxnDate: "2026-09-01", Line: [jeLine("0", 400, "Credit", "22", "21")] }, "JournalEntry", l)).toEqual([]);
      expect(expenseLines({ Id: "94", TxnDate: "2026-09-01", Line: [jeLine("0", 400, "Credit", "25", "21")] }, "JournalEntry", l)).toEqual([]);
    });

    it("still nets a Construction in Progress closing entry to one cost, under any usual name", () => {
      for (const wip of ["13", "23", "24"]) {
        const bill = expenseLines({ Id: "501", TxnDate: "2026-06-01", Line: [acctLine("1", 10_000, wip, "21")] }, "Bill", l);
        const closing = expenseLines(
          { Id: "77", TxnDate: "2026-09-01", Line: [jeLine("0", 10_000, "Debit", "80", "21"), jeLine("1", 10_000, "Credit", wip, "21")] },
          "JournalEntry",
          l
        );
        expect(total([...bill, ...closing])).toBe(10_000);
      }
    });

    it("leaves bills and expenses on asset accounts as they were", () => {
      // A bill posted to an asset account and tagged to the job is still cost on the job.
      for (const id of ["19", "20", "22"]) {
        expect(expenseLines({ Id: "95", TxnDate: "2026-09-01", Line: [acctLine("1", 600, id, "21")] }, "Bill", l).map((x) => x.amount)).toEqual([600]);
      }
    });
  });

  it("sorts accounts into cost, asset, unknown and never cost", () => {
    expect(costAccountKind("80", lookups)).toBe("cost");
    expect(costAccountKind("60", lookups)).toBe("cost");
    expect(costAccountKind("13", lookups)).toBe("asset");
    expect(costAccountKind("999", lookups)).toBe("unknown");
    expect(costAccountKind(null, lookups)).toBe("unknown");
    for (const id of ["14", "16", "17", "11", "35", "40", "48"]) expect(costAccountKind(id, lookups)).toBeNull();
  });
});

describe("income lines on checks, bills and vendor credits (C12)", () => {
  const refundCheck = { Id: "145", TxnDate: "2026-09-10", PaymentType: "Check", Line: [acctLine("1", 2_000, "45", "21"), acctLine("2", 300, "80", "21")] };

  it("turns a refund check to a customer into negative revenue, not nothing", () => {
    expect(expenseLines(refundCheck, "Purchase", lookups).map((l) => [l.lineId, l.amount])).toEqual([["2", 300]]);
    expect(expenseRevenueLines(refundCheck, "Purchase", lookups)).toEqual([
      { lineId: "1", customerQboId: "21", classQboId: null, amount: -2_000, txnDate: new Date("2026-09-10T00:00:00Z") },
    ]);
  });

  it("signs by direction: bills pay out, card credits and vendor credits come back", () => {
    const line = [acctLine("1", 500, "45", "21")];
    expect(expenseRevenueLines({ Id: "1", TxnDate: "2026-09-10", Line: line }, "Bill", lookups)[0].amount).toBe(-500);
    expect(expenseRevenueLines({ Id: "2", TxnDate: "2026-09-10", Credit: true, Line: line }, "Purchase", lookups)[0].amount).toBe(500);
    expect(expenseRevenueLines({ Id: "3", TxnDate: "2026-09-10", Line: line }, "VendorCredit", lookups)[0].amount).toBe(500);
  });

  it("needs a job on the line, and leaves Other Income alone", () => {
    const txn = { Id: "4", TxnDate: "2026-09-10", Line: [acctLine("1", 500, "45"), acctLine("2", 80, "48", "21"), acctLine("3", 200, "45", undefined, "7")] };
    expect(expenseRevenueLines(txn, "Purchase", lookups)).toEqual([]);
    // Jobs by class: the class is the job, with or without a customer.
    expect(expenseRevenueLines(txn, "Purchase", lookups, true).map((l) => [l.lineId, l.classQboId, l.amount])).toEqual([["3", "7", -200]]);
  });
});

describe("discounts on a sale split by class (C15a)", () => {
  const invoice = (discount: Record<string, unknown>) => ({
    Id: "300",
    TxnDate: "2026-09-01",
    TotalAmt: 1_900,
    Balance: 950,
    Line: [
      { Amount: 1_000, SalesItemLineDetail: { ClassRef: { value: "2" } } },
      { Amount: 1_000, SalesItemLineDetail: { ClassRef: { value: "4" } } },
      { Amount: 2_000, DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} },
      { Amount: 100, DetailType: "DiscountLineDetail", DiscountLineDetail: { PercentBased: false, ...discount } },
    ],
  });

  it("takes a discount with its own class off that class only", () => {
    expect(revenueByClass(invoice({ ClassRef: { value: "2" } }), "Invoice")).toEqual([
      { classQboId: "2", amount: 900, tax: 0, openBalance: 450, docNumber: null, dueDate: null },
      { classQboId: "4", amount: 1_000, tax: 0, openBalance: 500, docNumber: null, dueDate: null },
    ]);
  });

  it("still spreads a discount with no class of its own", () => {
    expect(revenueByClass(invoice({}), "Invoice").map((r) => [r.classQboId, r.amount])).toEqual([["2", 950], ["4", 950]]);
  });
});

describe("supplier refunds deposited to a cost account (C15c)", () => {
  const deposit = {
    Id: "900",
    TxnDate: "2026-09-12",
    Line: [
      // The supplier's refund on the Smith job's materials, received from the job.
      { Id: "1", Amount: 300, DepositLineDetail: { Entity: { value: "21", name: "Smith", type: "CUSTOMER" }, AccountRef: { value: "80", name: "Job Materials" } } },
      // Received from the supplier, with the job's class.
      { Id: "2", Amount: 120, DepositLineDetail: { Entity: { value: "9", type: "VENDOR" }, AccountRef: { value: "80" }, ClassRef: { value: "7" } } },
      // Income, a payment, a transfer from the bank, and an account we can't see: not cost.
      { Id: "3", Amount: 8_000, DepositLineDetail: { Entity: { value: "21", type: "CUSTOMER" }, AccountRef: { value: "40" } } },
      { Id: "4", Amount: 5_000, LinkedTxn: [{ TxnId: "77", TxnType: "Payment" }], DepositLineDetail: { AccountRef: { value: "80" } } },
      { Id: "5", Amount: 50, DepositLineDetail: { AccountRef: { value: "35" } } },
      { Id: "6", Amount: 70, DepositLineDetail: { Entity: { value: "21", type: "CUSTOMER" }, AccountRef: { value: "999" } } },
    ],
  };

  it("reduces the job's cost", () => {
    const lines = depositCostLines(deposit, lookups);
    expect(lines.map((l) => [l.lineId, l.amount, l.customerQboId, l.classQboId, l.category])).toEqual([
      ["1", -300, "21", null, "materials"],
      ["2", -120, null, "7", "materials"],
    ]);
  });

  it("leaves deposit income as it was", () => {
    expect(depositRevenueLines(deposit, lookups).map((l) => l.lineId)).toEqual(["3"]);
  });
});

describe("time entries with hours and start, end and break times (C15d)", () => {
  const clocked = { StartTime: "2026-09-01T07:00:00-05:00", EndTime: "2026-09-01T16:00:00-05:00", BreakHours: 1, BreakMinutes: 0 };

  it("takes the break off start to end, whether Hours has it off or not", () => {
    expect(timeActivityHours({ ...clocked, Hours: 9, Minutes: 0 })).toBeCloseTo(8, 5);
    expect(timeActivityHours({ ...clocked, Hours: 8, Minutes: 0 })).toBeCloseTo(8, 5);
    expect(timeActivityHours(clocked)).toBeCloseTo(8, 5);
  });

  it("never takes a break off Hours alone", () => {
    expect(timeActivityHours({ Hours: 8, Minutes: 0, BreakHours: 1 })).toBe(8);
  });

  it("falls back to Hours when start and end make no sense", () => {
    expect(timeActivityHours({ ...clocked, BreakHours: 10, Hours: 7 })).toBe(7);
    expect(timeActivityHours({ StartTime: "2026-09-01T16:00:00Z", EndTime: "2026-09-01T07:00:00Z", Hours: 6, Minutes: 30 })).toBe(6.5);
  });
});

describe("a parent that gains its first or second job (C14)", () => {
  const existing = [
    { qboId: "101", parentQboId: "10" }, // Smith's only job
    { qboId: "201", parentQboId: "20" }, // Lee has two
    { qboId: "202", parentQboId: "20" },
    { qboId: "class:5", parentQboId: "class:1" },
  ];

  it("names the parents whose only job just stopped being their only job", () => {
    expect(parentsNeedingFullSync(existing, [{ qboId: "102", parentQboId: "10" }])).toEqual(["10"]);
    expect(parentsNeedingFullSync(existing, [{ qboId: "class:6", parentQboId: "class:1" }])).toEqual(["class:1"]);
  });

  it("names a parent getting its first job, so costs tagged to it before the project existed move onto it", () => {
    expect(parentsNeedingFullSync(existing, [{ qboId: "301", parentQboId: "30" }])).toEqual(["30"]);
    expect(parentsNeedingFullSync(existing, [{ qboId: "class:9", parentQboId: "class:8" }])).toEqual(["class:8"]);
  });

  it("ignores a parent with two already, a new parent getting two at once, a job with no parent and a job re-listed unchanged", () => {
    expect(
      parentsNeedingFullSync(existing, [
        { qboId: "203", parentQboId: "20" },
        { qboId: "401", parentQboId: "40" },
        { qboId: "402", parentQboId: "40" },
        { qboId: "501", parentQboId: null },
        { qboId: "101", parentQboId: "10" },
      ])
    ).toEqual([]);
  });

  it("skips a parent customer created since the last sync: its costs are all in this sync's changes", () => {
    const since = new Date("2026-09-27T02:00:00Z");
    const customers = [
      { Id: "30", MetaData: { CreateTime: "2026-09-27T15:04:05-07:00" } },
      { Id: "31", MetaData: { CreateTime: "2025-03-01T09:00:00-07:00" } },
      { Id: "32" },
    ];
    const created = customersCreatedSince(customers, since);
    expect([...created]).toEqual(["30"]);
    const added = [
      { qboId: "301", parentQboId: "30" },
      { qboId: "311", parentQboId: "31" },
      { qboId: "321", parentQboId: "32" },
    ];
    // An older customer, or one whose creation time can't be read, still asks for the full sync.
    expect(parentsNeedingFullSync(existing, added, created)).toEqual(["31", "32"]);
    // No last sync to compare with: nothing counts as new.
    expect(customersCreatedSince(customers, null).size).toBe(0);
  });
});
