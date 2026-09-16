/**
 * JobProfitAI - Production test-company seeder
 * --------------------------------------------
 * Creates the transactions described in the QuickBooks Test Company Plan
 * (7 jobs, their invoices, expenses, bills, time entries and three
 * deliberate pieces of messy data) in a REAL QuickBooks Online company via
 * the API, so you don't type thirty transactions by hand.
 *
 * Differences from scripts/seed-sandbox.js, which this is modelled on:
 *
 *  - It points at the PRODUCTION QuickBooks API, not the sandbox host.
 *  - It creates NOTHING that already exists. Customers, projects, accounts
 *    and estimates are looked up by name and reused. If a name is missing it
 *    stops and tells you, rather than inventing a second copy of your data.
 *  - Every transaction it writes carries a marker in its PrivateNote (or
 *    Description, for time entries). On a re-run it reads those markers back
 *    first and skips anything already present, so running it twice does not
 *    double your dollar amounts. That was the sharp edge on the sandbox
 *    seeder and it is worth not repeating against real books.
 *
 * WHAT IT ASSUMES YOU HAVE ALREADY DONE BY HAND
 *   - Created the 3 parent customers and the 7 projects under them.
 *   - Created the 7 estimates. (Only 5 jobs get one. See ESTIMATES below.)
 *   - Chosen Construction as the industry, so the job-costing accounts exist.
 *
 * HOW TO RUN
 *   1. developer.intuit.com -> your app -> OAuth 2.0 Playground. Choose the
 *      PRODUCTION environment and the com.intuit.quickbooks.accounting scope,
 *      authorize your test company, and copy the access token and realm ID.
 *      The token lasts 60 minutes, so get it immediately before running.
 *
 *   2. PowerShell, from the project folder:
 *        $env:QBO_ACCESS_TOKEN="paste-token"
 *        $env:QBO_REALM_ID="paste-realm-id"
 *        node scripts/seed-test-company.js --dry-run
 *
 *      The dry run writes nothing. It resolves every name and prints exactly
 *      what it would create, which is where a typo in a project name shows
 *      up cheaply. When it looks right, run it again without --dry-run.
 *
 *   3. Optional, after you have checked the numbers in JobProfitAI:
 *        node scripts/seed-test-company.js --close
 *
 *      That pays off the invoices on the six finished jobs and marks them
 *      inactive, which is how a job becomes "completed". It is separate
 *      because QuickBooks refuses to deactivate a customer that still has an
 *      open balance, so the payments have to land first, and because you may
 *      want to look at the dashboard with everything still open before you
 *      close anything.
 *
 * Requires Node 18+ for the built-in fetch. No npm install.
 */

const ACCESS_TOKEN = process.env.QBO_ACCESS_TOKEN;
const REALM_ID = process.env.QBO_REALM_ID;

const DRY_RUN = process.argv.includes("--dry-run");
const CLOSE_ONLY = process.argv.includes("--close");
const INSPECT = process.argv.includes("--inspect");

if (!ACCESS_TOKEN || !REALM_ID) {
  console.error("Missing QBO_ACCESS_TOKEN or QBO_REALM_ID. See the comment at the top of this file.");
  process.exit(1);
}

// Production, deliberately. The sandbox host is a different domain and a
// production token will not authenticate against it.
const BASE_URL = `https://quickbooks.api.intuit.com/v3/company/${REALM_ID}`;

// Marker prefix written into PrivateNote on everything this script creates.
// It is what makes a second run safe, and it also gives you a way to find
// every seeded row later if you want to clean up.
const MARK = "jpai-seed";

const NOW = Date.now();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);

// ============================================================
// THE DATA
// ============================================================

// `close: true` means this job should end up inactive in QuickBooks, which
// is what the app reads as "completed". Job 5 stays open on purpose so the
// forecast-at-completion path has something to run against.
const JOBS = [
  { key: "j1", name: "Torres Kitchen Remodel", close: true },
  { key: "j2", name: "Ruiz Kitchen Remodel", close: true },
  { key: "j3", name: "Harborview Unit 3 Kitchen", close: true },
  { key: "j4", name: "Harborview Roof Replacement", close: true },
  { key: "j5", name: "Torres Bath Remodel", close: false },
  { key: "j6", name: "Ruiz Deck Build", close: true },
  { key: "j7", name: "Harborview Unit 5 Punchlist", close: true },
];

// The parent customer used by the "tagged to a parent, not a job" mess.
// Harborview is chosen because it has three projects under it, so the
// parent-fallback resolver cannot pick one unambiguously and the cost lands
// in the unresolved count. That is the behaviour being tested.
const AMBIGUOUS_PARENT = "Harborview Properties";

const INVOICES = [
  { job: "j1", amount: 42000, daysAgo: 40 },
  { job: "j2", amount: 28500, daysAgo: 55 },
  { job: "j3", amount: 19800, daysAgo: 70 },
  { job: "j4", amount: 16400, daysAgo: 85 },
  { job: "j5", amount: 9000, daysAgo: 12 }, // progress billing on the open job
  { job: "j6", amount: 11200, daysAgo: 100 },
  { job: "j7", amount: 2400, daysAgo: 30 }, // revenue with no costs, on purpose
];

// `account` keys map to real account names in ACCOUNTS below.
const EXPENSES = [
  { job: "j1", account: "materials", amount: 14200, daysAgo: 60 },
  { job: "j1", account: "labor", amount: 6400, daysAgo: 50 },
  { job: "j2", account: "materials", amount: 9900, daysAgo: 75 },
  { job: "j2", account: "equipment", amount: 1450, daysAgo: 70 },
  { job: "j2", account: "labor", amount: 6000, daysAgo: 65 },
  { job: "j3", account: "materials", amount: 7300, daysAgo: 90 },
  { job: "j4", account: "materials", amount: 6100, daysAgo: 105 },
  { job: "j5", account: "materials", amount: 5400, daysAgo: 25 },
  { job: "j5", account: "labor", amount: 2080, daysAgo: 18 },
  { job: "j6", account: "materials", amount: 4800, daysAgo: 115 },
  { job: "j6", account: "labor", amount: 2200, daysAgo: 110 },

  // Mess 1. No customer at all. Should show up as one unassigned cost of
  // $850 on Data Health, rather than disappearing or being guessed onto a job.
  { job: null, account: "permits", amount: 850, daysAgo: 20, note: "unassigned" },

  // Mess 2. Tagged to the parent customer rather than one of its projects.
  { parent: AMBIGUOUS_PARENT, account: "materials", amount: 600, daysAgo: 35, note: "parent-tagged" },
];

const BILLS = [
  { job: "j1", account: "subcontractors", amount: 9800, daysAgo: 45 },
  { job: "j3", account: "subcontractors", amount: 4100, daysAgo: 88 },
  { job: "j4", account: "subcontractors", amount: 2900, daysAgo: 100 },
];

const TIME_ACTIVITIES = [
  // Rate set, so this one becomes a real $520 labor cost.
  { job: "j5", hours: 8, rate: 65, daysAgo: 22, note: "with-rate" },

  // Mess 3. No rate. The sync counts these separately and skips them,
  // because an hour with no rate has no cost. Adds $0, so every total above
  // stays correct.
  { job: "j5", hours: 4, rate: 0, daysAgo: 21, note: "no-rate" },
];

// Account names exactly as QuickBooks' Construction chart of accounts
// creates them. Matched case-insensitively, so capitalisation drift is fine.
const ACCOUNTS = {
  materials: "Job materials",
  subcontractors: "Subcontractors",
  equipment: "Job equipment rental",
  labor: "Direct job labor",
  permits: "Job permits and inspections",
};

const VENDORS = {
  supply: "Coastal Supply Co",
  subs: "Delgado Tile and Stone",
  labor: "Field Crew Payroll",
};

const SERVICE_ITEM_NAME = "Construction services";

// ============================================================
// QuickBooks plumbing
// ============================================================

async function qbo(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const fault = body?.Fault ? JSON.stringify(body.Fault) : text;
    throw new Error(`QBO ${res.status} on ${path}: ${fault}`);
  }
  return body;
}

const query = (sql) => qbo(`/query?query=${encodeURIComponent(sql)}&minorversion=65`);

const create = (entity, payload) =>
  qbo(`/${entity.toLowerCase()}?minorversion=65`, { method: "POST", body: JSON.stringify(payload) });

const norm = (s) => (s ?? "").trim().toLowerCase();

let created = 0;
let skipped = 0;

// ============================================================
// Resolving what already exists
// ============================================================

async function loadCustomers() {
  const res = await query("SELECT * FROM Customer MAXRESULTS 1000");
  return res?.QueryResponse?.Customer ?? [];
}

function resolveJobs(customers) {
  const byKey = {};
  const missing = [];
  for (const j of JOBS) {
    const match = customers.find((c) => norm(c.DisplayName) === norm(j.name) && c.Job === true);
    if (match) byKey[j.key] = match.Id;
    else missing.push(j.name);
  }
  return { byKey, missing };
}

async function resolveAccounts() {
  const res = await query("SELECT Id, Name FROM Account MAXRESULTS 1000");
  const all = res?.QueryResponse?.Account ?? [];
  const byKey = {};
  const missing = [];
  for (const [key, name] of Object.entries(ACCOUNTS)) {
    const match = all.find((a) => norm(a.Name) === norm(name));
    if (match) byKey[key] = match.Id;
    else missing.push(name);
  }
  return { byKey, missing };
}

async function resolvePaymentAccount() {
  const res = await query("SELECT Id, Name FROM Account WHERE AccountType IN ('Bank','Credit Card') MAXRESULTS 1");
  const acct = res?.QueryResponse?.Account?.[0];
  if (!acct) throw new Error("No Bank or Credit Card account exists in this company. Create a Checking account and re-run.");
  return acct.Id;
}

async function ensureVendor(name) {
  const safe = name.replace(/'/g, "\\'");
  const res = await query(`SELECT Id FROM Vendor WHERE DisplayName = '${safe}' MAXRESULTS 1`);
  const existing = res?.QueryResponse?.Vendor?.[0]?.Id;
  if (existing) return existing;
  if (DRY_RUN) return "(would create)";
  const made = await create("vendor", { DisplayName: name });
  return made.Vendor.Id;
}

async function ensureServiceItem() {
  const safe = SERVICE_ITEM_NAME.replace(/'/g, "\\'");
  const res = await query(`SELECT Id FROM Item WHERE Name = '${safe}' MAXRESULTS 1`);
  const existing = res?.QueryResponse?.Item?.[0]?.Id;
  if (existing) return existing;

  const inc = await query("SELECT Id FROM Account WHERE AccountType = 'Income' MAXRESULTS 1");
  const incomeId = inc?.QueryResponse?.Account?.[0]?.Id;
  if (!incomeId) throw new Error("No Income account exists in this company.");

  if (DRY_RUN) return "(would create)";
  const made = await create("item", {
    Name: SERVICE_ITEM_NAME,
    Type: "Service",
    IncomeAccountRef: { value: incomeId },
  });
  return made.Item.Id;
}

/**
 * Reads back the markers this script has written before, so a second run
 * skips what already exists instead of duplicating it. Time entries have no
 * PrivateNote field, so they carry their marker in Description.
 */
async function loadExistingMarkers() {
  const seen = new Set();
  const add = (v) => {
    if (typeof v === "string" && v.startsWith(MARK)) seen.add(v);
  };
  for (const entity of ["Invoice", "Purchase", "Bill", "Payment"]) {
    const res = await query(`SELECT * FROM ${entity} MAXRESULTS 1000`);
    for (const row of res?.QueryResponse?.[entity] ?? []) add(row.PrivateNote);
  }
  const t = await query("SELECT * FROM TimeActivity MAXRESULTS 1000");
  for (const row of t?.QueryResponse?.TimeActivity ?? []) add(row.Description);
  return seen;
}

// ============================================================
// Writing
// ============================================================

async function makeOnce(marker, seen, label, entity, payload) {
  if (seen.has(marker)) {
    skipped++;
    console.log(`  skip    ${label}  (already present)`);
    return null;
  }
  if (DRY_RUN) {
    created++;
    console.log(`  would   ${label}`);
    return null;
  }
  const res = await create(entity, payload);
  created++;
  console.log(`  created ${label}`);
  return res;
}

async function createInvoices(jobIds, itemId, seen) {
  for (const inv of INVOICES) {
    const marker = `${MARK}:invoice:${inv.job}`;
    await makeOnce(marker, seen, `invoice ${inv.job} $${inv.amount.toLocaleString()}`, "invoice", {
      CustomerRef: { value: jobIds[inv.job] },
      TxnDate: daysAgo(inv.daysAgo),
      PrivateNote: marker,
      Line: [
        {
          Amount: inv.amount,
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: inv.amount },
        },
      ],
    });
  }
}

async function createExpenses(jobIds, parentIds, accountIds, paymentAccountId, vendorIds, seen) {
  for (const [i, ex] of EXPENSES.entries()) {
    const marker = `${MARK}:expense:${i}`;
    const detail = { AccountRef: { value: accountIds[ex.account] } };

    // The three cases the resolver has to tell apart: tagged to a job,
    // tagged to a parent customer, and tagged to nobody.
    if (ex.job) detail.CustomerRef = { value: jobIds[ex.job] };
    else if (ex.parent) detail.CustomerRef = { value: parentIds[ex.parent] };

    const who = ex.job ?? ex.parent ?? "unassigned";
    const label = `expense ${who} ${ex.account} $${ex.amount.toLocaleString()}${ex.note ? `  [${ex.note}]` : ""}`;

    await makeOnce(marker, seen, label, "purchase", {
      PaymentType: "Cash",
      AccountRef: { value: paymentAccountId },
      EntityRef: { value: vendorIds.supply, type: "Vendor" },
      TxnDate: daysAgo(ex.daysAgo),
      PrivateNote: marker,
      Line: [{ Amount: ex.amount, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: detail }],
    });
  }
}

async function createBills(jobIds, accountIds, vendorIds, seen) {
  for (const [i, b] of BILLS.entries()) {
    const marker = `${MARK}:bill:${i}`;
    await makeOnce(marker, seen, `bill ${b.job} ${b.account} $${b.amount.toLocaleString()}`, "bill", {
      VendorRef: { value: vendorIds.subs },
      TxnDate: daysAgo(b.daysAgo),
      PrivateNote: marker,
      Line: [
        {
          Amount: b.amount,
          DetailType: "AccountBasedExpenseLineDetail",
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: accountIds[b.account] },
            CustomerRef: { value: jobIds[b.job] },
          },
        },
      ],
    });
  }
}

async function createTimeActivities(jobIds, vendorIds, seen) {
  for (const [i, t] of TIME_ACTIVITIES.entries()) {
    const marker = `${MARK}:time:${i}`;
    const payload = {
      TxnDate: daysAgo(t.daysAgo),
      NameOf: "Vendor",
      VendorRef: { value: vendorIds.labor },
      CustomerRef: { value: jobIds[t.job] },
      Hours: t.hours,
      Minutes: 0,
      Description: marker,
      // NotBillable on purpose. A billable time entry that is never invoiced
      // counts as an unbilled charge and blocks deactivating the customer
      // later, which would break the --close step. The app's cost tracking
      // ignores billable status entirely.
      BillableStatus: "NotBillable",
    };
    // Setting HourlyRate through the API sidesteps the QuickBooks interface,
    // where the rate field only appears once you tick Billable.
    if (t.rate > 0) payload.HourlyRate = t.rate;

    const label = `time ${t.job} ${t.hours}h @ ${t.rate || "no rate"}  [${t.note}]`;
    await makeOnce(marker, seen, label, "timeactivity", payload);
  }
}

// ============================================================
// Closing out
// ============================================================

async function payAndClose(jobIds, seen) {
  const toClose = JOBS.filter((j) => j.close);

  console.log("\nPaying invoices on the finished jobs.");
  const res = await query("SELECT Id, Balance, TotalAmt, CustomerRef FROM Invoice MAXRESULTS 1000");
  const invoices = res?.QueryResponse?.Invoice ?? [];

  for (const j of toClose) {
    const custId = jobIds[j.key];
    const inv = invoices.find((v) => v.CustomerRef?.value === custId && Number(v.Balance) > 0);
    if (!inv) {
      console.log(`  skip    ${j.name}  (no open invoice)`);
      continue;
    }
    const marker = `${MARK}:payment:${j.key}`;
    await makeOnce(marker, seen, `payment ${j.name} $${Number(inv.Balance).toLocaleString()}`, "payment", {
      CustomerRef: { value: custId },
      TxnDate: daysAgo(2),
      TotalAmt: Number(inv.Balance),
      PrivateNote: marker,
      Line: [{ Amount: Number(inv.Balance), LinkedTxn: [{ TxnId: inv.Id, TxnType: "Invoice" }] }],
    });
  }

  console.log("\nMarking the finished jobs inactive.");
  for (const j of toClose) {
    const cur = await query(`SELECT Id, SyncToken, Active FROM Customer WHERE Id = '${jobIds[j.key]}'`);
    const c = cur?.QueryResponse?.Customer?.[0];
    if (!c) continue;
    if (c.Active === false) {
      console.log(`  skip    ${j.name}  (already inactive)`);
      skipped++;
      continue;
    }
    if (DRY_RUN) {
      console.log(`  would   deactivate ${j.name}`);
      continue;
    }
    await create("customer", { Id: c.Id, SyncToken: c.SyncToken, Active: false, sparse: true });
    console.log(`  closed  ${j.name}`);
    created++;
  }
}

// ============================================================
// Diagnostics
// ============================================================

/**
 * Prints back what QuickBooks actually stored for every time entry, which is
 * the only reliable way to answer "did the hourly rate save". The Time
 * Entries screen in QuickBooks filters by employee by default and these are
 * booked against a vendor, so they simply do not appear there.
 */
async function inspectTimeActivities() {
  const res = await query("SELECT * FROM TimeActivity MAXRESULTS 1000");
  const rows = res?.QueryResponse?.TimeActivity ?? [];
  if (!rows.length) {
    console.log("\nNo time activities exist in this company at all.");
    return;
  }
  console.log(`\n${rows.length} time activit${rows.length === 1 ? "y" : "ies"} in QuickBooks:\n`);
  for (const t of rows) {
    const hours = (t.Hours ?? 0) + (t.Minutes ?? 0) / 60;
    const rate = t.HourlyRate;
    const cost = rate > 0 ? (hours * rate).toFixed(2) : "0.00";
    console.log(`  Id ${t.Id}  ${t.TxnDate}`);
    console.log(`    customer:   ${t.CustomerRef?.name ?? "(none)"}`);
    console.log(`    nameOf:     ${t.NameOf}  ${t.VendorRef?.name ?? t.EmployeeRef?.name ?? ""}`);
    console.log(`    hours:      ${hours}`);
    console.log(`    hourlyRate: ${rate === undefined ? "ABSENT (QuickBooks did not store it)" : rate}`);
    console.log(`    billable:   ${t.BillableStatus}`);
    console.log(`    -> the sync would count ${rate > 0 ? "$" + cost : "nothing, because there is no rate"}`);
    console.log("");
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log("JobProfitAI test-company seeder");
  console.log(`Target: PRODUCTION QuickBooks, company ${REALM_ID}`);
  console.log(DRY_RUN ? "Mode:   dry run, nothing will be written\n" : "Mode:   live, this writes to real books\n");

  if (INSPECT) {
    await inspectTimeActivities();
    return;
  }

  console.log("Resolving what already exists...");
  const customers = await loadCustomers();
  const { byKey: jobIds, missing: missingJobs } = resolveJobs(customers);

  if (missingJobs.length) {
    console.error("\nThese projects do not exist in QuickBooks yet, or their names differ:");
    for (const n of missingJobs) console.error(`  - ${n}`);
    console.error("\nCreate them as projects under their parent customers, then re-run.");
    console.error("Names must match exactly, apart from capitalisation.");
    process.exit(1);
  }
  console.log(`  ${JOBS.length} projects found.`);

  const { byKey: accountIds, missing: missingAccounts } = await resolveAccounts();
  if (missingAccounts.length) {
    console.error("\nThese accounts are missing from the chart of accounts:");
    for (const n of missingAccounts) console.error(`  - ${n}`);
    console.error("\nThey come with the Construction industry template. Create them as Cost of Goods Sold accounts.");
    process.exit(1);
  }
  console.log(`  ${Object.keys(ACCOUNTS).length} accounts found.`);

  const parentIds = {};
  const parentMatch = customers.find((c) => norm(c.DisplayName) === norm(AMBIGUOUS_PARENT));
  if (!parentMatch) {
    console.error(`\nParent customer "${AMBIGUOUS_PARENT}" not found. It is needed for the parent-tagged cost test.`);
    process.exit(1);
  }
  parentIds[AMBIGUOUS_PARENT] = parentMatch.Id;

  const estimates = await query("SELECT Id, CustomerRef FROM Estimate MAXRESULTS 1000");
  const estimateCount = (estimates?.QueryResponse?.Estimate ?? []).length;
  console.log(`  ${estimateCount} estimates already in the company.`);

  const paymentAccountId = await resolvePaymentAccount();
  const itemId = await ensureServiceItem();
  const vendorIds = {};
  for (const [key, name] of Object.entries(VENDORS)) vendorIds[key] = await ensureVendor(name);

  const seen = await loadExistingMarkers();
  if (seen.size) console.log(`  ${seen.size} previously seeded transactions found, they will be skipped.`);

  if (CLOSE_ONLY) {
    await payAndClose(jobIds, seen);
  } else {
    console.log("\nInvoices");
    await createInvoices(jobIds, itemId, seen);

    console.log("\nExpenses");
    await createExpenses(jobIds, parentIds, accountIds, paymentAccountId, vendorIds, seen);

    console.log("\nBills");
    await createBills(jobIds, accountIds, vendorIds, seen);

    console.log("\nTime entries");
    await createTimeActivities(jobIds, vendorIds, seen);
  }

  console.log(`\nDone. ${created} ${DRY_RUN ? "would be written" : "written"}, ${skipped} skipped.`);
  if (!CLOSE_ONLY) {
    console.log("\nNext: sync in JobProfitAI and check the numbers, then run again with --close");
    console.log("to pay off the invoices and mark the six finished jobs inactive.");
  }
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  console.error("\nIf this is a 401, the access token expired. They last 60 minutes. Get a fresh one and re-run.");
  console.error("Anything already written is marked, so a re-run will not duplicate it.");
  process.exit(1);
});
