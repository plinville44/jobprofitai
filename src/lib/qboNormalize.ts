/**
 * Pure translation from QuickBooks Online API records to the rows
 * JobProfitAI stores. No database, no network, no clock: every function
 * here takes plain objects and returns plain objects, so the rules that
 * decide what a dollar means can be unit tested against real payload shapes
 * (see src/lib/__tests__/qboNormalize.test.ts).
 *
 * The database side lives in src/lib/quickbooksSync.ts.
 *
 * Rules that are easy to get wrong, and are the reason this file exists:
 *
 *  - Labor is hours x the COST rate on the time entry (TimeActivity.CostRate).
 *    TimeActivity.HourlyRate is the rate the customer is BILLED, and using it
 *    as a cost overstated labor by the contractor's whole markup, while
 *    non-billable crew time (no bill rate) came through as $0.
 *  - A credit card purchase with Credit = true is a refund, and a
 *    VendorCredit is a supplier credit. Both reduce job cost.
 *  - Revenue excludes sales tax, and credit memos and refund receipts
 *    reduce it.
 *  - Every row id includes the connection id. QuickBooks ids are small
 *    per-company numbers, so "Purchase 145" exists in almost every company;
 *    an id without the connection in it made two companies write to the
 *    same row.
 */

export type CostCategory = "labor" | "materials" | "subcontractor" | "equipment" | "overhead" | "other";

export const COST_CATEGORIES: CostCategory[] = ["labor", "materials", "subcontractor", "equipment", "overhead", "other"];

export type ExpenseSourceType = "Purchase" | "Bill" | "VendorCredit" | "JournalEntry";
export type RevenueSourceType = "Invoice" | "SalesReceipt" | "CreditMemo" | "RefundReceipt";

export interface AccountInfo {
  name: string;
  fullName: string;
  type: string | null; // QuickBooks AccountType, e.g. "Cost of Goods Sold", "Expense"
  subType: string | null; // QuickBooks AccountSubType, e.g. "SuppliesMaterialsCogs"
}

export interface ItemInfo {
  name: string;
  expenseAccountId: string | null;
  /** What the contractor pays for one unit (QuickBooks' Purchase Cost), or null when not set. */
  purchaseCost?: number | null;
}

export interface Lookups {
  accounts: Map<string, AccountInfo>;
  items: Map<string, ItemInfo>;
  /** CategoryMapping rows: sourceName -> category. Wins over everything. */
  mappings: Map<string, string>;
}

export const emptyLookups = (): Lookups => ({ accounts: new Map(), items: new Map(), mappings: new Map() });

// ---------------------------------------------------------------------------
// Row ids
// ---------------------------------------------------------------------------

export const costEntryId = (connectionId: string, source: string, txnId: string, lineId: string | number) =>
  `${connectionId}:${source}:${txnId}:${lineId}`;

export const revenueId = (connectionId: string, source: RevenueSourceType, txnId: string) =>
  `${connectionId}:${source}:${txnId}`;

/**
 * Revenue that comes from one line of a transaction: a bank deposit line, a
 * journal entry income line, or an income line on a check, expense, bill or
 * vendor credit (a refund paid to a customer).
 */
export type LineRevenueSourceType = "Deposit" | "JournalEntry" | "Purchase" | "Bill" | "VendorCredit";

export const lineRevenueId = (connectionId: string, source: LineRevenueSourceType, txnId: string, lineId: string) =>
  `${connectionId}:${source}:${txnId}:${lineId}`;

export const estimateRowId = (connectionId: string, estimateId: string) => `${connectionId}:${estimateId}`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : v != null && typeof v !== "object" ? String(v) : null);
export const round2 = (n: number) => Math.round(n * 100) / 100;

/** QuickBooks sends dates as "YYYY-MM-DD". Stored as midnight UTC of that day. */
export function qboDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * QuickBooks' own account detail types, where they say what the money is.
 * Checked before any keyword matching because they are chosen by the
 * bookkeeper from a fixed list, not typed free-hand.
 */
const SUBTYPE_CATEGORY: Record<string, CostCategory> = {
  SuppliesMaterialsCogs: "materials",
  SuppliesMaterials: "materials",
  CostOfLaborCos: "labor",
  CostOfLabor: "labor",
  PayrollExpenses: "labor",
  PayrollWageExpenses: "labor",
  EquipmentRentalCos: "equipment",
  EquipmentRental: "equipment",
  RentOrLeaseOfBuildings: "overhead",
  OfficeGeneralAdministrativeExpenses: "overhead",
  Utilities: "overhead",
  Insurance: "overhead",
  AdvertisingPromotional: "overhead",
  LegalProfessionalFees: "overhead",
};

/**
 * Keyword rules on an account or item name. Order is load-bearing:
 * subcontractor before labor ("Subcontracted labor", "Contract labor" and
 * "Sub labor" all contain "labor", and subbing work out has a different
 * margin from doing it with your own crew).
 */
export function categorizeByName(rawName: string | null | undefined): CostCategory | null {
  const name = ` ${(rawName ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  if (name.trim() === "") return null;
  // Whole words and phrases only. A prefix match let "subs" catch
  // "Subscriptions" and file a software bill under subcontractors.
  const has = (...words: string[]) => words.some((w) => name.includes(` ${w} `));
  if (has("subcontractor", "subcontractors", "subcontract", "subcontracted", "sub contractor", "sub contractors", "subs", "sub labor", "contract labor", "1099")) return "subcontractor";
  if (has("labor", "labour", "payroll", "wage", "wages", "salaries")) return "labor";
  if (has("material", "materials", "supply", "supplies", "lumber", "concrete", "drywall", "hardware", "fixtures", "roofing materials", "shingles")) return "materials";
  if (has("equipment", "rental", "rentals", "tool", "tools", "machinery")) return "equipment";
  if (has("overhead", "admin", "administrative", "office", "rent", "utilities", "insurance", "advertising", "marketing", "software")) return "overhead";
  return null;
}

export interface LineSource {
  /** Name stored on the CostEntry (accountName) and used for mappings. */
  sourceName: string | null;
  accountId: string | null;
  itemId: string | null;
}

/** Decides a line's category and whether it posts to a job-cost account. */
export function categorizeLine(src: LineSource, lookups: Lookups): { category: CostCategory; isJobCostAccount: boolean } {
  const account =
    (src.accountId ? lookups.accounts.get(src.accountId) : undefined) ??
    (src.itemId ? lookups.accounts.get(lookups.items.get(src.itemId)?.expenseAccountId ?? "") : undefined);
  const isJobCostAccount =
    // Anything bought against an item is job material by nature; an
    // account-based line counts when it posts to Cost of Goods Sold.
    Boolean(src.itemId) || (account?.type ?? "").toLowerCase() === "cost of goods sold" || /cos(ts)?$|cogs$/i.test(account?.subType ?? "");

  const mapped = src.sourceName ? lookups.mappings.get(src.sourceName) : undefined;
  if (mapped && (COST_CATEGORIES as string[]).includes(mapped)) return { category: mapped as CostCategory, isJobCostAccount };

  const fromSubType = account?.subType ? SUBTYPE_CATEGORY[account.subType] : undefined;
  const itemName = src.itemId ? lookups.items.get(src.itemId)?.name : null;
  const category =
    categorizeByName(src.sourceName) ??
    categorizeByName(itemName) ??
    fromSubType ??
    categorizeByName(account?.fullName ?? account?.name) ??
    "other";
  return { category, isJobCostAccount };
}

// ---------------------------------------------------------------------------
// Expense lines (Purchase, Bill, VendorCredit, JournalEntry)
// ---------------------------------------------------------------------------

// "Other Current Asset" is left out on purpose: builders who hold job costs
// in a Construction in Progress account post them there, tagged to the job.
const NOT_COST_ACCOUNT_TYPES = new Set([
  "bank",
  "accounts receivable",
  "fixed asset",
  "other asset",
  "accounts payable",
  "credit card",
  "other current liability",
  "long term liability",
  "equity",
  "income",
  "other income",
]);

// Other Current Asset accounts that hold money owed to the company or cash
// on its way to the bank, never job cost. Retainage matters most: many
// contractors move retainage to a receivable with a journal entry that names
// the customer, and that is not a cost of the job. Detail type names are
// QuickBooks' own; the name check catches accounts set up under a generic
// detail type.
const NOT_COST_ASSET_SUBTYPE = /^(retainage|undepositedfunds|allowancefor|loansto|employeecashadvances|investment)/i;
const NOT_COST_ASSET_NAME = /\b(retainage|retention|undeposited)\b/i;

/**
 * Whether a line posted to this account can be job cost, and what kind of
 * account it is. One rule for bills, expenses, journal entries and deposits:
 *
 *  - "cost": Cost of Goods Sold, Expense, Other Expense.
 *  - "asset": Other Current Asset, such as Construction in Progress, except
 *    the receivable and cash accounts above.
 *  - "unknown": the account can't be looked up.
 *  - null: a balance-sheet or income account that is never job cost.
 */
export function costAccountKind(accountId: string | null, lookups: Lookups): "cost" | "asset" | "unknown" | null {
  const account = accountId ? lookups.accounts.get(accountId) : undefined;
  const type = (account?.type ?? "").toLowerCase();
  if (!account || type === "") return "unknown";
  if (NOT_COST_ACCOUNT_TYPES.has(type)) return null;
  if (type === "other current asset") {
    if (NOT_COST_ASSET_SUBTYPE.test(account.subType ?? "") || NOT_COST_ASSET_NAME.test(`${account.name} ${account.fullName}`)) return null;
    return "asset";
  }
  return "cost";
}

// A journal entry touches asset accounts for many reasons besides holding
// job costs: a year-end "Costs in excess of billings" adjustment, inventory
// used on a job, a prepaid expense used up. Those name the job too, but the
// cost was already counted (or never was one), so only an account that holds
// job costs until the job is finished counts on a journal entry.
const WIP_ASSET_NAME = /\b(construction in progress|work in progress|work in process|cip|wip)\b/;
const NOT_WIP_ASSET_NAME = /\b(billing|billings|in excess|retainage|retention|inventory|prepaid)\b/;
const NOT_WIP_ASSET_SUBTYPE = /^(inventory|prepaidexpenses)/i;

/**
 * Whether an Other Current Asset account holds job costs while the job is
 * under way (Construction in Progress, Work in Progress, CIP, WIP). Journal
 * entry lines on other asset accounts are not job cost. Bills and expenses
 * don't use this: a bill posted to an asset account and tagged to a job is
 * cost on the job, as QuickBooks' own job reports show it.
 */
export function isWorkInProgressAccount(account: AccountInfo | undefined): boolean {
  if (!account) return false;
  if (NOT_WIP_ASSET_SUBTYPE.test(account.subType ?? "")) return false;
  const name = ` ${`${account.name} ${account.fullName}`.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return WIP_ASSET_NAME.test(name) && !NOT_WIP_ASSET_NAME.test(name);
}

export interface NormalizedCostLine {
  lineId: string;
  customerQboId: string | null;
  customerName: string | null;
  /** The QuickBooks Class on the line (or the transaction), for companies that track jobs by class. */
  classQboId: string | null;
  /** Signed: refunds, vendor credits and JE credits are negative. */
  amount: number;
  category: CostCategory;
  accountName: string | null;
  isJobCostAccount: boolean;
  description: string | null;
}

/**
 * Every job-relevant line on an expense-type transaction. Zero-amount lines
 * (subtotals, and every line of a voided check) are dropped here, which is
 * what makes a voided expense disappear from the job on the next sync.
 */
export function expenseLines(txn: any, sourceType: ExpenseSourceType, lookups: Lookups): NormalizedCostLine[] {
  const out: NormalizedCostLine[] = [];
  const lines: any[] = Array.isArray(txn?.Line) ? txn.Line : [];

  if (sourceType === "JournalEntry") {
    for (const [i, line] of lines.entries()) {
      const d = line?.JournalEntryLineDetail;
      if (!d) continue;
      const entity = d.Entity;
      const isCustomer = (entity?.Type ?? "").toLowerCase() === "customer";
      const accountId = str(d.AccountRef?.value);
      const account = accountId ? lookups.accounts.get(accountId) : undefined;
      // The account rule bills and expenses use, signed by debit or credit,
      // with asset accounts narrowed to the ones that hold job costs (below).
      // A builder who holds costs in Construction in Progress closes
      // a finished job with a debit to cost of goods sold and a credit to
      // Construction in Progress, both naming the job: the credit cancels the
      // bill that went to Construction in Progress, so the cost counts once.
      // Income lines are read by journalRevenueLines.
      const kind = costAccountKind(accountId, lookups);
      if (kind == null) continue;
      // Only asset accounts that hold job costs: a "Costs in excess of
      // billings" adjustment or inventory used on a job names the job too,
      // and counting it would add cost that was never spent, or cancel cost
      // that was (see isWorkInProgressAccount).
      if (kind === "asset" && !isWorkInProgressAccount(account)) continue;
      // An asset or unknown account line with no job on it is a balance
      // sheet movement, not company overhead, so it is left out entirely.
      if (kind !== "cost" && !(isCustomer && entity?.EntityRef?.value != null) && d.ClassRef?.value == null) continue;
      const raw = num(line.Amount);
      if (raw === 0) continue;
      const amount = (d.PostingType === "Credit" ? -1 : 1) * raw;
      const sourceName = str(d.AccountRef?.name) ?? account?.fullName ?? null;
      const { category, isJobCostAccount } = categorizeLine({ sourceName, accountId, itemId: null }, lookups);
      out.push({
        lineId: str(line.Id) ?? String(i),
        customerQboId: isCustomer ? str(entity?.EntityRef?.value) : null,
        customerName: isCustomer ? str(entity?.EntityRef?.name) : null,
        classQboId: str(d.ClassRef?.value),
        amount: round2(amount),
        category,
        accountName: sourceName,
        isJobCostAccount,
        description: str(line.Description),
      });
    }
    return out;
  }

  // Purchase (Credit = true is a card refund) and VendorCredit are negative.
  const sign = sourceType === "VendorCredit" || (sourceType === "Purchase" && txn?.Credit === true) ? -1 : 1;

  for (const [i, line] of lines.entries()) {
    const acct = line?.AccountBasedExpenseLineDetail;
    const item = line?.ItemBasedExpenseLineDetail;
    if (!acct && !item) continue; // subtotal / description-only lines
    const raw = num(line.Amount);
    if (raw === 0) continue;
    const accountId = str(acct?.AccountRef?.value);
    // A line posted to a balance-sheet or income account (a trailer bought
    // as a fixed asset, a loan payment, a transfer) isn't job cost, even
    // with a customer on it: QuickBooks' own job reports leave it out too.
    // Item lines always count, and so does an account we can't look up.
    // Income lines (a refund check to a customer) become revenue instead:
    // see expenseRevenueLines.
    if (acct && accountId && costAccountKind(accountId, lookups) == null) continue;
    const itemId = str(item?.ItemRef?.value);
    const sourceName = str(acct?.AccountRef?.name) ?? str(item?.ItemRef?.name);
    const { category, isJobCostAccount } = categorizeLine({ sourceName, accountId, itemId }, lookups);
    out.push({
      lineId: str(line.Id) ?? String(i),
      customerQboId: str(acct?.CustomerRef?.value) ?? str(item?.CustomerRef?.value),
      customerName: str(acct?.CustomerRef?.name) ?? str(item?.CustomerRef?.name),
      classQboId: str(acct?.ClassRef?.value) ?? str(item?.ClassRef?.value) ?? str(txn?.ClassRef?.value),
      amount: round2(sign * raw),
      category,
      accountName: sourceName,
      isJobCostAccount,
      description: str(line.Description),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export type TimeCostResult =
  | { kind: "cost"; hours: number; payRate: number; amount: number; category: CostCategory }
  | { kind: "skip"; reason: "no_customer" | "vendor_time" | "no_pay_rate" | "no_hours" };

/**
 * Hours on a time entry: End - Start - break when the entry has start and
 * end times, otherwise Hours + Minutes.
 *
 * Start and end win when both are there, because they are what the crew
 * clocked and the break sits inside them. Whether QuickBooks' Hours on such
 * an entry already has the break taken off isn't known, so the break is only
 * ever taken off the start-to-end span and never off Hours: that way it can't
 * be taken off twice, or not at all.
 */
export function timeActivityHours(ta: any): number {
  const direct = Math.max(0, num(ta?.Hours) + num(ta?.Minutes) / 60);
  const start = typeof ta?.StartTime === "string" ? Date.parse(ta.StartTime) : NaN;
  const end = typeof ta?.EndTime === "string" ? Date.parse(ta.EndTime) : NaN;
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    const breakHours = Math.max(0, num(ta?.BreakHours) + num(ta?.BreakMinutes) / 60);
    const worked = (end - start) / 3_600_000 - breakHours;
    // A break as long as the whole span is bad data: fall back to Hours.
    if (worked > 0) return worked;
  }
  return direct;
}

/**
 * A time entry's cost to the contractor.
 *
 * Only employee time. A vendor's time entry is a subcontractor logging
 * hours, and what the contractor pays them arrives as a bill or expense,
 * which is already synced; costing the hours too would count it twice.
 */
export function timeActivityCost(ta: any, jobSource: JobSource = "projects"): TimeCostResult {
  const tagged = jobSource === "classes" ? str(ta?.ClassRef?.value) : str(ta?.CustomerRef?.value);
  if (!tagged) return { kind: "skip", reason: "no_customer" };
  if (ta?.VendorRef && !ta?.EmployeeRef) return { kind: "skip", reason: "vendor_time" };
  const payRate = num(ta?.CostRate);
  if (payRate <= 0) return { kind: "skip", reason: "no_pay_rate" };
  const hours = timeActivityHours(ta);
  if (hours <= 0) return { kind: "skip", reason: "no_hours" };
  return { kind: "cost", hours, payRate, amount: round2(hours * payRate), category: "labor" };
}

// ---------------------------------------------------------------------------
// Revenue (Invoice, SalesReceipt, CreditMemo, RefundReceipt)
// ---------------------------------------------------------------------------

export interface NormalizedRevenue {
  customerQboId: string | null;
  /** Net of sales tax, signed (credit memos and refunds are negative). */
  amount: number;
  tax: number;
  status: "open" | "paid" | "credit";
  txnDate: Date | null;
  /** What's still owed on an open invoice (QuickBooks' Balance, with tax), else null. */
  openBalance: number | null;
  /** The sale's own number (DocNumber), when it has one. */
  docNumber: string | null;
  /** When an invoice is due (DueDate); null on everything but invoices, and on invoices with none. */
  dueDate: Date | null;
}

export function revenueFromTxn(txn: any, sourceType: RevenueSourceType): NormalizedRevenue {
  const total = num(txn?.TotalAmt);
  const tax = num(txn?.TxnTaxDetail?.TotalTax);
  const net = total - tax;
  const negative = sourceType === "CreditMemo" || sourceType === "RefundReceipt";
  return {
    customerQboId: str(txn?.CustomerRef?.value),
    amount: round2(negative ? -net : net),
    tax: round2(negative ? -tax : tax),
    status: negative ? "credit" : sourceType === "Invoice" && num(txn?.Balance) > 0 ? "open" : "paid",
    txnDate: qboDate(txn?.TxnDate),
    openBalance: sourceType === "Invoice" && num(txn?.Balance) > 0 ? round2(num(txn?.Balance)) : null,
    docNumber: str(txn?.DocNumber),
    dueDate: sourceType === "Invoice" ? qboDate(txn?.DueDate) : null,
  };
}

/**
 * A sale split by QuickBooks Class, for companies that track each job as a
 * class. Each class gets its share of the sale net of tax, in proportion to
 * its lines, and the same share of any open balance. Lines with no class of
 * their own take the transaction's class; with none at all, the key is null.
 *
 * A discount line with its own class comes off that class only, as it does
 * in QuickBooks' report for the class. A discount with no class of its own
 * (and shipping, and anything else between the lines and the total) is
 * spread across the classes by share.
 */
export function revenueByClass(
  txn: any,
  sourceType: RevenueSourceType
): { classQboId: string | null; amount: number; tax: number; openBalance: number | null; docNumber: string | null; dueDate: Date | null }[] {
  const whole = revenueFromTxn(txn, sourceType);
  const byClass = new Map<string | null, number>();
  const walk = (lines: unknown) => {
    if (!Array.isArray(lines)) return;
    for (const line of lines) {
      if (line?.GroupLineDetail) {
        walk(line.GroupLineDetail.Line);
        continue;
      }
      const discount = line?.DiscountLineDetail;
      if (discount) {
        const own = str(discount.ClassRef?.value);
        // QuickBooks sends the discount as a positive amount; taken off
        // whatever the sign.
        const off = Math.abs(num(line.Amount));
        if (own && off > 0) byClass.set(own, (byClass.get(own) ?? 0) - off);
        continue;
      }
      const d = line?.SalesItemLineDetail;
      if (!d) continue;
      const amount = num(line.Amount);
      if (amount === 0) continue;
      const key = str(d.ClassRef?.value) ?? str(txn?.ClassRef?.value);
      byClass.set(key, (byClass.get(key) ?? 0) + amount);
    }
  };
  walk(txn?.Line);
  const gross = [...byClass.values()].reduce((a, b) => a + b, 0);
  if (byClass.size === 0 || Math.abs(gross) < 0.005) {
    return [
      {
        classQboId: str(txn?.ClassRef?.value),
        amount: whole.amount,
        tax: whole.tax,
        openBalance: whole.openBalance,
        docNumber: whole.docNumber,
        dueDate: whole.dueDate,
      },
    ];
  }
  return [...byClass].map(([classQboId, amount]) => {
    const share = amount / gross;
    return {
      classQboId,
      amount: round2(whole.amount * share),
      tax: round2(whole.tax * share),
      openBalance: whole.openBalance == null ? null : round2(whole.openBalance * share),
      // Every class's share is part of the same invoice, due the same day.
      docNumber: whole.docNumber,
      dueDate: whole.dueDate,
    };
  });
}

// ---------------------------------------------------------------------------
// Revenue recorded without an invoice: bank deposits and journal entries
// ---------------------------------------------------------------------------

export interface NormalizedRevenueLine {
  lineId: string;
  /** Null only for a class-mode line with the job's class and no customer. */
  customerQboId: string | null;
  classQboId: string | null;
  /** Signed: money in to an income account is positive. */
  amount: number;
  txnDate: Date | null;
}

// Income only, not Other Income: a late fee or interest isn't job revenue,
// and "Check against QuickBooks" compares with the Income group.
const INCOME_ACCOUNT_TYPES = new Set(["income"]);

function isIncomeAccount(accountId: string | null, lookups: Lookups): boolean {
  const account = accountId ? lookups.accounts.get(accountId) : undefined;
  return INCOME_ACCOUNT_TYPES.has((account?.type ?? "").toLowerCase());
}

/**
 * Deposit lines that record income straight from a customer: a check put
 * in the bank against an income account with the customer named, and no
 * invoice. QuickBooks counts these as the customer's income, so a job
 * whose payments arrive this way would otherwise show no revenue.
 *
 * Lines that deposit a payment or a sales receipt (they carry a LinkedTxn)
 * are skipped: that money is already counted on the invoice or receipt.
 * Lines to anything but an income account (a customer deposit held as a
 * liability, a transfer, a refund from a supplier) aren't revenue either.
 */
export function depositRevenueLines(txn: any, lookups: Lookups, byClass = false): NormalizedRevenueLine[] {
  const out: NormalizedRevenueLine[] = [];
  const lines: any[] = Array.isArray(txn?.Line) ? txn.Line : [];
  for (const [i, line] of lines.entries()) {
    if (Array.isArray(line?.LinkedTxn) && line.LinkedTxn.length > 0) continue;
    const d = line?.DepositLineDetail;
    if (!d) continue;
    const entity = d.Entity;
    const entityType = String(entity?.type ?? entity?.Type ?? "").toLowerCase();
    const customerQboId = entityType === "customer" ? str(entity?.value ?? entity?.EntityRef?.value) : null;
    const classQboId = str(d.ClassRef?.value) ?? str(txn?.ClassRef?.value);
    // Jobs by class: income with the job's class counts whether or not a
    // customer is named, as it does in QuickBooks' report for that class.
    if (byClass ? !classQboId || (entityType !== "" && entityType !== "customer") : !customerQboId) continue;
    if (!isIncomeAccount(str(d.AccountRef?.value), lookups)) continue;
    const amount = num(line.Amount);
    if (amount === 0) continue;
    out.push({
      lineId: str(line.Id) ?? String(i),
      customerQboId,
      classQboId,
      amount: round2(amount),
      txnDate: qboDate(txn?.TxnDate),
    });
  }
  return out;
}

/**
 * Journal entry lines to an income account that name a customer: a credit
 * adds income, a debit takes it away. (Cost lines on the same entry are
 * read by expenseLines.)
 */
export function journalRevenueLines(txn: any, lookups: Lookups, byClass = false): NormalizedRevenueLine[] {
  const out: NormalizedRevenueLine[] = [];
  const lines: any[] = Array.isArray(txn?.Line) ? txn.Line : [];
  for (const [i, line] of lines.entries()) {
    const d = line?.JournalEntryLineDetail;
    if (!d) continue;
    const entity = d.Entity;
    const entityType = String(entity?.Type ?? "").toLowerCase();
    const customerQboId = entityType === "customer" ? str(entity?.EntityRef?.value) : null;
    const classQboId = str(d.ClassRef?.value);
    if (byClass ? !classQboId || (entityType !== "" && entityType !== "customer") : !customerQboId) continue;
    if (!isIncomeAccount(str(d.AccountRef?.value), lookups)) continue;
    const raw = num(line.Amount);
    if (raw === 0) continue;
    out.push({
      lineId: str(line.Id) ?? String(i),
      customerQboId,
      classQboId,
      amount: round2((d.PostingType === "Credit" ? 1 : -1) * raw),
      txnDate: qboDate(txn?.TxnDate),
    });
  }
  return out;
}

/**
 * Income-account lines on a check, expense, bill or vendor credit that name
 * a job: a refund check to a customer posted to "Refunds and Allowances", say.
 * QuickBooks takes these off the customer's income, so they are revenue here
 * too: negative for money paid out, positive for money coming back (a card
 * credit or a vendor credit). expenseLines leaves them out of cost.
 * Other Income lines are left out, as they are for deposits.
 */
export function expenseRevenueLines(
  txn: any,
  sourceType: "Purchase" | "Bill" | "VendorCredit",
  lookups: Lookups,
  byClass = false
): NormalizedRevenueLine[] {
  const out: NormalizedRevenueLine[] = [];
  const lines: any[] = Array.isArray(txn?.Line) ? txn.Line : [];
  const moneyBack = sourceType === "VendorCredit" || (sourceType === "Purchase" && txn?.Credit === true);
  for (const [i, line] of lines.entries()) {
    const d = line?.AccountBasedExpenseLineDetail;
    if (!d) continue;
    if (!isIncomeAccount(str(d.AccountRef?.value), lookups)) continue;
    const customerQboId = str(d.CustomerRef?.value);
    const classQboId = str(d.ClassRef?.value) ?? str(txn?.ClassRef?.value);
    if (byClass ? !classQboId : !customerQboId) continue;
    const raw = num(line.Amount);
    if (raw === 0) continue;
    out.push({
      lineId: str(line.Id) ?? String(i),
      customerQboId,
      classQboId,
      amount: round2(moneyBack ? raw : -raw),
      txnDate: qboDate(txn?.TxnDate),
    });
  }
  return out;
}

/**
 * Deposit lines that put money back against a cost account for a job: a
 * supplier's refund check deposited to "Job Materials" with the job as the
 * name it was received from (or, for jobs by class, the job's class). They
 * reduce the job's cost, as they do in QuickBooks' report for that customer
 * or class. Payments (lines with a LinkedTxn) and income lines are not cost.
 * Only accounts that can be looked up count: a deposit to an account we
 * can't see is more likely income than a refund.
 */
export function depositCostLines(txn: any, lookups: Lookups): NormalizedCostLine[] {
  const out: NormalizedCostLine[] = [];
  const lines: any[] = Array.isArray(txn?.Line) ? txn.Line : [];
  for (const [i, line] of lines.entries()) {
    if (Array.isArray(line?.LinkedTxn) && line.LinkedTxn.length > 0) continue;
    const d = line?.DepositLineDetail;
    if (!d) continue;
    const accountId = str(d.AccountRef?.value);
    const kind = costAccountKind(accountId, lookups);
    if (kind !== "cost" && kind !== "asset") continue;
    const raw = num(line.Amount);
    if (raw === 0) continue;
    const entity = d.Entity;
    const isCustomer = String(entity?.type ?? entity?.Type ?? "").toLowerCase() === "customer";
    const account = accountId ? lookups.accounts.get(accountId) : undefined;
    const sourceName = str(d.AccountRef?.name) ?? account?.fullName ?? null;
    const { category, isJobCostAccount } = categorizeLine({ sourceName, accountId, itemId: null }, lookups);
    out.push({
      lineId: str(line.Id) ?? String(i),
      customerQboId: isCustomer ? str(entity?.value ?? entity?.EntityRef?.value) : null,
      customerName: isCustomer ? str(entity?.name ?? entity?.EntityRef?.name) : null,
      classQboId: str(d.ClassRef?.value) ?? str(txn?.ClassRef?.value),
      // Money in against a cost: a reduction.
      amount: round2(-raw),
      category,
      accountName: sourceName,
      isJobCostAccount,
      description: str(line.Description),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

export interface EstimateRecord {
  amount: number;
  status: string;
  txnDate: Date;
}

/** One priced line on an estimate, compacted for storage. */
export interface EstimateLine {
  /** Product or service name, or null for a line without one. */
  n: string | null;
  /** Cost category the product or service belongs to. */
  c: CostCategory;
  /** Price quoted to the customer, net of discounts and without tax. */
  a: number;
  /** Quantity on the line (hours, units), when QuickBooks has one. */
  q?: number | null;
  /** The product or service's purchase cost per unit in QuickBooks, when set. */
  u?: number | null;
  /**
   * The price of just the lines counted in q. Lines are merged by product or
   * service, and a lump-sum line (a $4,000 "Labor" line with a quantity of
   * 1) is priced per job, not per unit: it's left out of q and of this, so
   * it can't pass as one cheap hour. Null on lines stored before this was
   * kept.
   */
  qa?: number | null;
}

/** Labor lines count as hours only when their price per unit looks like an hourly rate. */
export const HOURLY_PRICE_MIN = 15;
export const HOURLY_PRICE_MAX = 300;
/**
 * A line priced at more than ten times its item's cost per unit (or under a
 * tenth of it) is a lump sum or a different unit, not that many units: a
 * "Labor" service with a $35 cost used once on a $4,000 line isn't $35 of
 * cost.
 */
export const ITEM_PRICE_RATIO_MAX = 10;
/**
 * Materials and other items priced at more than three times their purchase
 * cost are usually sold installed: shingles costing $110 a square, quoted at
 * $450 a square, carry the labor to put them on. Costing that line at the item cost
 * alone would leave the labor out, so it's left to the past-jobs method.
 * Labor items keep the wider ITEM_PRICE_RATIO_MAX: an hour costing $30 billed
 * at $95 is still an hour.
 */
export const INSTALLED_PRICE_RATIO_MAX = 3;

/**
 * Whether a line's quantity is a count of units its cost can be worked out
 * from: units of an item with a purchase cost, priced near that cost, or
 * labor priced at an hourly rate.
 */
export function isUnitPriced(category: CostCategory, pricePerUnit: number, unitCost: number | null | undefined): boolean {
  if (!(pricePerUnit > 0)) return false;
  if (unitCost != null && unitCost > 0) {
    const ratio = pricePerUnit / unitCost;
    const max = category === "labor" ? ITEM_PRICE_RATIO_MAX : INSTALLED_PRICE_RATIO_MAX;
    return ratio <= max && ratio >= 1 / ITEM_PRICE_RATIO_MAX;
  }
  return category === "labor" && pricePerUnit >= HOURLY_PRICE_MIN && pricePerUnit <= HOURLY_PRICE_MAX;
}

export interface EstimateDetails {
  docNumber: string | null;
  customerName: string | null;
  emailStatus: string | null;
  expirationDate: Date | null;
  lines: EstimateLine[];
}

/**
 * The priced lines on an estimate, each put in the cost category of its
 * product or service by the same rules as cost lines (so a "Framing labor"
 * service is labor, and the contractor's own category mappings apply).
 *
 * Group (bundle) lines are opened up. Discounts, shipping and any other
 * difference between the lines and the total are spread across the lines in
 * proportion, so the lines always add up to the estimate's amount net of tax.
 * Lines with the same name and category are merged.
 */
export function estimateLines(est: any, lookups: Lookups, netTotal: number): EstimateLine[] {
  const raw: { name: string | null; itemId: string | null; amount: number; qty: number }[] = [];
  const walk = (lines: unknown) => {
    if (!Array.isArray(lines)) return;
    for (const line of lines) {
      if (line?.GroupLineDetail) {
        walk(line.GroupLineDetail.Line);
        continue;
      }
      const d = line?.SalesItemLineDetail;
      if (!d) continue; // subtotal, discount, description-only
      const amount = num(line.Amount);
      if (amount === 0) continue;
      raw.push({ name: str(d.ItemRef?.name), itemId: str(d.ItemRef?.value), amount, qty: num(d.Qty) });
    }
  };
  walk(est?.Line);
  const gross = raw.reduce((s, l) => s + l.amount, 0);
  if (gross <= 0 || netTotal <= 0) return [];
  const scale = netTotal / gross;

  const merged = new Map<string, EstimateLine>();
  for (const l of raw) {
    const item = l.itemId ? lookups.items.get(l.itemId) : undefined;
    const itemName = item?.name ?? l.name;
    const { category } = categorizeLine({ sourceName: itemName, accountId: null, itemId: l.itemId }, lookups);
    const unitCost = item?.purchaseCost != null && item.purchaseCost > 0 ? item.purchaseCost : null;
    const key = `${itemName ?? ""}\u0000${category}\u0000${unitCost ?? ""}`;
    const cur = merged.get(key) ?? { n: itemName ?? null, c: category, a: 0, q: 0, u: unitCost, qa: 0 };
    cur.a += l.amount * scale;
    // Judged line by line, before merging: a lump sum merged with hourly
    // lines would otherwise pass as a few more hours.
    if (l.qty > 0 && isUnitPriced(category, l.amount / l.qty, unitCost)) {
      cur.q = (cur.q ?? 0) + l.qty;
      cur.qa = (cur.qa ?? 0) + l.amount * scale;
    }
    merged.set(key, cur);
  }
  return [...merged.values()]
    .map((l) => {
      const counted = l.q != null && l.q > 0 && (l.qa ?? 0) > 0;
      return { ...l, a: round2(l.a), q: counted ? round2(l.q!) : null, qa: counted ? round2(l.qa!) : null };
    })
    .filter((l) => l.a !== 0);
}

/** The class an estimate belongs to: its own, or the class with most of its lines' value. */
function estimateClass(est: any): string | null {
  const own = str(est?.ClassRef?.value);
  if (own) return own;
  const byClass = new Map<string, number>();
  const walk = (lines: unknown) => {
    if (!Array.isArray(lines)) return;
    for (const line of lines) {
      if (line?.GroupLineDetail) {
        walk(line.GroupLineDetail.Line);
        continue;
      }
      const c = str(line?.SalesItemLineDetail?.ClassRef?.value);
      if (c) byClass.set(c, (byClass.get(c) ?? 0) + Math.abs(num(line.Amount)));
    }
  };
  walk(est?.Line);
  let best: string | null = null;
  for (const [c, a] of byClass) if (best == null || a > (byClass.get(best) ?? 0)) best = c;
  return best;
}

export function estimateFromTxn(
  est: any,
  lookups?: Lookups
): { customerQboId: string | null; classQboId: string | null; record: EstimateRecord | null; details: EstimateDetails } {
  const txnDate = qboDate(est?.TxnDate);
  const total = num(est?.TotalAmt) - num(est?.TxnTaxDetail?.TotalTax);
  return {
    customerQboId: str(est?.CustomerRef?.value),
    classQboId: estimateClass(est),
    record: txnDate ? { amount: round2(total), status: str(est?.TxnStatus) ?? "Pending", txnDate } : null,
    details: {
      docNumber: str(est?.DocNumber),
      customerName: str(est?.CustomerRef?.name),
      emailStatus: str(est?.EmailStatus),
      expirationDate: qboDate(est?.ExpirationDate),
      lines: lookups ? estimateLines(est, lookups, round2(total)) : [],
    },
  };
}

/**
 * A job's contract value from all of its estimates.
 *
 * Accepted (and Closed, which is what QuickBooks calls an accepted estimate
 * once it has been invoiced) are summed: the original quote plus any change
 * orders the customer signed. With nothing accepted, the most recent
 * pending estimate stands in. Rejected estimates never count.
 */
export function contractValueFromEstimates(estimates: EstimateRecord[]): number | null {
  const live = estimates.filter((e) => e.status.toLowerCase() !== "rejected" && e.amount > 0);
  if (live.length === 0) return null;
  const accepted = live.filter((e) => ["accepted", "closed", "converted"].includes(e.status.toLowerCase()));
  if (accepted.length > 0) return round2(accepted.reduce((s, e) => s + e.amount, 0));
  const latest = live.reduce((a, b) => (b.txnDate > a.txnDate ? b : a));
  return latest.amount;
}

// ---------------------------------------------------------------------------
// Which customers are jobs
// ---------------------------------------------------------------------------

export type JobSource = "projects" | "customers" | "classes";

/** Jobs from QuickBooks Classes are stored under this prefix, so a class and a customer with the same id never collide. */
export const classJobKey = (classQboId: string) => `class:${classQboId}`;

/**
 * Classes as jobs, for contractors who track each job as a QuickBooks
 * Class. A class with sub-classes is a group, not a job: its sub-classes
 * are the jobs, and it becomes their "customer" for grouping. A cost tagged
 * to the group itself lands on its only sub-class, the same as a
 * parent-customer cost does.
 */
export function selectJobClasses(
  classes: any[],
  /** Class jobs already stored ("class:<id>"): they stay jobs when they gain sub-classes, as customers do. */
  keepIds?: Set<string>
): JobCandidate[] {
  const parents = new Set<string>();
  const nameById = new Map<string, string>();
  for (const c of classes) {
    const p = str(c?.ParentRef?.value);
    if (p) parents.add(p);
    if (c?.Id != null) nameById.set(String(c.Id), String(c.Name ?? ""));
  }
  return classes
    .filter((c) => c?.Id != null && (!parents.has(String(c.Id)) || (keepIds?.has(classJobKey(String(c.Id))) ?? false)))
    .map((c) => {
      const parent = str(c.ParentRef?.value);
      return {
        qboId: classJobKey(String(c.Id)),
        parentQboId: parent ? classJobKey(parent) : null,
        name: String(c.Name ?? c.FullyQualifiedName ?? "Class"),
        customerName: parent ? nameById.get(parent) ?? null : null,
        active: c.Active !== false,
        createdAt: typeof c?.MetaData?.CreateTime === "string" && Number.isFinite(Date.parse(c.MetaData.CreateTime)) ? new Date(c.MetaData.CreateTime) : null,
      };
    });
}

/**
 * QuickBooks renames a customer to "Name (deleted)" when it is made
 * inactive, which is how many contractors mark a job finished. Stripped
 * only from inactive records and only as a trailing suffix.
 */
export function cleanCustomerName(displayName: unknown, active: unknown): string {
  const name = typeof displayName === "string" ? displayName : "";
  if (active === false) return name.replace(/\s*\(deleted\)\s*$/i, "").trim() || name;
  return name;
}

export interface JobCandidate {
  qboId: string;
  parentQboId: string | null;
  name: string;
  customerName: string | null;
  active: boolean;
  createdAt: Date | null;
}

/**
 * Picks the customers that are jobs.
 *
 * "projects": Projects and sub-customers (Customer.Job = true).
 * "customers": every customer with no sub-customers of its own. That covers
 * a contractor who makes one customer per job, and still treats
 * sub-customers as the jobs where a customer does have them.
 */
export function selectJobCustomers(
  customers: any[],
  source: JobSource,
  nameById?: Map<string, string>,
  /**
   * One-customer-per-job mode: customers that are already jobs stay jobs
   * when they gain sub-customers. A repeat client who gets a Project for
   * their second job still has the first job's transactions on the customer
   * itself; dropping it would lose that job and pour its costs into the new
   * project.
   */
  keepIds?: Set<string>
): JobCandidate[] {
  const parents = new Set<string>();
  for (const c of customers) {
    const p = str(c?.ParentRef?.value);
    if (p) parents.add(p);
  }
  const picked = customers.filter((c) =>
    source === "projects"
      ? c?.Job === true
      : c?.Id != null && (!parents.has(String(c.Id)) || (keepIds?.has(String(c.Id)) ?? false))
  );
  return picked
    .filter((c) => c?.Id != null)
    .map((c) => {
      const parentQboId = str(c.ParentRef?.value);
      return {
        qboId: String(c.Id),
        parentQboId,
        name: cleanCustomerName(c.DisplayName, c.Active),
        customerName: (parentQboId ? nameById?.get(parentQboId) : undefined) ?? str(c.ParentRef?.name) ?? null,
        active: c.Active !== false,
        createdAt: typeof c?.MetaData?.CreateTime === "string" && Number.isFinite(Date.parse(c.MetaData.CreateTime)) ? new Date(c.MetaData.CreateTime) : null,
      };
    });
}

// ---------------------------------------------------------------------------
// Matching a transaction's customer to a job
// ---------------------------------------------------------------------------

export interface JobIndex {
  byQboId: Map<string, string>; // QuickBooks customer id -> Job.id
  byParent: Map<string, string[]>; // parent customer id -> Job.ids under it
}

export function buildJobIndex(jobs: { id: string; qboId: string; parentQboId: string | null }[]): JobIndex {
  const byQboId = new Map<string, string>();
  const byParent = new Map<string, string[]>();
  for (const j of jobs) {
    byQboId.set(j.qboId, j.id);
    if (j.parentQboId) byParent.set(j.parentQboId, [...(byParent.get(j.parentQboId) ?? []), j.id]);
  }
  return { byQboId, byParent };
}

/**
 * The job a customer reference belongs to. A direct match first; failing
 * that, the customer's only job when the transaction was tagged to the
 * parent customer. Two or more jobs under that parent is ambiguous and
 * returns null rather than guessing which job a real dollar belongs to.
 */
export function resolveJob(index: JobIndex, customerQboId: string): { jobId: string; method: "direct" | "parent_customer_fallback" } | null {
  const direct = index.byQboId.get(customerQboId);
  if (direct) return { jobId: direct, method: "direct" };
  const children = index.byParent.get(customerQboId);
  if (children && children.length === 1) return { jobId: children[0], method: "parent_customer_fallback" };
  return null;
}

/**
 * Parents (customers or classes) whose costs match a different job once the
 * `added` jobs are stored. A cost tagged to a parent goes on the parent's job
 * only while it has exactly one (see resolveJob), so:
 *
 *  - one job to two or more: costs tagged to the parent were put on its only
 *    job, and now belong to neither;
 *  - no job to exactly one: costs tagged to the parent before its first job
 *    existed matched nothing, and now go on that job.
 *
 * An incremental sync never re-reads those costs, so the company needs a
 * full sync to move them. No job to two at once changes nothing: the costs
 * matched nothing and still don't.
 *
 * `existing` is the stored jobs still in QuickBooks, `added` the jobs this
 * sync read (ones already stored are skipped). `newParents` are parents
 * created since the last sync: every transaction naming one is in this
 * sync's list of changes and is matched against the new jobs anyway.
 */
export function parentsNeedingFullSync(
  existing: { qboId: string; parentQboId: string | null }[],
  added: { qboId: string; parentQboId: string | null }[],
  newParents: ReadonlySet<string> = new Set()
): string[] {
  const before = new Map<string, number>();
  for (const j of existing) if (j.parentQboId) before.set(j.parentQboId, (before.get(j.parentQboId) ?? 0) + 1);
  const known = new Set(existing.map((j) => j.qboId));
  const gained = new Map<string, Set<string>>();
  for (const j of added) {
    if (!j.parentQboId || known.has(j.qboId)) continue;
    gained.set(j.parentQboId, (gained.get(j.parentQboId) ?? new Set()).add(j.qboId));
  }
  const out: string[] = [];
  for (const [parent, jobs] of gained) {
    if (newParents.has(parent)) continue;
    const had = before.get(parent) ?? 0;
    const has = had + jobs.size;
    if ((had === 1 && has >= 2) || (had === 0 && has === 1)) out.push(parent);
  }
  return out;
}

/**
 * The parent customers in a change list that were created at or after
 * `since` (QuickBooks' MetaData.CreateTime). A customer with no readable
 * creation time is treated as older, which at worst costs a full sync.
 */
export function customersCreatedSince(customers: any[], since: Date | null): Set<string> {
  const out = new Set<string>();
  if (!since) return out;
  for (const c of customers) {
    const created = typeof c?.MetaData?.CreateTime === "string" ? Date.parse(c.MetaData.CreateTime) : NaN;
    if (c?.Id != null && Number.isFinite(created) && created >= since.getTime()) out.add(String(c.Id));
  }
  return out;
}
