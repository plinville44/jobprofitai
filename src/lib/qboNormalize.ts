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
 *  - Labor is hours x the employee's PAY rate (TimeActivity.CostRate).
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

export interface NormalizedCostLine {
  lineId: string;
  customerQboId: string | null;
  customerName: string | null;
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
      const accountType = (account?.type ?? "").toLowerCase();
      // Only cost accounts. Income and balance-sheet lines on a journal
      // entry are not job cost.
      if (accountType !== "cost of goods sold" && accountType !== "expense" && accountType !== "other expense") continue;
      const raw = num(line.Amount);
      if (raw === 0) continue;
      const amount = (d.PostingType === "Credit" ? -1 : 1) * raw;
      const sourceName = str(d.AccountRef?.name) ?? account?.fullName ?? null;
      const { category, isJobCostAccount } = categorizeLine({ sourceName, accountId, itemId: null }, lookups);
      out.push({
        lineId: str(line.Id) ?? String(i),
        customerQboId: isCustomer ? str(entity?.EntityRef?.value) : null,
        customerName: isCustomer ? str(entity?.EntityRef?.name) : null,
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
    const itemId = str(item?.ItemRef?.value);
    const sourceName = str(acct?.AccountRef?.name) ?? str(item?.ItemRef?.name);
    const { category, isJobCostAccount } = categorizeLine({ sourceName, accountId, itemId }, lookups);
    out.push({
      lineId: str(line.Id) ?? String(i),
      customerQboId: str(acct?.CustomerRef?.value) ?? str(item?.CustomerRef?.value),
      customerName: str(acct?.CustomerRef?.name) ?? str(item?.CustomerRef?.name),
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

/** Hours on a time entry: Hours + Minutes, or End - Start - break. */
export function timeActivityHours(ta: any): number {
  const direct = num(ta?.Hours) + num(ta?.Minutes) / 60;
  if (direct > 0) return direct;
  const start = typeof ta?.StartTime === "string" ? Date.parse(ta.StartTime) : NaN;
  const end = typeof ta?.EndTime === "string" ? Date.parse(ta.EndTime) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  const breakHours = num(ta?.BreakHours) + num(ta?.BreakMinutes) / 60;
  return Math.max(0, (end - start) / 3_600_000 - breakHours);
}

/**
 * A time entry's cost to the contractor.
 *
 * Only employee time. A vendor's time entry is a subcontractor logging
 * hours, and what the contractor pays them arrives as a bill or expense,
 * which is already synced; costing the hours too would count it twice.
 */
export function timeActivityCost(ta: any): TimeCostResult {
  if (!str(ta?.CustomerRef?.value)) return { kind: "skip", reason: "no_customer" };
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
  };
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
  const raw: { name: string | null; itemId: string | null; amount: number }[] = [];
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
      raw.push({ name: str(d.ItemRef?.name), itemId: str(d.ItemRef?.value), amount });
    }
  };
  walk(est?.Line);
  const gross = raw.reduce((s, l) => s + l.amount, 0);
  if (gross <= 0 || netTotal <= 0) return [];
  const scale = netTotal / gross;

  const merged = new Map<string, EstimateLine>();
  for (const l of raw) {
    const itemName = l.itemId ? lookups.items.get(l.itemId)?.name ?? l.name : l.name;
    const { category } = categorizeLine({ sourceName: itemName, accountId: null, itemId: l.itemId }, lookups);
    const key = `${itemName ?? ""}\u0000${category}`;
    const cur = merged.get(key) ?? { n: itemName ?? null, c: category, a: 0 };
    cur.a += l.amount * scale;
    merged.set(key, cur);
  }
  return [...merged.values()].map((l) => ({ ...l, a: round2(l.a) })).filter((l) => l.a !== 0);
}

export function estimateFromTxn(
  est: any,
  lookups?: Lookups
): { customerQboId: string | null; record: EstimateRecord | null; details: EstimateDetails } {
  const txnDate = qboDate(est?.TxnDate);
  const total = num(est?.TotalAmt) - num(est?.TxnTaxDetail?.TotalTax);
  return {
    customerQboId: str(est?.CustomerRef?.value),
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

export type JobSource = "projects" | "customers";

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
