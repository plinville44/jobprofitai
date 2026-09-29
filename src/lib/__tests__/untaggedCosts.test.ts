import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakePrisma, FakeModel, type FakePrisma } from "./support/fakePrisma";

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));

import { emptyLookups, expenseLines, qboDate } from "../qboNormalize";
import {
  isUntaggedJobCost,
  qboTxnUrl,
  sortUntagged,
  untaggedCostRow,
  untaggedCsvRows,
  untaggedKind,
  untaggedKindLabel,
  UntaggedCostCollector,
  type UntaggedCostRow,
} from "../untaggedCosts";
import { connectionRealmId, loadUntaggedCosts, replaceUntaggedCosts, replaceUntaggedCostsForTxns } from "../untaggedCostStore";

// Payload shapes below are trimmed copies of what the QuickBooks Online v3
// API returns for each entity.

const lookups = emptyLookups();
lookups.accounts.set("80", { name: "Job Materials", fullName: "Job Expenses:Job Materials", type: "Cost of Goods Sold", subType: "SuppliesMaterialsCogs" });
lookups.accounts.set("60", { name: "Rent", fullName: "Rent or Lease", type: "Expense", subType: "RentOrLeaseOfBuildings" });
lookups.accounts.set("61", { name: "Cost of Goods Sold", fullName: "Cost of Goods Sold", type: "Cost of Goods Sold", subType: "SuppliesMaterialsCogs" });
lookups.items.set("5", { name: "Lumber", expenseAccountId: "61", purchaseCost: null });

const acctLine = (id: string, amount: number, accountId: string, accountName: string, customer?: string, description?: string) => ({
  Id: id,
  Amount: amount,
  DetailType: "AccountBasedExpenseLineDetail",
  ...(description ? { Description: description } : {}),
  AccountBasedExpenseLineDetail: {
    AccountRef: { value: accountId, name: accountName },
    ...(customer ? { CustomerRef: { value: customer, name: "Harborview" } } : {}),
  },
});

/**
 * What processExpenseTxn in quickbooksSync.ts does with each line: no job on
 * the line (customer mode) and inside the window, then job cost goes on the
 * list and everything else is overhead.
 */
function collect(c: UntaggedCostCollector, txn: any, sourceType: "Purchase" | "Bill" | "VendorCredit" | "JournalEntry") {
  const date = qboDate(txn.TxnDate)!;
  for (const line of expenseLines(txn, sourceType, lookups)) {
    if (line.customerQboId) continue;
    if (isUntaggedJobCost(line, sourceType)) c.add(sourceType, txn, line, date);
  }
}

describe("which lines go on the list", () => {
  it("keeps untagged job-cost lines and leaves out tagged lines and overhead", () => {
    const c = new UntaggedCostCollector("conn1");
    collect(
      c,
      {
        Id: "301",
        TxnDate: "2026-08-14",
        DocNumber: "INV-7781",
        PrivateNote: "August order",
        VendorRef: { value: "56", name: "Beacon Supply" },
        Line: [
          acctLine("1", 1840.5, "80", "Job Materials", undefined, "Drywall, 60 sheets"),
          acctLine("2", 900, "80", "Job Materials", "21"),
          acctLine("3", 2000, "60", "Rent"),
          { Id: "4", Amount: 0, DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} },
          {
            Id: "5",
            Amount: 310,
            DetailType: "ItemBasedExpenseLineDetail",
            ItemBasedExpenseLineDetail: { ItemRef: { value: "5", name: "Lumber" } },
          },
        ],
      },
      "Bill"
    );
    const rows = c.rows();
    expect(rows.map((r) => r.lineKey)).toEqual(["1", "5"]);
    expect(rows[0]).toMatchObject({
      connectionId: "conn1",
      qboSourceType: "Bill",
      qboSourceId: "301",
      kind: "bill",
      docNumber: "INV-7781",
      payee: "Beacon Supply",
      accountName: "Job Materials",
      memo: "Drywall, 60 sheets",
      amount: 1840.5,
    });
    expect(rows[0].txnDate.toISOString()).toBe("2026-08-14T00:00:00.000Z");
    // No description on the line: the bill's own memo is used.
    expect(rows[1]).toMatchObject({ accountName: "Lumber", memo: "August order", amount: 310 });
  });

  it("counts journal entries with no customer as overhead, like the tallies do", () => {
    expect(isUntaggedJobCost({ isJobCostAccount: true }, "JournalEntry")).toBe(false);
    expect(isUntaggedJobCost({ isJobCostAccount: true }, "Purchase")).toBe(true);
    expect(isUntaggedJobCost({ isJobCostAccount: false }, "Bill")).toBe(false);
    const c = new UntaggedCostCollector("conn1");
    collect(
      c,
      {
        Id: "9",
        TxnDate: "2026-08-01",
        Line: [
          { Id: "0", Amount: 5000, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "80", name: "Job Materials" } } },
        ],
      },
      "JournalEntry"
    );
    expect(c.size).toBe(0);
  });

  it("stores vendor credits and card refunds as negative amounts", () => {
    const c = new UntaggedCostCollector("conn1");
    collect(c, { Id: "12", TxnDate: "2026-07-02", VendorRef: { name: "Beacon Supply" }, Line: [acctLine("1", 400, "80", "Job Materials")] }, "VendorCredit");
    collect(
      c,
      { Id: "13", TxnDate: "2026-07-03", PaymentType: "CreditCard", Credit: true, EntityRef: { name: "Home Depot", type: "Vendor" }, Line: [acctLine("1", 75, "80", "Job Materials")] },
      "Purchase"
    );
    expect(c.rows().map((r) => [r.kind, r.amount, r.payee])).toEqual([
      ["vendor_credit", -400, "Beacon Supply"],
      ["credit_card_credit", -75, "Home Depot"],
    ]);
  });

  it("keeps a line once when a transaction is seen twice", () => {
    const c = new UntaggedCostCollector("conn1");
    const txn = (amount: number) => ({ Id: "20", TxnDate: "2026-06-01", PaymentType: "Check", Line: [acctLine("1", amount, "80", "Job Materials")] });
    collect(c, txn(100), "Purchase");
    collect(c, txn(120), "Purchase");
    expect(c.rows()).toHaveLength(1);
    expect(c.rows()[0]).toMatchObject({ amount: 120, kind: "check" });
  });

  it("cuts a very long memo", () => {
    const row = untaggedCostRow("conn1", "Purchase", { Id: "1", PrivateNote: "x".repeat(2000) }, { lineId: "1", amount: 5, accountName: null, description: null }, new Date());
    expect(row.memo!.length).toBe(500);
    expect(row.memo!.endsWith("...")).toBe(true);
  });
});

describe("transaction types", () => {
  it("names a Purchase by how it was paid", () => {
    expect(untaggedKind("Purchase", { PaymentType: "Check" })).toBe("check");
    expect(untaggedKind("Purchase", { PaymentType: "Cash" })).toBe("expense");
    expect(untaggedKind("Purchase", {})).toBe("expense");
    expect(untaggedKind("Purchase", { PaymentType: "CreditCard" })).toBe("credit_card");
    expect(untaggedKind("Purchase", { PaymentType: "CreditCard", Credit: true })).toBe("credit_card_credit");
    expect(untaggedKind("Bill", {})).toBe("bill");
    expect(untaggedKind("VendorCredit", {})).toBe("vendor_credit");
    expect(untaggedKind("JournalEntry", {})).toBe("journal_entry");
    expect(untaggedKind("TimeActivity", {})).toBe("time_entry");
    expect(untaggedKind("Something", {})).toBe("other");
  });

  it("labels each type in plain words", () => {
    expect(untaggedKindLabel("credit_card")).toBe("Credit card expense");
    expect(untaggedKindLabel("vendor_credit")).toBe("Vendor credit");
    expect(untaggedKindLabel("nonsense")).toBe("Other");
  });
});

describe("links into QuickBooks", () => {
  it("builds one link from the company and the transaction", () => {
    expect(qboTxnUrl({ realmId: "9130357", kind: "bill", txnId: "301" })).toBe(
      "https://app.qbo.intuit.com/app/bill?txnId=301&companyId=9130357"
    );
    expect(qboTxnUrl({ realmId: "9130357", kind: "check", txnId: "14", environment: "production" })).toBe(
      "https://app.qbo.intuit.com/app/check?txnId=14&companyId=9130357"
    );
    expect(qboTxnUrl({ realmId: "1", kind: "credit_card", txnId: "2" })).toBe("https://app.qbo.intuit.com/app/expense?txnId=2&companyId=1");
    expect(qboTxnUrl({ realmId: "1", kind: "vendor_credit", txnId: "2" })).toBe("https://app.qbo.intuit.com/app/vendorcredit?txnId=2&companyId=1");
    expect(qboTxnUrl({ realmId: "1", kind: "journal_entry", txnId: "2" })).toBe("https://app.qbo.intuit.com/app/journal?txnId=2&companyId=1");
  });

  it("uses the sandbox site for sandbox companies", () => {
    expect(qboTxnUrl({ realmId: "1", kind: "expense", txnId: "2", environment: "sandbox" })).toBe(
      "https://app.sandbox.qbo.intuit.com/app/expense?txnId=2&companyId=1"
    );
  });

  it("gives no link when unsure of the page or missing an id", () => {
    expect(qboTxnUrl({ realmId: "1", kind: "credit_card_credit", txnId: "2" })).toBeNull();
    expect(qboTxnUrl({ realmId: "1", kind: "time_entry", txnId: "2" })).toBeNull();
    expect(qboTxnUrl({ realmId: "1", kind: "other", txnId: "2" })).toBeNull();
    expect(qboTxnUrl({ realmId: null, kind: "bill", txnId: "2" })).toBeNull();
    expect(qboTxnUrl({ realmId: "1", kind: "bill", txnId: "" })).toBeNull();
  });

  it("escapes ids", () => {
    expect(qboTxnUrl({ realmId: "1&x=2", kind: "bill", txnId: "3 4" })).toBe("https://app.qbo.intuit.com/app/bill?txnId=3%204&companyId=1%26x%3D2");
  });

  it("gives no link when the company id can't be read", () => {
    expect(connectionRealmId({ realmId: "not-encrypted" })).toBeNull();
  });
});

describe("the spreadsheet", () => {
  it("has every row, biggest first, with a link where there is one", () => {
    const base = { qboSourceType: "Purchase", docNumber: null, accountName: "Job Materials", memo: null };
    const rows = sortUntagged([
      { ...base, id: "a", qboSourceId: "1", kind: "credit_card_credit", txnDate: new Date("2026-05-01T00:00:00Z"), payee: "Home Depot", amount: -75 },
      { ...base, id: "b", qboSourceId: "2", kind: "check", txnDate: new Date("2026-06-01T00:00:00Z"), payee: "Ace Electric", amount: 4200, docNumber: "1043" },
      { ...base, id: "c", qboSourceId: "3", kind: "expense", txnDate: new Date("2026-07-01T00:00:00Z"), payee: null, amount: 310.456, memo: "=cmd" },
    ]);
    const csv = untaggedCsvRows(rows, "77", "production");
    expect(csv[0]).toEqual(["Date", "Vendor or payee", "Type", "Number", "Account", "Memo", "Amount", "Open in QuickBooks"]);
    expect(csv.slice(1)).toEqual([
      ["2026-06-01", "Ace Electric", "Check", "1043", "Job Materials", "", 4200, "https://app.qbo.intuit.com/app/check?txnId=2&companyId=77"],
      ["2026-07-01", "", "Expense", "", "Job Materials", "=cmd", 310.46, "https://app.qbo.intuit.com/app/expense?txnId=3&companyId=77"],
      ["2026-05-01", "Home Depot", "Credit card credit", "", "Job Materials", "", -75, ""],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

beforeEach(() => {
  fake.client = createFakePrisma();
  fake.client.untaggedCost = new FakeModel("untaggedCost", [{ fields: ["connectionId", "qboSourceType", "qboSourceId", "lineKey"] }], () => ({
    createdAt: new Date(),
  }));
});

const row = (over: Partial<UntaggedCostRow>): UntaggedCostRow => ({
  connectionId: "conn1",
  qboSourceType: "Bill",
  qboSourceId: "1",
  lineKey: "1",
  kind: "bill",
  txnDate: new Date("2026-08-01T00:00:00Z"),
  docNumber: null,
  payee: "Beacon Supply",
  accountName: "Job Materials",
  memo: null,
  amount: 100,
  ...over,
});

const stored = () =>
  (fake.client.untaggedCost.rows as UntaggedCostRow[])
    .map((r) => `${r.connectionId}/${r.qboSourceType}/${r.qboSourceId}/${r.lineKey}=${r.amount}`)
    .sort();

describe("storing the list", () => {
  it("a full sync replaces the company's rows and no other company's", async () => {
    await replaceUntaggedCosts("conn1", [row({ qboSourceId: "1" }), row({ qboSourceId: "2" })]);
    await replaceUntaggedCosts("conn2", [row({ connectionId: "conn2", qboSourceId: "1" })]);
    await replaceUntaggedCosts("conn1", [row({ qboSourceId: "3", amount: 50 })]);
    expect(stored()).toEqual(["conn1/Bill/3/1=50", "conn2/Bill/1/1=100"]);
  });

  it("a full sync keeps the rows of a type QuickBooks failed to send", async () => {
    await replaceUntaggedCosts("conn1", [row({ qboSourceId: "1" }), row({ qboSourceType: "VendorCredit", qboSourceId: "8", amount: -20 })]);
    await replaceUntaggedCosts("conn1", [row({ qboSourceId: "2" })], ["VendorCredit", "Estimate"]);
    expect(stored()).toEqual(["conn1/Bill/2/1=100", "conn1/VendorCredit/8/1=-20"]);
  });

  it("an incremental sync replaces only the transactions it re-read", async () => {
    await replaceUntaggedCosts("conn1", [
      row({ qboSourceId: "1", lineKey: "1" }),
      row({ qboSourceId: "1", lineKey: "2" }),
      row({ qboSourceId: "2" }),
      row({ qboSourceId: "3" }),
      row({ qboSourceType: "Purchase", qboSourceId: "1", kind: "check" }),
    ]);
    // Bill 1: line 2 now on a job, line 1 changed. Bill 2: deleted in
    // QuickBooks. Bill 3 and Purchase 1: not re-read, left alone. Bill 4: new.
    const touched = new Map([["Bill", new Set(["1", "2", "4"])]]);
    await replaceUntaggedCostsForTxns(
      "conn1",
      [row({ qboSourceId: "1", lineKey: "1", amount: 140 }), row({ qboSourceId: "4", amount: 60 }), row({ qboSourceId: "99" })],
      touched
    );
    expect(stored()).toEqual(["conn1/Bill/1/1=140", "conn1/Bill/3/1=100", "conn1/Bill/4/1=60", "conn1/Purchase/1/1=100"]);
  });

  it("an incremental sync with nothing re-read writes nothing", async () => {
    await replaceUntaggedCosts("conn1", [row({})]);
    expect(await replaceUntaggedCostsForTxns("conn1", [], new Map())).toBe(0);
    expect(stored()).toEqual(["conn1/Bill/1/1=100"]);
  });

  it("reads the last 12 months, biggest first, with the full count", async () => {
    const now = new Date("2026-09-28T12:00:00Z");
    await replaceUntaggedCosts("conn1", [
      row({ qboSourceId: "1", amount: 50 }),
      row({ qboSourceId: "2", amount: 5000 }),
      row({ qboSourceId: "3", amount: -300 }),
      row({ qboSourceId: "4", amount: 9000, txnDate: new Date("2025-09-01T00:00:00Z") }),
      row({ qboSourceId: "5", amount: 700 }),
    ]);
    const top = await loadUntaggedCosts("conn1", now, 2);
    expect(top.total).toBe(4);
    expect(top.rows.map((r) => r.qboSourceId)).toEqual(["2", "5"]);
    const all = await loadUntaggedCosts("conn1", now);
    expect(all.rows.map((r) => r.amount)).toEqual([5000, 700, 50, -300]);
  });
});
