import { describe, expect, it } from "vitest";
import {
  buildJobIndex,
  categorizeByName,
  categorizeLine,
  cleanCustomerName,
  contractValueFromEstimates,
  costEntryId,
  depositRevenueLines,
  emptyLookups,
  classJobKey,
  estimateFromTxn,
  expenseLines,
  isUnitPriced,
  journalRevenueLines,
  resolveJob,
  revenueByClass,
  revenueFromTxn,
  selectJobClasses,
  selectJobCustomers,
  timeActivityCost,
  timeActivityHours,
} from "../qboNormalize";

// Payload shapes below are trimmed copies of what the QuickBooks Online v3
// API returns for each entity.

describe("labor from time entries", () => {
  it("costs time at the entry's cost rate, not the billing rate", () => {
    const r = timeActivityCost({
      Id: "9",
      Hours: 8,
      Minutes: 0,
      HourlyRate: 85, // what the customer is billed
      CostRate: 30, // what the employee is paid
      EmployeeRef: { value: "55", name: "Emily" },
      CustomerRef: { value: "21" },
      BillableStatus: "Billable",
    });
    expect(r.kind).toBe("cost");
    if (r.kind === "cost") expect(r.amount).toBe(240);
  });

  it("costs non-billable crew time, which has no billing rate at all", () => {
    const r = timeActivityCost({
      Hours: 4,
      Minutes: 30,
      CostRate: 28,
      EmployeeRef: { value: "55" },
      CustomerRef: { value: "21" },
      BillableStatus: "NotBillable",
    });
    expect(r.kind).toBe("cost");
    if (r.kind === "cost") expect(r.amount).toBe(126);
  });

  it("skips time with no cost rate instead of guessing one", () => {
    const r = timeActivityCost({ Hours: 8, HourlyRate: 85, EmployeeRef: { value: "1" }, CustomerRef: { value: "21" } });
    expect(r).toEqual({ kind: "skip", reason: "no_pay_rate" });
  });

  it("skips a vendor's time, which is already paid through bills", () => {
    const r = timeActivityCost({ Hours: 8, CostRate: 50, VendorRef: { value: "7" }, CustomerRef: { value: "21" } });
    expect(r).toEqual({ kind: "skip", reason: "vendor_time" });
  });

  it("reads start and end times, less the break", () => {
    const hours = timeActivityHours({
      StartTime: "2026-09-01T07:00:00-05:00",
      EndTime: "2026-09-01T15:30:00-05:00",
      BreakHours: 0,
      BreakMinutes: 30,
    });
    expect(hours).toBeCloseTo(8, 5);
  });
});

describe("expense lines", () => {
  const lookups = emptyLookups();
  lookups.accounts.set("80", { name: "Job Materials", fullName: "Job Expenses:Job Materials", type: "Cost of Goods Sold", subType: "SuppliesMaterialsCogs" });
  lookups.accounts.set("60", { name: "Rent", fullName: "Rent or Lease", type: "Expense", subType: "RentOrLeaseOfBuildings" });
  lookups.accounts.set("61", { name: "Cost of Goods Sold", fullName: "Cost of Goods Sold", type: "Cost of Goods Sold", subType: "SuppliesMaterialsCogs" });
  lookups.items.set("5", { name: "Lumber", expenseAccountId: "61" });

  const purchase = (extra: Record<string, unknown>, lines: any[]) => ({ Id: "145", TxnDate: "2026-09-10", ...extra, Line: lines });
  const acctLine = (id: string, amount: number, accountId: string, accountName: string, customer?: string) => ({
    Id: id,
    Amount: amount,
    DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: { AccountRef: { value: accountId, name: accountName }, ...(customer ? { CustomerRef: { value: customer, name: "Harborview" } } : {}) },
  });

  it("treats a credit card refund as a reduction in cost", () => {
    const lines = expenseLines(purchase({ PaymentType: "CreditCard", Credit: true }, [acctLine("1", 1200, "80", "Job Materials", "21")]), "Purchase", lookups);
    expect(lines).toHaveLength(1);
    expect(lines[0].amount).toBe(-1200);
    expect(lines[0].category).toBe("materials");
  });

  it("treats a vendor credit as a reduction in cost", () => {
    const lines = expenseLines({ Id: "3", TxnDate: "2026-09-10", Line: [acctLine("1", 400, "80", "Job Materials", "21")] }, "VendorCredit", lookups);
    expect(lines[0].amount).toBe(-400);
  });

  it("drops every line of a voided check (QuickBooks zeroes them)", () => {
    const lines = expenseLines(purchase({ PrivateNote: "Voided" }, [acctLine("1", 0, "80", "Job Materials", "21")]), "Purchase", lookups);
    expect(lines).toHaveLength(0);
  });

  it("uses the item's expense account for items bought for a job", () => {
    const lines = expenseLines(
      purchase({}, [
        {
          Id: "2",
          Amount: 950,
          DetailType: "ItemBasedExpenseLineDetail",
          ItemBasedExpenseLineDetail: { ItemRef: { value: "5", name: "Lumber" }, CustomerRef: { value: "21" } },
        },
      ]),
      "Purchase",
      lookups
    );
    expect(lines[0].category).toBe("materials");
    expect(lines[0].isJobCostAccount).toBe(true);
  });

  it("tells job costs apart from overhead when nothing is tagged", () => {
    const [cogs] = expenseLines(purchase({}, [acctLine("1", 300, "80", "Job Materials")]), "Purchase", lookups);
    const [rent] = expenseLines(purchase({}, [acctLine("2", 2000, "60", "Rent")]), "Purchase", lookups);
    expect(cogs.isJobCostAccount).toBe(true);
    expect(rent.isJobCostAccount).toBe(false);
    expect(rent.category).toBe("overhead");
  });

  it("reads journal entry lines tagged to a customer on cost accounts only", () => {
    const je = {
      Id: "77",
      TxnDate: "2026-09-12",
      Line: [
        { Id: "0", Amount: 1500, JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "80", name: "Job Materials" }, Entity: { Type: "Customer", EntityRef: { value: "21", name: "Harborview" } } } },
        { Id: "1", Amount: 1500, JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "99", name: "Checking" } } },
      ],
    };
    const lines = expenseLines(je, "JournalEntry", lookups);
    expect(lines).toHaveLength(1);
    expect(lines[0].customerQboId).toBe("21");
    expect(lines[0].amount).toBe(1500);
  });

  it("lets the contractor's own mapping win", () => {
    const withMapping = emptyLookups();
    withMapping.mappings.set("Job Materials", "equipment");
    const r = categorizeLine({ sourceName: "Job Materials", accountId: null, itemId: null }, withMapping);
    expect(r.category).toBe("equipment");
  });
});

describe("category names", () => {
  it("files subcontracted labor under subcontractors, not labor", () => {
    expect(categorizeByName("Subcontracted labor")).toBe("subcontractor");
    expect(categorizeByName("Contract Labor")).toBe("subcontractor");
    expect(categorizeByName("Sub-contractors")).toBe("subcontractor");
  });

  it("does not mistake subscriptions for subcontractors", () => {
    expect(categorizeByName("Software subscriptions")).toBe("overhead");
    expect(categorizeByName("Subscriptions")).toBeNull();
  });

  it("reads common construction account names", () => {
    expect(categorizeByName("Job Expenses:Job Materials")).toBe("materials");
    expect(categorizeByName("Cost of Labor")).toBe("labor");
    expect(categorizeByName("Equipment Rental")).toBe("equipment");
  });
});

describe("revenue", () => {
  it("removes sales tax from invoice revenue", () => {
    const r = revenueFromTxn({ Id: "1", TxnDate: "2026-09-01", TotalAmt: 10_700, Balance: 10_700, TxnTaxDetail: { TotalTax: 700 }, CustomerRef: { value: "21" } }, "Invoice");
    expect(r.amount).toBe(10_000);
    expect(r.tax).toBe(700);
    expect(r.status).toBe("open");
  });

  it("counts a sales receipt as revenue and a credit memo against it", () => {
    expect(revenueFromTxn({ TxnDate: "2026-09-01", TotalAmt: 500, CustomerRef: { value: "21" } }, "SalesReceipt").amount).toBe(500);
    const credit = revenueFromTxn({ TxnDate: "2026-09-01", TotalAmt: 250, CustomerRef: { value: "21" } }, "CreditMemo");
    expect(credit.amount).toBe(-250);
    expect(credit.status).toBe("credit");
  });
});

describe("contract value from estimates", () => {
  const d = (s: string) => new Date(s);
  it("adds accepted change orders to the accepted quote", () => {
    expect(
      contractValueFromEstimates([
        { amount: 60_000, status: "Accepted", txnDate: d("2026-03-01") },
        { amount: 12_600, status: "Accepted", txnDate: d("2026-05-01") },
        { amount: 9_000, status: "Pending", txnDate: d("2026-06-01") },
      ])
    ).toBe(72_600);
  });

  it("uses the latest pending quote when nothing is accepted, and never a rejected one", () => {
    expect(
      contractValueFromEstimates([
        { amount: 50_000, status: "Pending", txnDate: d("2026-03-01") },
        { amount: 54_000, status: "Pending", txnDate: d("2026-03-15") },
        { amount: 90_000, status: "Rejected", txnDate: d("2026-04-01") },
      ])
    ).toBe(54_000);
    expect(contractValueFromEstimates([{ amount: 90_000, status: "Rejected", txnDate: d("2026-04-01") }])).toBeNull();
  });
});

describe("which customers are jobs", () => {
  const customers = [
    { Id: "1", DisplayName: "Smith", Active: true },
    { Id: "2", DisplayName: "Smith Kitchen", Job: true, ParentRef: { value: "1" }, Active: true },
    { Id: "3", DisplayName: "Jones Roof (deleted)", Active: false },
    { Id: "4", DisplayName: "Lee Bath", Active: true },
  ];

  it("projects mode takes projects and sub-customers only", () => {
    const jobs = selectJobCustomers(customers, "projects");
    expect(jobs.map((j) => j.qboId)).toEqual(["2"]);
  });

  it("customers mode takes every customer without sub-customers", () => {
    const jobs = selectJobCustomers(customers, "customers", new Map([["1", "Smith"]]));
    expect(jobs.map((j) => j.qboId)).toEqual(["2", "3", "4"]);
    expect(jobs.find((j) => j.qboId === "3")?.name).toBe("Jones Roof");
    expect(jobs.find((j) => j.qboId === "3")?.active).toBe(false);
    expect(jobs.find((j) => j.qboId === "2")?.customerName).toBe("Smith");
  });

  it("keeps a customer that was already a job when it gains a project", () => {
    const jobs = selectJobCustomers(customers, "customers", undefined, new Set(["1", "4"]));
    expect(jobs.map((j) => j.qboId)).toEqual(["1", "2", "3", "4"]);
  });

  it("strips the (deleted) suffix only from inactive customers", () => {
    expect(cleanCustomerName("Kitchen (deleted)", false)).toBe("Kitchen");
    expect(cleanCustomerName("Kitchen (deleted)", true)).toBe("Kitchen (deleted)");
  });
});

describe("matching transactions to jobs", () => {
  const index = buildJobIndex([
    { id: "job-a", qboId: "2", parentQboId: "1" },
    { id: "job-b", qboId: "5", parentQboId: "4" },
    { id: "job-c", qboId: "6", parentQboId: "4" },
  ]);

  it("matches directly, then falls back to a parent's only job", () => {
    expect(resolveJob(index, "2")).toEqual({ jobId: "job-a", method: "direct" });
    expect(resolveJob(index, "1")).toEqual({ jobId: "job-a", method: "parent_customer_fallback" });
  });

  it("refuses to guess between two jobs under the same parent", () => {
    expect(resolveJob(index, "4")).toBeNull();
  });
});

describe("row ids", () => {
  it("include the connection, so two companies' 'Purchase 145' never share a row", () => {
    expect(costEntryId("connA", "Purchase", "145", "1")).not.toBe(costEntryId("connB", "Purchase", "145", "1"));
  });
});

describe("estimate lines", () => {
  const lookups = emptyLookups();
  lookups.accounts.set("80", { name: "Cost of labor", fullName: "Cost of labor", type: "Cost of Goods Sold", subType: "CostOfLaborCos" });
  lookups.items.set("1", { name: "Framing labor", expenseAccountId: null });
  lookups.items.set("2", { name: "Lumber", expenseAccountId: null });
  lookups.items.set("3", { name: "Install", expenseAccountId: "80" });
  lookups.items.set("4", { name: "Overhead and profit", expenseAccountId: null });

  const est = {
    Id: "1043",
    DocNumber: "1043",
    TxnDate: "2026-09-01",
    ExpirationDate: "2026-10-01",
    TxnStatus: "Pending",
    EmailStatus: "NeedToSend",
    CustomerRef: { value: "58", name: "Smith:Kitchen" },
    TotalAmt: 10_800,
    TxnTaxDetail: { TotalTax: 800 },
    Line: [
      { Amount: 4_000, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "1", name: "Framing labor" } } },
      {
        DetailType: "GroupLineDetail",
        GroupLineDetail: {
          Line: [
            { Amount: 4_000, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "2", name: "Lumber" } } },
            { Amount: 1_000, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "3", name: "Install" } } },
          ],
        },
      },
      { Amount: 2_000, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "4", name: "Overhead and profit" } } },
      { Amount: 11_000, DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} },
      { Amount: 1_000, DetailType: "DiscountLineDetail", DiscountLineDetail: { PercentBased: false } },
    ],
  };

  it("categorizes each product or service and spreads the discount so lines add up to the total without tax", () => {
    const { details, record } = estimateFromTxn(est, lookups);
    expect(record!.amount).toBe(10_000);
    const byName = Object.fromEntries(details.lines.map((l) => [l.n, l]));
    expect(byName["Framing labor"].c).toBe("labor");
    expect(byName["Lumber"].c).toBe("materials");
    // Named for nothing, but its expense account is labor.
    expect(byName["Install"].c).toBe("labor");
    expect(byName["Overhead and profit"].c).toBe("overhead");
    // 11,000 of lines scaled to 10,000.
    expect(byName["Framing labor"].a).toBeCloseTo(4_000 * (10_000 / 11_000), 2);
    expect(details.lines.reduce((s, l) => s + l.a, 0)).toBeCloseTo(10_000, 1);
    expect(details).toMatchObject({ docNumber: "1043", customerName: "Smith:Kitchen", emailStatus: "NeedToSend" });
    expect(details.expirationDate?.toISOString().slice(0, 10)).toBe("2026-10-01");
  });

  it("stores no lines without lookups, and none for an empty estimate", () => {
    expect(estimateFromTxn(est).details.lines).toEqual([]);
    expect(estimateFromTxn({ ...est, Line: [] }, lookups).details.lines).toEqual([]);
  });
});

describe("revenue recorded without an invoice", () => {
  const lookups = emptyLookups();
  lookups.accounts.set("40", { name: "Construction Income", fullName: "Construction Income", type: "Income", subType: "SalesOfProductIncome" });
  lookups.accounts.set("25", { name: "Customer Deposits", fullName: "Customer Deposits", type: "Other Current Liability", subType: "OtherCurrentLiabilities" });
  lookups.accounts.set("80", { name: "Job Materials", fullName: "Job Materials", type: "Cost of Goods Sold", subType: "SuppliesMaterialsCogs" });

  it("counts a check deposited to income with the customer named, and nothing else", () => {
    const deposit = {
      Id: "900",
      TxnDate: "2026-09-12",
      Line: [
        // The $8,000 check from Smith:Kitchen, straight to income: revenue.
        { Id: "1", Amount: 8000, DepositLineDetail: { Entity: { value: "58", name: "Smith:Kitchen", type: "CUSTOMER" }, AccountRef: { value: "40" } } },
        // A payment on an invoice: already counted on the invoice.
        { Id: "2", Amount: 5000, LinkedTxn: [{ TxnId: "77", TxnType: "Payment" }], DepositLineDetail: { Entity: { value: "58", type: "CUSTOMER" } } },
        // A deposit held as a liability: not income yet.
        { Id: "3", Amount: 2000, DepositLineDetail: { Entity: { value: "58", type: "CUSTOMER" }, AccountRef: { value: "25" } } },
        // A supplier refund: not a customer.
        { Id: "4", Amount: 300, DepositLineDetail: { Entity: { value: "9", type: "VENDOR" }, AccountRef: { value: "80" } } },
      ],
    };
    const lines = depositRevenueLines(deposit, lookups);
    expect(lines).toEqual([{ lineId: "1", customerQboId: "58", classQboId: null, amount: 8000, txnDate: new Date("2026-09-12T00:00:00Z") }]);
  });

  it("reads journal entry income lines by customer, credit adds and debit takes away", () => {
    const je = {
      Id: "610",
      TxnDate: "2026-09-01",
      Line: [
        { Id: "0", Amount: 1500, JournalEntryLineDetail: { PostingType: "Credit", Entity: { Type: "Customer", EntityRef: { value: "58" } }, AccountRef: { value: "40" } } },
        { Id: "1", Amount: 200, JournalEntryLineDetail: { PostingType: "Debit", Entity: { Type: "Customer", EntityRef: { value: "58" } }, AccountRef: { value: "40" } } },
        // A cost line on the same entry is left to expenseLines.
        { Id: "2", Amount: 700, JournalEntryLineDetail: { PostingType: "Debit", Entity: { Type: "Customer", EntityRef: { value: "58" } }, AccountRef: { value: "80" } } },
      ],
    };
    expect(journalRevenueLines(je, lookups).map((l) => [l.lineId, l.amount])).toEqual([["0", 1500], ["1", -200]]);
  });
});

describe("lines posted to balance-sheet accounts", () => {
  const lookups = emptyLookups();
  lookups.accounts.set("80", { name: "Job Materials", fullName: "Job Materials", type: "Cost of Goods Sold", subType: null });
  lookups.accounts.set("15", { name: "Trucks", fullName: "Trucks", type: "Fixed Asset", subType: "Vehicles" });
  lookups.accounts.set("27", { name: "Truck loan", fullName: "Truck loan", type: "Long Term Liability", subType: "NotesPayable" });
  const line = (id: string, amount: number, accountId: string) => ({
    Id: id,
    Amount: amount,
    DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: { AccountRef: { value: accountId }, CustomerRef: { value: "21" } },
  });

  it("aren't job cost, even with the job on them", () => {
    const lines = expenseLines(
      { Id: "7", TxnDate: "2026-09-10", Line: [line("1", 900, "80"), line("2", 42_000, "15"), line("3", 650, "27")] },
      "Purchase",
      lookups
    );
    expect(lines.map((l) => [l.lineId, l.amount])).toEqual([["1", 900]]);
  });

  it("still counts a Construction in Progress asset account tagged to the job", () => {
    const l2 = emptyLookups();
    l2.accounts.set("13", { name: "Construction in progress", fullName: "Construction in progress", type: "Other Current Asset", subType: null });
    expect(expenseLines({ Id: "9", TxnDate: "2026-09-10", Line: [line("1", 800, "13")] }, "Bill", l2)).toHaveLength(1);
  });

  it("still counts a line whose account can't be looked up", () => {
    expect(expenseLines({ Id: "8", TxnDate: "2026-09-10", Line: [line("1", 300, "99")] }, "Bill", lookups)).toHaveLength(1);
  });
});

describe("classes as jobs", () => {
  it("makes leaf classes the jobs, grouped under their parent class", () => {
    const jobs = selectJobClasses([
      { Id: "1", Name: "Residential" },
      { Id: "2", Name: "Smith kitchen", ParentRef: { value: "1" } },
      { Id: "3", Name: "Lee bath", ParentRef: { value: "1" }, Active: false },
      { Id: "4", Name: "Warehouse fit-out" },
    ]);
    expect(jobs.map((j) => [j.qboId, j.parentQboId, j.customerName, j.active])).toEqual([
      ["class:2", "class:1", "Residential", true],
      ["class:3", "class:1", "Residential", false],
      ["class:4", null, null, true],
    ]);
    expect(classJobKey("4")).toBe("class:4");
  });

  it("reads the class on each cost line, then the transaction's", () => {
    const lookups = emptyLookups();
    const lines = expenseLines(
      {
        Id: "5",
        TxnDate: "2026-09-10",
        ClassRef: { value: "9" },
        Line: [
          { Id: "1", Amount: 100, AccountBasedExpenseLineDetail: { AccountRef: { value: "80" }, ClassRef: { value: "2" } } },
          { Id: "2", Amount: 50, AccountBasedExpenseLineDetail: { AccountRef: { value: "80" } } },
        ],
      },
      "Bill",
      lookups
    );
    expect(lines.map((l) => l.classQboId)).toEqual(["2", "9"]);
  });

  it("matches time entries by class, not customer, in class mode", () => {
    const ta = { Hours: 8, CostRate: 30, EmployeeRef: { value: "5" }, CustomerRef: { value: "21" } };
    expect(timeActivityCost(ta, "classes")).toEqual({ kind: "skip", reason: "no_customer" });
    const r = timeActivityCost({ ...ta, ClassRef: { value: "2" } }, "classes");
    expect(r.kind === "cost" && r.hours).toBe(8);
  });

  it("splits a sale across its classes by line value, tax and open balance too", () => {
    const invoice = {
      Id: "300",
      DocNumber: "1042",
      TxnDate: "2026-09-01",
      DueDate: "2026-10-01",
      TotalAmt: 10_800,
      Balance: 5_400,
      TxnTaxDetail: { TotalTax: 800 },
      Line: [
        { Amount: 7_500, SalesItemLineDetail: { ClassRef: { value: "2" } } },
        { Amount: 2_500, SalesItemLineDetail: { ClassRef: { value: "4" } } },
        { Amount: 10_000, DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} },
      ],
    };
    expect(revenueByClass(invoice, "Invoice")).toEqual([
      // Both classes' shares are the same invoice, so both carry its number and due date.
      { classQboId: "2", amount: 7_500, tax: 600, openBalance: 4_050, docNumber: "1042", dueDate: new Date("2026-10-01T00:00:00Z") },
      { classQboId: "4", amount: 2_500, tax: 200, openBalance: 1_350, docNumber: "1042", dueDate: new Date("2026-10-01T00:00:00Z") },
    ]);
  });

  it("puts a sale with no line classes on the transaction's class", () => {
    const receipt = { TxnDate: "2026-09-01", TotalAmt: 500, ClassRef: { value: "4" }, Line: [{ Amount: 500, SalesItemLineDetail: {} }] };
    expect(revenueByClass(receipt, "SalesReceipt")).toEqual([{ classQboId: "4", amount: 500, tax: 0, openBalance: null, docNumber: null, dueDate: null }]);
  });

  it("gives an estimate its own class, or the class with most of its value", () => {
    const base = { TxnDate: "2026-09-01", TotalAmt: 1_000, CustomerRef: { value: "58" } };
    expect(estimateFromTxn({ ...base, ClassRef: { value: "7" } }).classQboId).toBe("7");
    const split = {
      ...base,
      Line: [
        { Amount: 300, SalesItemLineDetail: { ClassRef: { value: "2" } } },
        { Amount: 700, SalesItemLineDetail: { ClassRef: { value: "4" } } },
      ],
    };
    expect(estimateFromTxn(split).classQboId).toBe("4");
    expect(estimateFromTxn(base).classQboId).toBeNull();
  });
});

describe("what's still owed on an invoice", () => {
  it("keeps QuickBooks' open balance, tax included, and none once paid", () => {
    const open = revenueFromTxn({ TxnDate: "2026-09-01", TotalAmt: 10_700, Balance: 3_210, TxnTaxDetail: { TotalTax: 700 } }, "Invoice");
    expect(open.openBalance).toBe(3_210);
    expect(revenueFromTxn({ TxnDate: "2026-09-01", TotalAmt: 500, Balance: 0 }, "Invoice").openBalance).toBeNull();
    expect(revenueFromTxn({ TxnDate: "2026-09-01", TotalAmt: 500 }, "SalesReceipt").openBalance).toBeNull();
  });

  it("keeps the invoice number and due date for Money Owed", () => {
    const inv = revenueFromTxn({ TxnDate: "2026-09-01", DocNumber: "1042", DueDate: "2026-10-01", TotalAmt: 500, Balance: 500 }, "Invoice");
    expect(inv.docNumber).toBe("1042");
    expect(inv.dueDate).toEqual(new Date("2026-10-01T00:00:00Z"));
    // No number or due date set in QuickBooks: null, never a made-up one.
    const bare = revenueFromTxn({ TxnDate: "2026-09-01", TotalAmt: 500, Balance: 500 }, "Invoice");
    expect(bare.docNumber).toBeNull();
    expect(bare.dueDate).toBeNull();
    // Only invoices have a due date.
    const receipt = revenueFromTxn({ TxnDate: "2026-09-01", DocNumber: "88", DueDate: "2026-10-01", TotalAmt: 500 }, "SalesReceipt");
    expect(receipt.docNumber).toBe("88");
    expect(receipt.dueDate).toBeNull();
  });
});

describe("estimate quantities", () => {
  it("keeps each line's quantity and its item's purchase cost", () => {
    const lookups = emptyLookups();
    lookups.items.set("1", { name: "Framing labor", expenseAccountId: null });
    lookups.items.set("2", { name: "Drywall sheet", expenseAccountId: null, purchaseCost: 14 });
    const est = {
      TxnDate: "2026-09-01",
      TotalAmt: 5_000,
      CustomerRef: { value: "58" },
      Line: [
        { Amount: 3_200, SalesItemLineDetail: { ItemRef: { value: "1" }, Qty: 40 } },
        { Amount: 1_000, SalesItemLineDetail: { ItemRef: { value: "2" }, Qty: 30 } },
        { Amount: 800, SalesItemLineDetail: { ItemRef: { value: "2" }, Qty: 20 } },
      ],
    };
    const lines = estimateFromTxn(est, lookups).details.lines;
    expect(lines.map((l) => [l.n, l.q, l.u, l.qa])).toEqual([
      ["Framing labor", 40, null, 3_200],
      ["Drywall sheet", 50, 14, 1_800],
    ]);
  });

  it("judges each line before merging, so a lump sum can't pass as more hours", () => {
    const lookups = emptyLookups();
    lookups.items.set("1", { name: "Labor", expenseAccountId: null });
    const est = {
      TxnDate: "2026-09-01",
      TotalAmt: 7_200,
      CustomerRef: { value: "58" },
      Line: [
        { Amount: 3_200, SalesItemLineDetail: { ItemRef: { value: "1" }, Qty: 40 } },
        { Amount: 4_000, SalesItemLineDetail: { ItemRef: { value: "1" }, Qty: 1 } },
      ],
    };
    const [line] = estimateFromTxn(est, lookups).details.lines;
    expect(line).toMatchObject({ n: "Labor", a: 7_200, q: 40, qa: 3_200 });
  });

  it("counts item units only when priced within 3 times the item cost, labor within 10", () => {
    // Shingles at $110 a square: $300 a square is supply only, $450 is sold installed.
    expect(isUnitPriced("materials", 300, 110)).toBe(true);
    expect(isUnitPriced("materials", 330, 110)).toBe(true);
    expect(isUnitPriced("materials", 450, 110)).toBe(false);
    expect(isUnitPriced("subcontractor", 400, 100)).toBe(false);
    // Priced far below cost is a different unit, as before.
    expect(isUnitPriced("materials", 10, 110)).toBe(false);
    // Labor with a cost keeps the wider range: $30 an hour billed at $95 is still hours.
    expect(isUnitPriced("labor", 95, 30)).toBe(true);
    expect(isUnitPriced("labor", 4_000, 35)).toBe(false);
    // Labor with no cost: an hourly rate, unchanged.
    expect(isUnitPriced("labor", 90, null)).toBe(true);
    expect(isUnitPriced("labor", 4_000, null)).toBe(false);
    expect(isUnitPriced("materials", 90, null)).toBe(false);
  });

  it("leaves items sold installed to the past-jobs method", () => {
    const lookups = emptyLookups();
    lookups.items.set("3", { name: "Shingles", expenseAccountId: null, purchaseCost: 110 });
    const est = {
      TxnDate: "2026-09-01",
      TotalAmt: 13_500,
      CustomerRef: { value: "58" },
      Line: [{ Amount: 13_500, SalesItemLineDetail: { ItemRef: { value: "3" }, Qty: 30 } }],
    };
    const [line] = estimateFromTxn(est, lookups).details.lines;
    expect(line).toMatchObject({ n: "Shingles", a: 13_500, u: 110, q: null, qa: null });
  });
});

describe("class-mode income without an invoice", () => {
  const lookups = emptyLookups();
  lookups.accounts.set("40", { name: "Construction Income", fullName: "Construction Income", type: "Income", subType: null });
  it("counts income with the job's class even when no customer is named", () => {
    const deposit = {
      Id: "901",
      TxnDate: "2026-09-12",
      Line: [
        { Id: "1", Amount: 900, DepositLineDetail: { AccountRef: { value: "40" }, ClassRef: { value: "3" } } },
        { Id: "2", Amount: 50, DepositLineDetail: { AccountRef: { value: "40" } } },
        { Id: "3", Amount: 70, DepositLineDetail: { Entity: { value: "9", type: "VENDOR" }, AccountRef: { value: "40" }, ClassRef: { value: "3" } } },
      ],
    };
    expect(depositRevenueLines(deposit, lookups).map((l) => l.lineId)).toEqual([]);
    expect(depositRevenueLines(deposit, lookups, true).map((l) => [l.lineId, l.classQboId, l.customerQboId])).toEqual([["1", "3", null]]);
    const je = {
      Id: "611",
      TxnDate: "2026-09-01",
      Line: [{ Id: "0", Amount: 400, JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "40" }, ClassRef: { value: "3" } } }],
    };
    expect(journalRevenueLines(je, lookups)).toEqual([]);
    expect(journalRevenueLines(je, lookups, true).map((l) => [l.classQboId, l.amount])).toEqual([["3", 400]]);
  });
});

describe("class jobs that gain sub-classes", () => {
  it("stay jobs, as customers do", () => {
    const classes = [
      { Id: "1", Name: "Smith remodel" },
      { Id: "2", Name: "Kitchen", ParentRef: { value: "1" } },
    ];
    expect(selectJobClasses(classes).map((j) => j.qboId)).toEqual(["class:2"]);
    expect(selectJobClasses(classes, new Set(["class:1"])).map((j) => j.qboId)).toEqual(["class:1", "class:2"]);
  });
});
