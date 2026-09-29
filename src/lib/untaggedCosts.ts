import type { NormalizedCostLine } from "@/lib/qboNormalize";

/**
 * Job costs that aren't on any job: the lines behind Data Health's "job costs
 * not tagged to a job" count, kept one by one so the contractor can open each
 * in QuickBooks and tag it. Untagged costs are the main reason QuickBooks job
 * costing reads wrong, so a count alone isn't enough to act on.
 *
 * This file is pure (no database) so it can be tested. The sync collects rows
 * here (see processExpenseTxn in src/lib/quickbooksSync.ts) and writes them
 * with src/lib/untaggedCostStore.ts.
 */

/** How many to show on the page. The CSV has all of them. */
export const UNTAGGED_LIST_LIMIT = 50;
/** Same window as the counts on Data Health. */
export const UNTAGGED_WINDOW_DAYS = 365;
/** A long memo is cut here: it's there to recognise the cost, not to archive it. */
const MEMO_MAX = 500;

/**
 * A line with no job on it that is job cost rather than overhead. Journal
 * entries without a customer are usually company-wide postings (a payroll
 * summary, an allocation), not a job cost someone forgot to tag, so they
 * count with overhead.
 */
export function isUntaggedJobCost(line: Pick<NormalizedCostLine, "isJobCostAccount">, sourceType: string): boolean {
  return line.isJobCostAccount && sourceType !== "JournalEntry";
}

export type UntaggedKind =
  | "bill"
  | "expense"
  | "check"
  | "credit_card"
  | "credit_card_credit"
  | "vendor_credit"
  | "journal_entry"
  | "time_entry"
  | "deposit"
  | "other";

const KIND_LABELS: Record<UntaggedKind, string> = {
  bill: "Bill",
  expense: "Expense",
  check: "Check",
  credit_card: "Credit card expense",
  credit_card_credit: "Credit card credit",
  vendor_credit: "Vendor credit",
  journal_entry: "Journal entry",
  time_entry: "Time entry",
  deposit: "Deposit",
  other: "Other",
};

/**
 * The form a transaction is in QuickBooks. A Purchase is an expense, a check
 * or a credit card charge depending on how it was paid; a card refund is a
 * Purchase with Credit set.
 */
export function untaggedKind(sourceType: string, txn: any): UntaggedKind {
  switch (sourceType) {
    case "Bill":
      return "bill";
    case "VendorCredit":
      return "vendor_credit";
    case "JournalEntry":
      return "journal_entry";
    case "TimeActivity":
      return "time_entry";
    case "Deposit":
      return "deposit";
    case "Purchase": {
      const pay = typeof txn?.PaymentType === "string" ? txn.PaymentType : "";
      if (pay === "Check") return "check";
      if (pay === "CreditCard") return txn?.Credit === true ? "credit_card_credit" : "credit_card";
      return "expense";
    }
    default:
      return "other";
  }
}

export function untaggedKindLabel(kind: string): string {
  return KIND_LABELS[kind as UntaggedKind] ?? KIND_LABELS.other;
}

/**
 * The page in QuickBooks Online that opens each kind of transaction. NOT
 * verified against QuickBooks: these are the addresses QuickBooks shows in
 * the browser for these forms. Kinds we're unsure of have no entry, so they
 * get no link rather than one that might open the wrong screen.
 */
const QBO_PAGE: Partial<Record<UntaggedKind, string>> = {
  bill: "bill",
  expense: "expense",
  // A credit card charge is entered on the Expense form.
  credit_card: "expense",
  check: "check",
  vendor_credit: "vendorcredit",
  journal_entry: "journal",
};

/**
 * A link that opens one transaction in QuickBooks Online, or null when we
 * can't build one we trust. companyId names the QuickBooks company so a
 * bookkeeper signed in to several is taken to the right one (not verified
 * either; QuickBooks may ignore it and use the company that is open).
 */
export function qboTxnUrl(opts: {
  realmId: string | null | undefined;
  kind: string;
  txnId: string | null | undefined;
  environment?: string | null;
}): string | null {
  const page = QBO_PAGE[opts.kind as UntaggedKind];
  if (!page || !opts.realmId || !opts.txnId) return null;
  const host = opts.environment === "sandbox" ? "https://app.sandbox.qbo.intuit.com" : "https://app.qbo.intuit.com";
  return `${host}/app/${page}?txnId=${encodeURIComponent(opts.txnId)}&companyId=${encodeURIComponent(opts.realmId)}`;
}

const text = (v: unknown): string | null => {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

/** Who was paid: the vendor on a bill or vendor credit, the payee on an expense or check. */
export function untaggedPayee(sourceType: string, txn: any): string | null {
  if (sourceType === "Bill" || sourceType === "VendorCredit") return text(txn?.VendorRef?.name);
  if (sourceType === "Purchase") return text(txn?.EntityRef?.name);
  if (sourceType === "TimeActivity") return text(txn?.EmployeeRef?.name) ?? text(txn?.VendorRef?.name);
  return text(txn?.EntityRef?.name);
}

export interface UntaggedCostRow {
  connectionId: string;
  qboSourceType: string;
  qboSourceId: string;
  lineKey: string;
  kind: UntaggedKind;
  txnDate: Date;
  docNumber: string | null;
  payee: string | null;
  accountName: string | null;
  memo: string | null;
  amount: number;
}

/** One stored row for an untagged job-cost line. The line's own description wins over the transaction's memo. */
export function untaggedCostRow(
  connectionId: string,
  sourceType: string,
  txn: any,
  line: Pick<NormalizedCostLine, "lineId" | "amount" | "accountName" | "description">,
  txnDate: Date
): UntaggedCostRow {
  const memo = text(line.description) ?? text(txn?.PrivateNote);
  return {
    connectionId,
    qboSourceType: sourceType,
    qboSourceId: String(txn?.Id),
    lineKey: String(line.lineId),
    kind: untaggedKind(sourceType, txn),
    txnDate,
    docNumber: text(txn?.DocNumber),
    payee: untaggedPayee(sourceType, txn),
    accountName: text(line.accountName),
    memo: memo && memo.length > MEMO_MAX ? `${memo.slice(0, MEMO_MAX - 3)}...` : memo,
    amount: line.amount,
  };
}

const rowKey = (r: Pick<UntaggedCostRow, "qboSourceType" | "qboSourceId" | "lineKey">) =>
  `${r.qboSourceType}\u0000${r.qboSourceId}\u0000${r.lineKey}`;

/**
 * Gathers a sync's untagged job-cost lines in memory, so they are written in
 * a few bulk statements at the end instead of one per line. A line seen
 * twice (a transaction CDC reported twice) is kept once, last one wins.
 */
export class UntaggedCostCollector {
  private readonly byKey = new Map<string, UntaggedCostRow>();

  constructor(private readonly connectionId: string) {}

  add(sourceType: string, txn: any, line: Pick<NormalizedCostLine, "lineId" | "amount" | "accountName" | "description">, txnDate: Date) {
    if (txn?.Id == null) return;
    const row = untaggedCostRow(this.connectionId, sourceType, txn, line, txnDate);
    this.byKey.set(rowKey(row), row);
  }

  get size(): number {
    return this.byKey.size;
  }

  rows(): UntaggedCostRow[] {
    return [...this.byKey.values()];
  }
}

/** Biggest first, then newest, so the list and the CSV agree on order. */
export function sortUntagged<T extends { amount: number; txnDate: Date }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.amount - a.amount || b.txnDate.getTime() - a.txnDate.getTime());
}

export interface UntaggedCostView {
  id: string;
  qboSourceType: string;
  qboSourceId: string;
  kind: string;
  txnDate: Date;
  docNumber: string | null;
  payee: string | null;
  accountName: string | null;
  memo: string | null;
  amount: number;
}

/** The spreadsheet: every row, with a link to open each in QuickBooks where we have one. */
export function untaggedCsvRows(
  rows: UntaggedCostView[],
  realmId: string | null,
  environment: string | null
): (string | number)[][] {
  const header = ["Date", "Vendor or payee", "Type", "Number", "Account", "Memo", "Amount", "Open in QuickBooks"];
  return [
    header,
    ...rows.map((r) => [
      r.txnDate.toISOString().slice(0, 10),
      r.payee ?? "",
      untaggedKindLabel(r.kind),
      r.docNumber ?? "",
      r.accountName ?? "",
      r.memo ?? "",
      Math.round(r.amount * 100) / 100,
      qboTxnUrl({ realmId, kind: r.kind, txnId: r.qboSourceId, environment }) ?? "",
    ]),
  ];
}
