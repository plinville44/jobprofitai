import { describe, expect, it } from "vitest";
import {
  buildJobIndex,
  categorizeByName,
  categorizeLine,
  cleanCustomerName,
  contractValueFromEstimates,
  costEntryId,
  emptyLookups,
  expenseLines,
  resolveJob,
  revenueFromTxn,
  selectJobCustomers,
  timeActivityCost,
  timeActivityHours,
} from "../qboNormalize";

// Payload shapes below are trimmed copies of what the QuickBooks Online v3
// API returns for each entity.

describe("labor from time entries", () => {
  it("costs time at the employee's pay rate, not the billing rate", () => {
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

  it("skips time with no pay rate instead of guessing one", () => {
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
