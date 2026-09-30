import { describe, it, expect, beforeAll, vi } from "vitest";
import { createFakePrisma, FakeModel, type FakePrisma } from "./support/fakePrisma";

// The messy real-world data test, end to end. scripts/seed-messy-scenarios.js
// is run against a pretend QuickBooks that stores what it's sent the way
// QuickBooks' v3 API returns it (ids, names on references, totals, balances,
// MetaData). The company already holds what scripts/seed-test-company.js
// made. Then the REAL full sync reads it all, and the real profit, WIP,
// Money Owed, Data Health and Estimate Check code works out every figure the
// owner's answer key (jp-docs/messy-test/answer-key.json) tells him to look
// for. Company-wide totals are checked as a change from before the seeder
// ran, which is how the answer key gives them.
//
// Where the pretend QuickBooks has to guess at QuickBooks' behaviour (the
// shape of a deposit line's customer, whether a cost rate sent on a time
// entry is kept), it takes the answer the seeder relies on; the seeder's own
// comments mark those "not verified".

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));
vi.mock("@/lib/crypto", () => ({
  encryptToken: (s: string) => s,
  decryptToken: (s: string) => s,
}));
vi.mock("@/lib/entitlements", () => ({ requireFeature: async () => ({ ok: true }) }));

// ---------------------------------------------------------------------------
// A pretend QuickBooks
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const ENTITY_BY_PATH: Record<string, string> = {
  customer: "Customer",
  vendor: "Vendor",
  employee: "Employee",
  account: "Account",
  item: "Item",
  purchase: "Purchase",
  bill: "Bill",
  vendorcredit: "VendorCredit",
  journalentry: "JournalEntry",
  invoice: "Invoice",
  salesreceipt: "SalesReceipt",
  deposit: "Deposit",
  estimate: "Estimate",
  timeactivity: "TimeActivity",
};
const LISTS = new Set(["Customer", "Vendor", "Employee", "Account", "Item"]);

class RefError extends Error {}

class FakeQbo {
  store: Record<string, any[]> = {};
  writes = 0;
  private nextId = 1;
  companyName = "JobProfitAI Test Co.";

  rows(entity: string): any[] {
    return (this.store[entity] ??= []);
  }

  find(entity: string, id: unknown): any {
    return this.rows(entity).find((r) => r.Id === String(id));
  }

  /** A reference QuickBooks can resolve, with its name filled in as QuickBooks returns it. */
  private ref(ref: any, entities: string[]): any {
    if (ref?.value == null) return ref;
    for (const e of entities) {
      const hit = this.find(e, ref.value);
      if (hit) return { ...ref, value: String(ref.value), name: hit.FullyQualifiedName ?? hit.DisplayName ?? hit.Name };
    }
    throw new RefError(`Invalid Reference Id: ${entities.join(" or ")} ${ref.value} not found`);
  }

  create(entity: string, payload: any): any {
    const now = new Date().toISOString();
    const rec: any = JSON.parse(JSON.stringify(payload));
    rec.Id = String(this.nextId++);
    rec.SyncToken = "0";
    rec.MetaData = { CreateTime: now, LastUpdatedTime: now };
    const acct = (r: any) => this.ref(r, ["Account"]);
    const cust = (r: any) => this.ref(r, ["Customer"]);

    if (LISTS.has(entity)) {
      rec.Active = rec.Active ?? true;
      if (entity === "Customer") {
        rec.Job = rec.Job === true;
        if (rec.ParentRef) {
          rec.ParentRef = cust(rec.ParentRef);
          rec.FullyQualifiedName = `${rec.ParentRef.name}:${rec.DisplayName}`;
        } else rec.FullyQualifiedName = rec.DisplayName;
      }
      if (entity === "Account") rec.FullyQualifiedName = rec.Name;
      if (entity === "Item") {
        rec.FullyQualifiedName = rec.Name;
        if (rec.IncomeAccountRef) rec.IncomeAccountRef = acct(rec.IncomeAccountRef);
        if (rec.ExpenseAccountRef) rec.ExpenseAccountRef = acct(rec.ExpenseAccountRef);
      }
    } else {
      if (rec.CustomerRef) rec.CustomerRef = cust(rec.CustomerRef);
      if (rec.VendorRef) rec.VendorRef = this.ref(rec.VendorRef, ["Vendor"]);
      if (rec.EmployeeRef) rec.EmployeeRef = this.ref(rec.EmployeeRef, ["Employee"]);
      if (rec.ItemRef) rec.ItemRef = this.ref(rec.ItemRef, ["Item"]);
      if (rec.AccountRef) rec.AccountRef = acct(rec.AccountRef);
      if (rec.DepositToAccountRef) rec.DepositToAccountRef = acct(rec.DepositToAccountRef);
      if (rec.EntityRef) rec.EntityRef = { ...this.ref(rec.EntityRef, [rec.EntityRef.type ?? "Vendor"]), type: rec.EntityRef.type };
      let total = 0;
      const lines: any[] = rec.Line ?? [];
      lines.forEach((l, i) => {
        l.Id = String(i + 1);
        const a = l.AccountBasedExpenseLineDetail;
        if (a) {
          a.AccountRef = acct(a.AccountRef);
          if (a.CustomerRef) a.CustomerRef = cust(a.CustomerRef);
        }
        const s = l.SalesItemLineDetail;
        if (s) s.ItemRef = this.ref(s.ItemRef, ["Item"]);
        const j = l.JournalEntryLineDetail;
        if (j) {
          j.AccountRef = acct(j.AccountRef);
          if (j.Entity?.EntityRef) j.Entity = { Type: j.Entity.Type, EntityRef: cust(j.Entity.EntityRef) };
        }
        const d = l.DepositLineDetail;
        if (d) {
          d.AccountRef = acct(d.AccountRef);
          if (d.Entity) d.Entity = { ...this.ref(d.Entity, [d.Entity.type ?? "Customer"]), type: d.Entity.type };
        }
        total += l.DiscountLineDetail ? -Number(l.Amount) : Number(l.Amount);
      });
      if (entity === "JournalEntry") {
        const debit = lines.filter((l) => l.JournalEntryLineDetail?.PostingType === "Debit").reduce((s, l) => s + l.Amount, 0);
        const credit = lines.filter((l) => l.JournalEntryLineDetail?.PostingType === "Credit").reduce((s, l) => s + l.Amount, 0);
        if (Math.abs(debit - credit) > 0.005) throw new RefError("Journal Entry must be balanced");
        total = debit;
      }
      if (entity === "Purchase") rec.Credit = rec.Credit ?? false;
      rec.TotalAmt = Math.round(total * 100) / 100;
      if (["Invoice", "SalesReceipt", "Estimate"].includes(entity)) {
        rec.TxnTaxDetail = { TotalTax: 0 };
        rec.DocNumber = rec.DocNumber ?? String(1000 + this.nextId);
        // A subtotal line, as QuickBooks adds to every sales form.
        rec.Line.push({ Amount: rec.TotalAmt, DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} });
      }
      if (entity === "Invoice") {
        rec.Balance = rec.TotalAmt;
        rec.DueDate = rec.DueDate ?? rec.TxnDate;
      }
      if (entity === "SalesReceipt") rec.Balance = 0;
      if (entity === "Estimate") {
        rec.TxnStatus = rec.TxnStatus ?? "Pending";
        rec.EmailStatus = "NotSet";
      }
    }
    this.rows(entity).push(rec);
    this.writes++;
    return rec;
  }

  /** The seeder's fetch: queries (every row; the seeder filters them itself), company info, and creates. */
  fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v3\/company\/[^/]+/, "");
    const reply = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
    if (path.startsWith("/companyinfo/")) return reply(200, { CompanyInfo: { CompanyName: this.companyName } });
    if (path === "/query") {
      const q = u.searchParams.get("query") ?? "";
      const entity = /FROM\s+(\w+)/i.exec(q)?.[1] ?? "";
      const start = Number(/STARTPOSITION\s+(\d+)/i.exec(q)?.[1] ?? 1);
      const max = Number(/MAXRESULTS\s+(\d+)/i.exec(q)?.[1] ?? 100);
      const rows = this.rows(entity).slice(start - 1, start - 1 + max);
      return reply(200, { QueryResponse: rows.length ? { [entity]: rows, startPosition: start, maxResults: rows.length } : {} });
    }
    const entity = ENTITY_BY_PATH[path.slice(1)];
    if (init.method !== "POST" || !entity) return reply(400, { Fault: { Error: [{ Message: "Unsupported request", Detail: path }] } });
    try {
      return reply(200, { [entity]: this.create(entity, JSON.parse(init.body ?? "{}")) });
    } catch (err) {
      if (err instanceof RefError) return reply(400, { Fault: { Error: [{ Message: "Object Not Found", Detail: err.message }], type: "ValidationFault" } });
      throw err;
    }
  };
}

const qb = new FakeQbo();

vi.mock("@/lib/quickbooks", () => ({
  qboQueryAll: async (_realm: string, _token: string, _query: string, entity: string) => qb.rows(entity),
  qboQuery: async (_realm: string, _token: string, query: string) => {
    const entity = /FROM\s+(\w+)/i.exec(query)?.[1] ?? "";
    return { QueryResponse: { totalCount: qb.rows(entity).length } };
  },
  qboCompanyInfo: async () => ({ CompanyInfo: { CompanyName: qb.companyName } }),
  qboCdc: async () => {
    throw new Error("not expected: every sync here is Sync now, a full sync");
  },
  refreshTokens: async () => {
    throw new Error("not expected");
  },
  needsReconnect: () => false,
}));

import { runSyncForConnection, SYNC_VERSION } from "../quickbooksSync";
import {
  getConnectionProfitData,
  getJobProfitData,
  type ConnectionProfitData,
  type JobProfitData,
} from "../profitability";
import { buildWipSchedule, NOT_SCHEDULED_NEED_TEXT, type WipSchedule } from "../wipSchedule";
import { computeMoneyOwed, type MoneyOwed } from "../moneyOwed";
import { loadUntaggedCosts } from "../untaggedCostStore";
import { getOpportunityData, type CheckedEstimate } from "../opportunityData";
import { resolveDateRange } from "../dateRange";
import { formatCurrency, formatPct } from "../format";

// ---------------------------------------------------------------------------
// The company as scripts/seed-test-company.js left it
// ---------------------------------------------------------------------------

/** A QuickBooks date n days before now, as the seeders write them (UTC). */
const dayStr = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
/** The same date as the sync stores it. */
const dayDate = (n: number) => new Date(`${dayStr(n)}T00:00:00Z`);

// The first seeder ran a few days before this one.
const EARLIER = 5;

function seedFirstCompany() {
  const acct = (Name: string, AccountType: string, AccountSubType: string) => qb.create("Account", { Name, AccountType, AccountSubType }).Id;
  const checking = acct("Checking", "Bank", "Checking");
  acct("Accounts Receivable (A/R)", "Accounts Receivable", "AccountsReceivable");
  acct("Undeposited Funds", "Other Current Asset", "UndepositedFunds");
  const services = acct("Services", "Income", "ServiceFeeIncome");
  const materials = acct("Job materials", "Cost of Goods Sold", "SuppliesMaterialsCogs");
  const subs = acct("Subcontractors", "Cost of Goods Sold", "OtherCostsOfServiceCos");
  const equipment = acct("Job equipment rental", "Cost of Goods Sold", "EquipmentRentalCos");
  const labor = acct("Direct job labor", "Cost of Goods Sold", "CostOfLaborCos");
  const permits = acct("Job permits and inspections", "Cost of Goods Sold", "OtherCostsOfServiceCos");
  acct("Office supplies & software", "Expense", "OfficeGeneralAdministrativeExpenses");
  const accounts: Record<string, string> = { materials, subs, equipment, labor, permits };

  const supply = qb.create("Vendor", { DisplayName: "Coastal Supply Co" }).Id;
  const subsVendor = qb.create("Vendor", { DisplayName: "Delgado Tile and Stone" }).Id;
  const crew = qb.create("Vendor", { DisplayName: "Field Crew Payroll" }).Id;
  const service = qb.create("Item", { Name: "Construction services", Type: "Service", IncomeAccountRef: { value: services } }).Id;

  const parents: Record<string, string> = {};
  for (const p of ["Elena Ruiz", "Harborview Properties", "Miguel Torres"]) parents[p] = qb.create("Customer", { DisplayName: p }).Id;
  const jobs: Record<string, { id: string; name: string; close: boolean }> = {};
  const addJob = (key: string, name: string, parent: string, close: boolean) => {
    jobs[key] = { id: qb.create("Customer", { DisplayName: name, ParentRef: { value: parents[parent] }, Job: true }).Id, name, close };
  };
  addJob("j1", "Torres Kitchen Remodel", "Miguel Torres", true);
  addJob("j2", "Ruiz Kitchen Remodel", "Elena Ruiz", true);
  addJob("j3", "Harborview Unit 3 Kitchen", "Harborview Properties", true);
  addJob("j4", "Harborview Roof Replacement", "Harborview Properties", true);
  addJob("j5", "Torres Bath Remodel", "Miguel Torres", false);
  addJob("j6", "Ruiz Deck Build", "Elena Ruiz", true);
  addJob("j7", "Harborview Unit 5 Punchlist", "Harborview Properties", true);

  const sale = (amount: number) => [{ Amount: amount, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: service }, Qty: 1, UnitPrice: amount } }];
  const cost = (amount: number, account: string, customer: string | null) => [
    { Amount: amount, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: accounts[account] }, ...(customer ? { CustomerRef: { value: customer } } : {}) } },
  ];
  // The estimates the owner typed in by hand: five jobs have one.
  for (const [job, amount, status] of [["j1", 42000, "Closed"], ["j2", 28500, "Closed"], ["j3", 19800, "Closed"], ["j4", 16400, "Closed"], ["j5", 24000, "Accepted"]] as const) {
    qb.create("Estimate", { CustomerRef: { value: jobs[job].id }, TxnDate: dayStr(120), TxnStatus: status, Line: sale(amount) });
  }
  const invoices: [string, number, number][] = [["j1", 42000, 40], ["j2", 28500, 55], ["j3", 19800, 70], ["j4", 16400, 85], ["j5", 9000, 12], ["j6", 11200, 100], ["j7", 2400, 30]];
  for (const [job, amount, d] of invoices) {
    const inv = qb.create("Invoice", { CustomerRef: { value: jobs[job].id }, TxnDate: dayStr(d + EARLIER), DueDate: dayStr(d + EARLIER - 30), Line: sale(amount), PrivateNote: `jpai-seed:invoice:${job}` });
    // The --close step paid the six finished jobs' invoices.
    if (jobs[job].close) inv.Balance = 0;
  }
  const expenses: [string | null, string, number, number][] = [
    ["j1", "materials", 14200, 60], ["j1", "labor", 6400, 50], ["j2", "materials", 9900, 75], ["j2", "equipment", 1450, 70],
    ["j2", "labor", 6000, 65], ["j3", "materials", 7300, 90], ["j4", "materials", 6100, 105], ["j5", "materials", 5400, 25],
    ["j5", "labor", 2080, 18], ["j6", "materials", 4800, 115], ["j6", "labor", 2200, 110], [null, "permits", 850, 20],
  ];
  for (const [job, account, amount, d] of expenses) {
    qb.create("Purchase", {
      PaymentType: "Cash", AccountRef: { value: checking }, EntityRef: { value: supply, type: "Vendor" }, TxnDate: dayStr(d + EARLIER),
      Line: cost(amount, account, job ? jobs[job].id : null),
    });
  }
  // Tagged to a parent with three jobs: unresolved.
  qb.create("Purchase", {
    PaymentType: "Cash", AccountRef: { value: checking }, EntityRef: { value: supply, type: "Vendor" }, TxnDate: dayStr(35 + EARLIER),
    Line: cost(600, "materials", parents["Harborview Properties"]),
  });
  for (const [job, amount, d] of [["j1", 9800, 45], ["j3", 4100, 88], ["j4", 2900, 100]] as const) {
    qb.create("Bill", { VendorRef: { value: subsVendor }, TxnDate: dayStr(d + EARLIER), Line: cost(amount, "subs", jobs[job].id) });
  }
  // Booked against a vendor: a subcontractor's hours, never costed as labor.
  qb.create("TimeActivity", { TxnDate: dayStr(22 + EARLIER), NameOf: "Vendor", VendorRef: { value: crew }, CustomerRef: { value: jobs.j5.id }, Hours: 8, Minutes: 0, HourlyRate: 65, BillableStatus: "Billable" });
  qb.create("TimeActivity", { TxnDate: dayStr(21 + EARLIER), NameOf: "Vendor", VendorRef: { value: crew }, CustomerRef: { value: jobs.j5.id }, Hours: 4, Minutes: 0, BillableStatus: "NotBillable" });
  // Finished jobs are inactive, and QuickBooks renames them "(deleted)".
  for (const j of Object.values(jobs)) {
    if (!j.close) continue;
    const c = qb.find("Customer", j.id);
    c.Active = false;
    c.DisplayName = `${j.name} (deleted)`;
  }
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

function resetDb() {
  fake.client = createFakePrisma();
  const c = fake.client as any;
  c.syncRun = new FakeModel("syncRun", [], () => ({ startedAt: new Date() }));
  c.costEntry = new FakeModel("costEntry");
  c.invoiceSummary = new FakeModel("invoiceSummary");
  c.categoryMapping = new FakeModel("categoryMapping");
  c.jobEstimate = new FakeModel("jobEstimate", [], () => ({ jobType: null }));
  c.untaggedCost = new FakeModel("untaggedCost");
  c.weeklyDigest = new FakeModel("weeklyDigest");
  c.jobType = new FakeModel("jobType");
  c.job = new FakeModel("job", [], () => ({
    estimatedRevenue: null, estimatedCost: null, estimatedCostSource: "manual", manualContractValue: null, percentCompleteOverride: null,
    category: null, statusOverride: null, missingSince: null, startDate: null, endDate: null, createdAt: new Date(), updatedAt: new Date(),
  }));

  // Relations the pages load with `include`, which the shared fake leaves to each test.
  const job: any = c.job;
  const baseFindMany = job.findMany.bind(job);
  const baseFindUnique = job.findUnique.bind(job);
  const related = async (row: any, include: any) => {
    if (!row || !include) return row;
    const out = { ...row };
    const newestFirst = (a: any, b: any) => b.txnDate.getTime() - a.txnDate.getTime();
    if (include.costEntries) out.costEntries = c.costEntry.rows.filter((r: any) => r.jobId === row.id).map((r: any) => ({ ...r })).sort(newestFirst);
    if (include.invoices) out.invoices = c.invoiceSummary.rows.filter((r: any) => r.jobId === row.id).map((r: any) => ({ ...r })).sort(newestFirst);
    if (include.connection) out.connection = { ...(await c.quickBooksConnection.findUnique({ where: { id: row.connectionId } })), marginTargets: [] };
    return out;
  };
  job.findMany = async (args: any = {}) => Promise.all((await baseFindMany(args)).map((r: any) => related(r, args.include)));
  job.findUnique = async (args: any) => related(await baseFindUnique(args), args.include);

  const conn: any = c.quickBooksConnection;
  for (const m of ["findUnique", "findUniqueOrThrow"]) {
    const base = conn[m].bind(conn);
    conn[m] = async (args: any) => {
      const row = await base(args);
      if (row && (args.include?.marginTargets || args.select?.marginTargets)) row.marginTargets = [];
      return row;
    };
  }
  c.costEntry.aggregate = async ({ where, _sum }: any) => {
    const rows = await c.costEntry.findMany({ where });
    const sum: Record<string, number> = {};
    for (const k of Object.keys(_sum ?? {})) sum[k] = rows.reduce((s: number, r: any) => s + Number(r[k] ?? 0), 0);
    return { _sum: sum };
  };
}

async function addConnection() {
  const earlier = new Date(Date.now() - 3 * DAY);
  await fake.client.quickBooksConnection.create({
    data: {
      id: "c1", userId: "u1", realmId: "realm", realmIdHash: "h1", accessToken: "token", refreshToken: "refresh",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000), companyName: "JobProfitAI Test Co.", environment: "production",
      emailTimezone: "America/Los_Angeles", jobSource: "projects", jobSourceConfirmedAt: new Date(Date.now() - 30 * DAY),
      laborFromTimeEntries: true, laborBurdenPct: 20, laborBurdenSetAt: new Date(Date.now() - 10 * DAY), targetMarginPct: 20,
      overheadEnabled: false, overheadMethod: null, overheadValue: null, syncVersion: SYNC_VERSION, lastFullSyncAt: earlier,
      lastSyncedAt: earlier, lastSyncAttemptAt: earlier, lastSyncStatus: "success", lastSyncError: null, rebuildRequestedAt: null,
      basisChangedAt: null, fullSyncContinueAt: null, fullSyncCutShortAt: null, alertsBaselinedAt: earlier, marginTargets: [],
    },
  });
}

/** Sync now: a full sync, as the button runs it. */
async function syncNow() {
  const r = await runSyncForConnection("c1", { forceFull: true });
  expect(r.partialErrors).toBeUndefined();
  return r;
}

const jobRows = () => (fake.client as any).job.rows as any[];
const jobByName = (name: string) => {
  const j = jobRows().find((r) => r.name === name);
  if (!j) throw new Error(`No job named ${name}`);
  return j;
};

// ---------------------------------------------------------------------------
// What each page works out, the way the page itself does it
// ---------------------------------------------------------------------------

interface Snapshot {
  dashboard: ConnectionProfitData;
  wipData: ConnectionProfitData;
  wip: WipSchedule;
  owed: MoneyOwed;
  health: ConnectionProfitData["dataHealth"];
  untagged: Awaited<ReturnType<typeof loadUntaggedCosts>>;
}

async function snapshot(): Promise<Snapshot> {
  const now = new Date();
  const filled = new Set(jobRows().filter((j) => j.estimatedCostSource === "target_margin").map((j) => j.id));
  // Profit Dashboard: the Active tab over the last 12 months, its defaults.
  const dashboard = await getConnectionProfitData("c1", now, { dateRange: resolveDateRange(undefined, undefined, undefined, now, "America/Los_Angeles").range, statusFilter: "open" });
  // WIP page.
  const wipData = await getConnectionProfitData("c1", now, { statusFilter: "open" });
  const wip = buildWipSchedule(wipData.lifetimeJobs, now, filled);
  // Money Owed page: the same open invoices its query reads.
  const all = await getConnectionProfitData("c1", now);
  const jobs = new Map(jobRows().map((j) => [j.id, j]));
  const openInvoices = ((fake.client as any).invoiceSummary.rows as any[])
    .filter((i) => i.status === "open" && i.openBalance != null && Number(i.openBalance) > 0 && jobs.get(i.jobId)?.missingSince == null)
    .map((i) => ({
      jobId: i.jobId, jobName: jobs.get(i.jobId).name, customerName: jobs.get(i.jobId).customerName, qboInvoiceId: i.qboInvoiceId,
      docNumber: i.docNumber, txnDate: i.txnDate, dueDate: i.dueDate, openBalance: Number(i.openBalance),
    }));
  const owed = computeMoneyOwed({ now, openInvoices, jobs: all.lifetimeJobs, targetFilledEstimates: filled });
  // Data Health page.
  const untagged = await loadUntaggedCosts("c1", now, 50);
  return { dashboard, wipData, wip, owed, health: all.dataHealth, untagged };
}

const JOB_NAMES = [
  "MX01 Early Materials", "MX02 Past Estimate", "MX03 Billed Past Contract", "MX04 Expected Loss", "MX05 Overdue Invoice", "MX06 Idle Job",
  "MX07 Parent Match", "MX08 Refund Check", "MX09 Supplier Refund", "MX10 Construction in Progress", "MX11 Inventory Relief",
  "MX12 Deposit Income", "MX13 Journal Income", "MX14 Vendor Credit", "MX15 Discount Invoice", "MX16 Duplicate Expenses", "MX17 Crew Time",
];

// The answer key's job-by-job figures: revenue, actual cost (labor burden
// included), gross profit and margin, as the job page shows them.
const EXPECTED: Record<string, { revenue: number; cost: number; profit: number; margin: string }> = {
  "MX01 Early Materials": { revenue: 6000, cost: 18000, profit: -12000, margin: "-200.0%" },
  "MX02 Past Estimate": { revenue: 24000, cost: 34000, profit: -10000, margin: "-41.7%" },
  "MX03 Billed Past Contract": { revenue: 33500, cost: 21000, profit: 12500, margin: "37.3%" },
  "MX04 Expected Loss": { revenue: 25000, cost: 30000, profit: -5000, margin: "-20.0%" },
  "MX05 Overdue Invoice": { revenue: 8000, cost: 3000, profit: 5000, margin: "62.5%" },
  "MX06 Idle Job": { revenue: 10000, cost: 7000, profit: 3000, margin: "30.0%" },
  "MX07 Parent Match": { revenue: 2500, cost: 800, profit: 1700, margin: "68.0%" },
  "MX08 Refund Check": { revenue: 5500, cost: 2000, profit: 3500, margin: "63.6%" },
  "MX09 Supplier Refund": { revenue: 5000, cost: 1500, profit: 3500, margin: "70.0%" },
  "MX10 Construction in Progress": { revenue: 15000, cost: 10000, profit: 5000, margin: "33.3%" },
  "MX11 Inventory Relief": { revenue: 4000, cost: 1200, profit: 2800, margin: "70.0%" },
  "MX12 Deposit Income": { revenue: 3000, cost: 1000, profit: 2000, margin: "66.7%" },
  "MX13 Journal Income": { revenue: 2500, cost: 700, profit: 1800, margin: "72.0%" },
  "MX14 Vendor Credit": { revenue: 4500, cost: 1850, profit: 2650, margin: "58.9%" },
  "MX15 Discount Invoice": { revenue: 4750, cost: 1500, profit: 3250, margin: "68.4%" },
  "MX16 Duplicate Expenses": { revenue: 3000, cost: 1280, profit: 1720, margin: "57.3%" },
  "MX17 Crew Time": { revenue: 4000, cost: 2880, profit: 1120, margin: "28.0%" },
};

// Cost estimates the owner types into Job Details (QuickBooks has no field
// JobProfitAI can read them from).
const TYPED_ESTIMATES: Record<string, number> = {
  "MX01 Early Materials": 45000,
  "MX02 Past Estimate": 30000,
  "MX03 Billed Past Contract": 24000,
  "MX04 Expected Loss": 60000,
  "MX06 Idle Job": 16000,
};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const seeder = { mod: null as any };
let before: Snapshot;
let after: Snapshot;
let firstRun: any;
let dryRun: any;
let secondRun: any;
let writesBeforeDryRun = 0;
let writesAfterDryRun = 0;
const pages = new Map<string, JobProfitData>();
let estimates: CheckedEstimate[] = [];
let estimatesUntyped: CheckedEstimate[] = [];
let feedTitles: string[] = [];
const quiet = () => {};

describe("messy real-world data, seeded and synced", () => {
  beforeAll(async () => {
    resetDb();
    seedFirstCompany();
    await addConnection();
    await syncNow();
    // The owner set job type Remodel on the three finished kitchen jobs.
    for (const name of ["Torres Kitchen Remodel", "Ruiz Kitchen Remodel", "Harborview Unit 3 Kitchen"]) jobByName(name).category = "remodel";
    before = await snapshot();

    const imported: any = await import("../../../scripts/seed-messy-scenarios.js");
    seeder.mod = imported.run ? imported : imported.default;
    const opts = { token: "t", realm: "realm", fetchImpl: qb.fetch, log: quiet };
    writesBeforeDryRun = qb.writes;
    dryRun = await seeder.mod.run({ ...opts, dryRun: true });
    writesAfterDryRun = qb.writes;
    firstRun = await seeder.mod.run(opts);
    secondRun = await seeder.mod.run(opts);

    // The owner's steps in JobProfitAI after Sync now: cost estimates in Job
    // Details, and job type Remodel on two estimates on the Estimate Check.
    await syncNow();
    for (const [name, amount] of Object.entries(TYPED_ESTIMATES)) Object.assign(jobByName(name), { estimatedCost: amount, estimatedCostSource: "manual" });
    estimatesUntyped = (await getOpportunityData("c1", new Date())).estimates;
    for (const e of (fake.client as any).jobEstimate.rows as any[]) if (e.docNumber === "MX-E1" || e.docNumber === "MX-E3") e.jobType = "remodel";

    after = await snapshot();
    for (const name of JOB_NAMES) pages.set(name, (await getJobProfitData(jobByName(name).id, new Date()))!);
    const opp = await getOpportunityData("c1", new Date());
    estimates = opp.estimates;
    feedTitles = opp.feed.items.map((i) => i.title);
  });

  const page = (name: string) => pages.get(name)!;
  const delta = (pick: (s: Snapshot) => number) => Math.round((pick(after) - pick(before)) * 100) / 100;

  describe("the seeder", () => {
    it("writes nothing on a dry run, and says what it would create", () => {
      expect(writesAfterDryRun).toBe(writesBeforeDryRun);
      expect(dryRun.failed).toEqual([]);
      expect(dryRun.created).toBe(firstRun.created);
    });

    it("creates every scenario without a failure or a warning", () => {
      expect(firstRun.failed).toEqual([]);
      expect(firstRun.warnings).toEqual([]);
      // 4 parents, 17 jobs, 2 employees, 2 products, and the Office supplies
      // account is found: Construction in Progress, Inventory Asset and
      // Refunds and Allowances are created.
      expect(qb.rows("Customer").filter((c) => /\(test\)$|^MX\d\d /.test(c.DisplayName))).toHaveLength(21);
      expect(qb.rows("Account").map((a) => a.Name)).toEqual(expect.arrayContaining(["Construction in Progress", "Inventory Asset", "Refunds and Allowances"]));
      expect(firstRun.created).toBe(21 + 2 + 2 + 3 + 61);
    });

    it("skips everything on a second run", () => {
      expect(secondRun.failed).toEqual([]);
      expect(secondRun.created).toBe(0);
      expect(secondRun.skipped).toBe(61);
    });

    it("stops a live run on a company without 'test' in its name", async () => {
      qb.companyName = "Real Builders LLC";
      const writes = qb.writes;
      const r = await seeder.mod.run({ token: "t", realm: "realm", fetchImpl: qb.fetch, log: quiet });
      qb.companyName = "JobProfitAI Test Co.";
      expect(r.failed.map((f: any) => f.scenario)).toEqual(["safety check"]);
      expect(qb.writes).toBe(writes);
    });
  });

  describe("reading costs and revenue, job by job", () => {
    it("shows each job's revenue, actual cost, gross profit and margin", () => {
      for (const [name, x] of Object.entries(EXPECTED)) {
        const f = page(name).financials;
        expect({ name, revenue: f.revenue, cost: Math.round(f.costs * 100) / 100, profit: Math.round(f.grossProfit! * 100) / 100, margin: formatPct(f.grossMarginPct) }).toEqual({ name, ...x });
      }
    });

    it("puts a cost on a parent with one job onto that job", () => {
      const rows = (fake.client as any).costEntry.rows.filter((r: any) => r.jobId === jobByName("MX07 Parent Match").id);
      expect(rows.map((r: any) => [Number(r.amount), r.attributionMethod])).toEqual([[800, "parent_customer_fallback"]]);
    });

    it("takes a refund check to the customer off revenue", () => {
      const p = page("MX08 Refund Check");
      expect(p.rawInvoices.map((i) => [i.qboSourceType, i.amount]).sort()).toEqual([["Purchase", -500], ["SalesReceipt", 6000]]);
      expect(p.rawCostEntries.map((c) => c.amount)).toEqual([2000]);
    });

    it("takes a supplier refund deposited to a cost account off cost", () => {
      const p = page("MX09 Supplier Refund");
      expect(p.rawCostEntries.map((c) => [c.qboSourceType, c.amount])).toEqual([["Deposit", -300], ["Bill", 1800]]);
    });

    it("counts a Construction in Progress bill once after the closing journal entry", () => {
      const p = page("MX10 Construction in Progress");
      expect(p.rawCostEntries.map((c) => [c.qboSourceType, c.amount]).sort()).toEqual([["Bill", 10000], ["JournalEntry", -10000], ["JournalEntry", 10000]]);
      // Cost Breakdown shows Subcontractors only: the Construction in Progress lines cancel out.
      expect(p.financials.costByCategory).toEqual({ subcontractor: 10000 });
    });

    it("counts inventory used on a job once", () => {
      expect(page("MX11 Inventory Relief").rawCostEntries.map((c) => [c.qboSourceType, c.amount, c.category])).toEqual([["JournalEntry", 1200, "materials"]]);
    });

    it("counts a deposit and a journal entry to income as revenue", () => {
      expect(page("MX12 Deposit Income").rawInvoices.map((i) => [i.qboSourceType, i.amount])).toEqual([["Deposit", 3000]]);
      expect(page("MX13 Journal Income").rawInvoices.map((i) => [i.qboSourceType, i.amount])).toEqual([["JournalEntry", 2500]]);
    });

    it("takes a vendor credit off cost", () => {
      expect(page("MX14 Vendor Credit").rawCostEntries.map((c) => [c.qboSourceType, c.amount])).toEqual([["VendorCredit", -350], ["Bill", 2200]]);
    });

    it("counts an invoice net of its discount", () => {
      const inv = page("MX15 Discount Invoice").rawInvoices;
      expect(inv.map((i) => [i.qboSourceType, i.status, i.amount])).toEqual([["Invoice", "open", 4750]]);
    });

    it("flags two identical expenses as a possible duplicate", () => {
      expect(page("MX16 Duplicate Expenses").possibleDuplicates).toEqual([{ jobId: jobByName("MX16 Duplicate Expenses").id, jobName: "MX16 Duplicate Expenses", amount: 640, date: dayStr(7) }]);
    });

    it("costs hours at the cost rate plus the 20% burden, and leaves hours with no rate out", () => {
      const p = page("MX17 Crew Time");
      const time = p.rawCostEntries.filter((c) => c.qboSourceType === "TimeActivity");
      expect(time.map((c) => Math.round(c.amount * 100) / 100)).toEqual([576, 576, 576, 576, 576]);
      expect(p.laborBurden).toBe(0.2);
    });
  });

  describe("Data Health", () => {
    it("lists the three untagged job costs biggest first, above the first seeder's $850, and not the office supplies", () => {
      const rows = after.untagged.rows.map((r) => [r.amount, r.kind, r.payee, r.accountName]);
      expect(rows.slice(0, 4)).toEqual([
        [3200, "bill", "Delgado Tile and Stone", "Subcontractors"],
        [1900, "expense", "Coastal Supply Co", "Job materials"],
        [960, "check", "Coastal Supply Co", "Job equipment rental"],
        [850, "expense", "Coastal Supply Co", "Job permits and inspections"],
      ]);
      expect(after.untagged.rows.some((r) => r.amount === 230)).toBe(false);
      expect(delta((s) => s.untagged.total)).toBe(3);
    });

    it("moves each count by what the seeder added", () => {
      const h = (k: keyof Snapshot["health"]) => delta((s) => Number(s.health[k] ?? 0));
      expect(h("untaggedJobCostCount")).toBe(3);
      expect(h("untaggedJobCostAmount")).toBe(6060);
      expect(h("unresolvedExpenseCount")).toBe(1);
      expect(h("unresolvedExpenseAmount")).toBe(450);
      expect(h("costsMatchedViaParentCount")).toBe(1);
      expect(h("costsMatchedViaParentAmount")).toBe(800);
      expect(h("timeEntriesWithoutPayRate")).toBe(1);
      expect(h("untaggedOverheadCount")).toBe(1);
      expect(h("untaggedOverheadAmount")).toBe(230);
      expect(h("totalJobs")).toBe(17);
      expect(h("jobsWithEnoughData")).toBe(17);
      expect(h("jobsMissingData")).toBe(0);
    });

    it("names the new jobs in the right lists", () => {
      const added = <T extends { jobName: string }>(pick: (s: Snapshot) => T[]) => {
        const had = new Set(pick(before).map((x) => x.jobName));
        return pick(after).filter((x) => !had.has(x.jobName));
      };
      expect(added((s) => s.health.possibleDuplicates)).toEqual([expect.objectContaining({ jobName: "MX16 Duplicate Expenses", amount: 640, date: dayStr(7) })]);
      expect(added((s) => s.health.idleOpenJobs)).toEqual([expect.objectContaining({ jobName: "MX06 Idle Job", daysSinceActivity: 160 })]);
      expect(added((s) => s.health.staleJobs)).toEqual([expect.objectContaining({ jobName: "MX06 Idle Job", daysSinceActivity: 160 })]);
      expect(added((s) => s.health.jobsMissingEstimates).map((j) => j.jobName).sort()).toEqual(
        JOB_NAMES.filter((n) => !(n in TYPED_ESTIMATES) && n !== "MX01 Early Materials").sort()
      );
      expect(added((s) => s.health.jobsWithoutEnoughData)).toEqual([]);
      expect(added((s) => s.health.jobsMissingCosts)).toEqual([]);
      expect(added((s) => s.health.jobsWithDoubleLabor)).toEqual([]);
    });
  });

  describe("Work in Progress", () => {
    const row = (name: string) => after.wip.inProgress.find((r) => r.jobName === name);

    it("schedules materials bought early by cost to date, with no forecast warning", () => {
      expect(row("MX01 Early Materials")).toMatchObject({
        contract: 60000, estimatedTotalCost: 45000, costToDate: 18000, percentComplete: 0.4, earnedRevenue: 24000, billedToDate: 6000,
        overBilled: 0, underBilled: 18000, estimatedGrossProfit: 15000, costToComplete: 27000, grossProfitToDate: 6000, provisionForLoss: 0, billedPastContract: 0,
      });
      const fc = page("MX01 Early Materials").forecast;
      expect([fc.available, fc.confidence, Math.round(fc.forecastCostAtCompletion!), formatPct(fc.forecastMarginPct)]).toEqual([true, "low", 180000, "-200.0%"]);
      const items = page("MX01 Early Materials").needsAttention.map((i) => [i.issueCode, i.issue, i.financialImpact, i.severity]);
      expect(items).toEqual([["underbilled", "About 40% complete but billed 10% of the contract", 18000, "high"]]);
    });

    it("leaves a job past its estimate off the schedule with the reason, and out of the totals", () => {
      expect(row("MX02 Past Estimate")).toBeUndefined();
      expect(after.wip.notScheduled.find((j) => j.jobName === "MX02 Past Estimate")?.needs).toBe("estimate_passed");
      expect(NOT_SCHEDULED_NEED_TEXT.estimate_passed).toBe("costs have passed the estimate: needs an updated cost estimate or percent complete");
      // The job page says so instead of showing 100% complete.
      expect(page("MX02 Past Estimate").financials.wip?.costPastEstimate).toBe(true);
      expect(page("MX02 Past Estimate").financials.varianceVsEstimate).toBe(4000);
      const items = page("MX02 Past Estimate").needsAttention.map((i) => [i.issueCode, i.issue, i.financialImpact, i.severity]);
      expect(items).toEqual([["over_budget", "Actual costs are 13% over the estimate", 4000, "medium"]]);
    });

    it("flags billing past the contract on the row", () => {
      expect(row("MX03 Billed Past Contract")).toMatchObject({
        contract: 30000, estimatedTotalCost: 24000, costToDate: 21000, percentComplete: 0.875, earnedRevenue: 26250, billedToDate: 33500,
        overBilled: 7250, underBilled: 0, billedPastContract: 3500, estimatedGrossProfit: 6000, costToComplete: 3000, grossProfitToDate: 5250,
      });
      const fc = after.wipData.forecasts.get(jobByName("MX03 Billed Past Contract").id)!;
      expect([fc.confidence, formatPct(fc.forecastMarginPct)]).toEqual(["medium", "28.4%"]);
      expect(page("MX03 Billed Past Contract").needsAttention).toEqual([]);
    });

    it("books the whole expected loss on a job whose cost estimate is above the contract", () => {
      expect(row("MX04 Expected Loss")).toMatchObject({
        contract: 50000, estimatedTotalCost: 60000, costToDate: 30000, percentComplete: 0.5, earnedRevenue: 25000, billedToDate: 25000,
        overBilled: 0, underBilled: 0, estimatedGrossProfit: -10000, costToComplete: 30000, provisionForLoss: 5000, grossProfitToDate: -10000,
      });
      const items = page("MX04 Expected Loss").needsAttention.map((i) => [i.issueCode, i.issue, i.financialImpact, i.severity]);
      expect(items).toEqual([["forecast_below_target", "Forecast to finish at -20.0% margin, 40.0 points below your 20% target", 20000, "high"]]);
    });

    it("keeps an idle open job off the schedule and names it", () => {
      expect(row("MX06 Idle Job")).toBeUndefined();
      expect(after.wip.idle.map((j) => j.jobName)).toContain("MX06 Idle Job");
      expect(after.wip.notScheduled.some((j) => j.jobName === "MX06 Idle Job")).toBe(false);
      expect(page("MX06 Idle Job").forecast.reason).toBe(
        "The last cost or invoice on this job was 160 days ago, so billing no longer says how far along it is. Enter a percent complete, or mark the job completed if it's finished."
      );
    });

    it("moves the totals by the three scheduled jobs only", () => {
      const t = (k: keyof WipSchedule["totals"]) => delta((s) => Number(s.wip.totals[k] ?? 0));
      expect(delta((s) => s.wip.inProgress.length)).toBe(3);
      expect(delta((s) => s.wipData.lifetimeJobs.filter((j) => j.status === "open").length)).toBe(17);
      expect(t("contract")).toBe(140000);
      expect(t("estimatedTotalCost")).toBe(129000);
      expect(t("costToDate")).toBe(69000);
      expect(t("earnedRevenue")).toBe(75250);
      expect(t("billedToDate")).toBe(64500);
      expect(t("overBilled")).toBe(7250);
      expect(t("underBilled")).toBe(18000);
      expect(t("provisionForLoss")).toBe(5000);
      expect(t("grossProfitToDate")).toBe(1250);
      expect(t("estimatedGrossProfit")).toBe(11000);
      expect(t("costToComplete")).toBe(60000);
      // 12 jobs with no contract value, plus MX02 past its estimate.
      const added = after.wip.notScheduled.filter((j) => !before.wip.notScheduled.some((b) => b.jobId === j.jobId));
      expect(added.filter((j) => j.needs === "contract").map((j) => j.jobName).sort()).toEqual(
        ["MX05 Overdue Invoice", ...JOB_NAMES.slice(6)].sort()
      );
      expect(added.filter((j) => j.needs !== "contract").map((j) => j.jobName)).toEqual(["MX02 Past Estimate"]);
    });
  });

  describe("Money you're owed", () => {
    const job = (name: string) => after.owed.unpaid.jobs.find((j) => j.jobName === name)!;

    it("shows the overdue invoice with its number, due date and days past due", () => {
      expect(after.owed.unpaid.agedFrom).toBe("due_date");
      const j = job("MX05 Overdue Invoice");
      expect([j.balance, j.buckets]).toEqual([8000, [0, 8000, 0, 0]]);
      expect(j.invoiceList).toEqual([
        expect.objectContaining({ docNumber: "MX-1005", txnDate: dayDate(75), dueDate: dayDate(45), openBalance: 8000, ageDays: 45, notYetDue: false }),
      ]);
    });

    it("shows the discount invoice as not due yet", () => {
      const j = job("MX15 Discount Invoice");
      expect([j.balance, j.buckets]).toEqual([4750, [4750, 0, 0, 0]]);
      expect(j.invoiceList).toEqual([expect.objectContaining({ docNumber: "MX-1015", dueDate: dayDate(-20), openBalance: 4750, notYetDue: true })]);
    });

    it("lists materials bought early as work done and not billed, and the job past its estimate as a possible change order", () => {
      const unbilled = after.owed.unbilled.jobs.find((j) => j.jobName === "MX01 Early Materials");
      expect(unbilled).toMatchObject({ amount: 18000, percentComplete: 0.4, percentCompleteSource: "cost", billed: 6000, contract: 60000 });
      const co = after.owed.changeOrders.jobs.find((j) => j.jobName === "MX02 Past Estimate");
      expect(co).toMatchObject({ overBy: 4000, estimatedCost: 30000, costs: 34000, billed: 24000, contract: 40000, priceAtTarget: 5000 });
      expect(formatCurrency(co!.priceAtTarget)).toBe("$5,000");
    });

    it("moves the totals by the new jobs only", () => {
      expect(delta((s) => s.owed.total)).toBe(30750);
      expect(delta((s) => s.owed.unpaid.total)).toBe(12750);
      expect(delta((s) => s.owed.unpaid.invoices)).toBe(2);
      expect(delta((s) => s.owed.unpaid.over60)).toBe(0);
      expect(delta((s) => s.owed.unbilled.total)).toBe(18000);
      expect(delta((s) => s.owed.unbilled.smallTotal)).toBe(0);
      expect(delta((s) => s.owed.changeOrders.total)).toBe(4000);
      expect(delta((s) => s.owed.unbilled.checked)).toBe(3);
      expect(delta((s) => s.owed.unbilled.notChecked.contract)).toBe(12);
      expect(delta((s) => s.owed.unbilled.notChecked.estimate_passed)).toBe(1);
    });
  });

  describe("Estimate Check", () => {
    const est = (doc: string) => estimates.find((e) => e.docNumber === doc)!;

    it("doesn't cost an installed price at the materials-only item cost: it goes by the past Remodel jobs", () => {
      const e = est("MX-E1");
      expect([e.typeLabel, e.typeSource, e.check.status, e.check.method, e.check.historyJobs]).toEqual(["Remodel", "chosen", "on_target", "whole_job", 3]);
      expect(e.check.summary).toBe("If this job goes like your past ones, it costs about $8,843 and earns 34.5%, at or above your 20% target.");
      expect(e.check.lineReadings.map((l) => [l.name, l.reading, l.cost, l.price])).toEqual([
        ["MX Tile materials (test)", "Not costed: no quantity, or priced far from the item cost of $110 a unit, so it's read as a lump sum.", null, 13500],
      ]);
      expect(e.check.readingsUnused).toBe(true);
      expect([e.check.confidence, e.check.confidenceReason]).toEqual(["medium", "Based on 3 finished jobs of this type."]);
    });

    it("costs labor priced per hour at the average labor cost, burden included, and finds it light", () => {
      const e = est("MX-E2");
      expect([e.typeKey, e.check.status, e.check.method, formatCurrency(e.check.shortfall), formatCurrency(e.check.priceAtTarget)]).toEqual([null, "below_target", "quantities", "$200", "$3,600"]);
      expect(e.check.summary).toBe("Costed from its quantities, this job costs about $2,880 and earns 15.3%. Reaching your 20% target takes about $3,600, $200 more than quoted.");
      expect(e.check.lineReadings.map((l) => [l.name, l.reading, l.cost, l.price])).toEqual([
        ["MX Framing labor (test)", "Read as 40 hours at your labor cost of $72 an hour, charged at $85 an hour.", 2880, 3400],
      ]);
      expect([e.check.confidence, e.check.confidenceReason]).toEqual(["medium", "1 line costed from quantities, 100% of the price."]);
      expect(feedTitles).toContain("Estimate MX-E2 for Walnut Street Prospect (test) looks $200 light, and QuickBooks hasn't emailed it yet");
    });

    it("judges an estimate of lump sums only by the past Remodel jobs", () => {
      const e = est("MX-E3");
      expect([e.check.status, e.check.method]).toEqual(["on_target", "whole_job"]);
      expect(e.check.summary).toBe("If this job goes like your past ones, it costs about $6,550 and earns 34.5%, at or above your 20% target.");
      expect(e.check.lineReadings.map((l) => [l.name, l.reading])).toEqual([
        ["MX Framing labor (test)", "Not costed: no hours, or not priced at an hourly rate ($15 to $300 an hour), so it's read as a lump sum."],
        ["MX Tile materials (test)", "Not costed: no quantity, or priced far from the item cost of $110 a unit, so it's read as a lump sum."],
      ]);
    });

    it("asks for a job type on the two estimates that need past jobs, before one is chosen", () => {
      for (const doc of ["MX-E1", "MX-E3"]) {
        const e = estimatesUntyped.find((x) => x.docNumber === doc)!;
        expect([e.typeKey, e.check.status, e.check.summary]).toEqual([null, "no_history", "Choose a job type so this estimate can be compared with your finished jobs of that type."]);
      }
      // MX-E2 is costed from its hours alone, with or without a type.
      const e2 = estimatesUntyped.find((x) => x.docNumber === "MX-E2")!;
      expect([e2.check.status, formatCurrency(e2.check.shortfall)]).toEqual(["below_target", "$200"]);
    });

    it("lists only the three pending estimates, none of the accepted ones", () => {
      expect(estimates.map((e) => e.docNumber).sort()).toEqual(["MX-E1", "MX-E2", "MX-E3"]);
    });
  });

  describe("Profit Dashboard totals, Active tab, last 12 months", () => {
    it("moves each tile by the new jobs' figures", () => {
      const t = (k: keyof ConnectionProfitData["totals"]) => delta((s) => Number(s.dashboard.totals[k] ?? 0));
      expect(t("revenue")).toBe(160250);
      expect(t("trackedJobCosts")).toBe(137710);
      expect(t("jobGrossProfit")).toBe(22540);
      expect(t("jobsInView")).toBe(17);
      expect(t("jobsBelowTarget")).toBe(1);
      expect(t("profitAtRisk")).toBe(20000);
      expect(t("dataIssues")).toBe(7);
    });

    it("raises three conditions the nightly alert emails can send, and no forecast one for MX01", () => {
      // The alert check (src/lib/alerts.ts) emails these kinds from the same
      // Needs Your Attention items, open jobs only.
      const alertKinds = new Set(["over_budget", "forecast_below_target", "underbilled"]);
      const mx = after.dashboard.needsAttention
        .filter((i) => alertKinds.has(i.issueCode) && i.jobName.startsWith("MX"))
        .map((i) => `${i.jobName}: ${i.issueCode}`)
        .sort();
      expect(mx).toEqual(["MX01 Early Materials: underbilled", "MX02 Past Estimate: over_budget", "MX04 Expected Loss: forecast_below_target"]);
    });
  });
});
