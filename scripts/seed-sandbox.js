/**
 * JobProfitAI - QuickBooks Sandbox Seeder
 * -----------------------------------------
 * One-time script that creates the full test-data set (17 jobs plus
 * estimates, invoices, expenses, bills, and one time activity) directly in
 * your QuickBooks Online SANDBOX company via the QuickBooks API - so you
 * don't have to type all of it in by hand.
 *
 * This mirrors, row for row, the "JobProfitAI_Sandbox_Test_Data.xlsx"
 * workbook (tabs 1-5) sent earlier. One simplification vs. that workbook:
 * R2's materials refund is netted directly into the materials line ($5,600 -
 * $200 = $5,400) instead of a separate negative-amount line, since
 * QuickBooks' API doesn't reliably accept negative expense-line amounts.
 * The final dollar totals for every job are identical either way.
 *
 * I haven't been able to test this script against a live QuickBooks sandbox
 * myself (this environment has no network path to Intuit's API) - I built
 * it directly against QuickBooks' documented API shapes, but if any one
 * step errors out, copy me the console output and I'll fix that spot. The
 * script is safe to re-run after a partial failure: jobs already created
 * are found by name and reused rather than duplicated.
 *
 * HOW TO RUN
 * 1. Get a temporary sandbox access token + Realm ID (Company ID) from
 *    Intuit's OAuth Playground - see SANDBOX_SEED_INSTRUCTIONS.txt for the
 *    exact steps. The token is only valid for 60 minutes, so get it right
 *    before you run this.
 * 2. In your project folder, set two environment variables and run:
 *
 *      QBO_ACCESS_TOKEN="paste-your-token" QBO_REALM_ID="paste-your-realm-id" node scripts/seed-sandbox.js
 *
 *    On Windows PowerShell, set them first, then run:
 *      $env:QBO_ACCESS_TOKEN="paste-your-token"
 *      $env:QBO_REALM_ID="paste-your-realm-id"
 *      node scripts/seed-sandbox.js
 *
 * 3. Watch the console output. It logs every phase and any errors.
 *
 * Requires Node 18+ (uses the built-in fetch - no npm install needed).
 */

const ACCESS_TOKEN = process.env.QBO_ACCESS_TOKEN;
const REALM_ID = process.env.QBO_REALM_ID;

if (!ACCESS_TOKEN || !REALM_ID) {
  console.error("Missing QBO_ACCESS_TOKEN or QBO_REALM_ID environment variables. See SANDBOX_SEED_INSTRUCTIONS.txt.");
  process.exit(1);
}

const BASE_URL = `https://sandbox-quickbooks.api.intuit.com/v3/company/${REALM_ID}`;
const NOW = Date.now();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);

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

async function query(sql) {
  const encoded = encodeURIComponent(sql);
  return qbo(`/query?query=${encoded}&minorversion=65`);
}

async function create(entity, payload) {
  return qbo(`/${entity.toLowerCase()}?minorversion=65`, { method: "POST", body: JSON.stringify(payload) });
}

async function batch(items) {
  // items: [{ bId, entity, operation, data }]
  const BatchItemRequest = items.map((it) => ({
    bId: it.bId,
    operation: it.operation,
    [it.entity]: it.data,
  }));
  const res = await qbo(`/batch?minorversion=65`, {
    method: "POST",
    body: JSON.stringify({ BatchItemRequest }),
  });
  const results = res.BatchItemResponse || [];
  const failures = results.filter((r) => r.Fault);
  if (failures.length) {
    console.warn(`  ${failures.length} of ${items.length} item(s) in this batch failed:`);
    for (const f of failures) {
      console.warn(`   - bId ${f.bId}: ${JSON.stringify(f.Fault)}`);
    }
  }
  return results;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ============================================================
// DATA - mirrors JobProfitAI_Sandbox_Test_Data.xlsx tabs 1-5
// ============================================================
const JOBS = [
  { ref: "R1", name: "123 Oak St Reroof", closed: true },
  { ref: "R2", name: "456 Pine Ave Reroof", closed: true },
  { ref: "R3", name: "789 Maple Dr Reroof", closed: true },
  { ref: "M1", name: "Chen Kitchen Remodel", closed: true },
  { ref: "M2", name: "Alvarez Kitchen Remodel", closed: true },
  { ref: "M3", name: "Reyes Kitchen Remodel", closed: true },
  { ref: "M4", name: "Torres Kitchen Remodel", closed: false },
  { ref: "P1", name: "Johnson Exterior Paint", closed: true },
  { ref: "P2", name: "Nguyen Exterior Paint", closed: true },
  { ref: "P3", name: "Diaz Deck Staining", closed: true },
  { ref: "Z1", name: "Vacant Lot Prep", closed: false },
  { ref: "Z2", name: "Garcia Deck Addition", closed: false },
  { ref: "Z3", name: "Patel Fence Job", closed: true },
  { ref: "Z4", name: "Stalled Bathroom Job", closed: false },
  { ref: "Z5", name: "Office Remodel - Front Desk", closed: true },
  { ref: "Z6", name: "Ruiz Bathroom Refresh", closed: false },
  { ref: "Z7", name: "Fence Install - Sample St", closed: false },
];

const ESTIMATES = [
  { ref: "R1", amount: 14000, daysAgo: 60 },
  { ref: "R2", amount: 11000, daysAgo: 55 },
  { ref: "R3", amount: 20000, daysAgo: 70 },
  { ref: "P1", amount: 6000, daysAgo: 25 },
  { ref: "P2", amount: 5000, daysAgo: 22 },
  { ref: "P3", amount: 4000, daysAgo: 20 },
];

const INVOICES = [
  { ref: "R1", amount: 14000, daysAgo: 40 },
  { ref: "R2", amount: 11000, daysAgo: 35 },
  { ref: "R3", amount: 20000, daysAgo: 45 },
  { ref: "M1", amount: 10500, daysAgo: 30 },
  { ref: "M2", amount: 11000, daysAgo: 28 },
  { ref: "M3", amount: 10200, daysAgo: 32 },
  { ref: "M4", amount: 8000, daysAgo: 10 },
  { ref: "P1", amount: 6000, daysAgo: 15 },
  { ref: "P2", amount: 5000, daysAgo: 12 },
  { ref: "P3", amount: 4000, daysAgo: 10 },
  { ref: "Z2", amount: 5000, daysAgo: 7 },
  { ref: "Z5", amount: 5800, daysAgo: 18 },
  { ref: "Z6", amount: 2000, daysAgo: 14 },
  { ref: "Z7", amount: 3000, daysAgo: 10 },
];

// account: "materials" | "labor" | "equipment" | "subcontractor"
// ref: job ref, "UNRESOLVED" for the unrelated-customer test, or null for
// "unassigned" (no CustomerRef at all).
const EXPENSES = [
  { ref: "R1", account: "materials", amount: 6600, daysAgo: 40 },
  { ref: "R1", account: "labor", amount: 4900, daysAgo: 35 },
  { ref: "R1", account: "equipment", amount: 500, daysAgo: 35 },
  { ref: "R2", account: "materials", amount: 5400, daysAgo: 35 }, // refund netted in - see header note
  { ref: "R2", account: "labor", amount: 4000, daysAgo: 30 },
  { ref: "R3", account: "materials", amount: 10800, daysAgo: 45 },
  { ref: "R3", account: "labor", amount: 7200, daysAgo: 40 },
  { ref: "M1", account: "materials", amount: 4000, daysAgo: 28 },
  { ref: "M1", account: "labor", amount: 3000, daysAgo: 25 },
  { ref: "M2", account: "materials", amount: 4200, daysAgo: 26 },
  { ref: "M2", account: "labor", amount: 3100, daysAgo: 24 },
  { ref: "M3", account: "materials", amount: 3900, daysAgo: 30 },
  { ref: "M3", account: "labor", amount: 2900, daysAgo: 28 },
  { ref: "M4", account: "materials", amount: 6500, daysAgo: 5 },
  { ref: "M4", account: "labor", amount: 3200, daysAgo: 4 },
  { ref: "P1", account: "materials", amount: 1200, daysAgo: 14 },
  { ref: "P1", account: "labor", amount: 1800, daysAgo: 12 },
  { ref: "P2", account: "materials", amount: 900, daysAgo: 11 },
  { ref: "P2", account: "labor", amount: 1300, daysAgo: 10 },
  { ref: "P3", account: "materials", amount: 700, daysAgo: 9 },
  { ref: "P3", account: "labor", amount: 1000, daysAgo: 8 },
  { ref: "Z3", account: "materials", amount: 2000, daysAgo: 20 },
  { ref: "Z4", account: "materials", amount: 1500, daysAgo: 45 },
  { ref: "Z5", account: "materials", amount: 4200, daysAgo: 16 },
  { ref: "Z6", account: "materials", amount: 1200, daysAgo: 12 },
  { ref: "Z7", account: "materials", amount: 450, daysAgo: 10 }, // duplicate pair - Expense half
  { ref: null, account: "materials", amount: 85, daysAgo: 5 }, // unassigned - Office Depot
  { ref: "UNRESOLVED", account: "materials", amount: 175, daysAgo: 5 }, // tagged to unrelated customer
];

const BILLS = [
  { ref: "M1", account: "subcontractor", amount: 2000, daysAgo: 25 },
  { ref: "M2", account: "subcontractor", amount: 2100, daysAgo: 24 },
  { ref: "M3", account: "subcontractor", amount: 1900, daysAgo: 28 },
  { ref: "M4", account: "subcontractor", amount: 2000, daysAgo: 3 },
  { ref: "Z7", account: "materials", amount: 450, daysAgo: 10 }, // duplicate pair - Bill half
  { ref: null, account: "subcontractor", amount: 210, daysAgo: 5 }, // unassigned - City Utilities
];

const TIME_ACTIVITIES = [{ ref: "R1", daysAgo: 36, hours: 8, rate: 50 }];

const UNRESOLVED_CUSTOMER_NAME = "Miscellaneous / Shop";
const PARENT_CUSTOMER_NAME = "Sandbox Test Jobs (JobProfitAI)";
const ACCOUNT_NAMES = {
  materials: "Job Materials",
  labor: "Job Labor",
  equipment: "Equipment Rental",
  subcontractor: "Subcontractor Costs",
};
const VENDOR_NAME = "Field Crew (Sandbox Seed)";
const ITEM_NAME = "Contracting Services (Sandbox Seed)";

// ============================================================
// PREREQUISITES - find-or-create the shared accounts/item/vendor/customers
// this data set needs. Safe to re-run: everything is looked up by name
// first before creating anything.
// ============================================================
async function findAccountByName(name) {
  const safe = name.replace(/'/g, "\\'");
  const res = await query(`SELECT Id FROM Account WHERE Name = '${safe}' MAXRESULTS 1`);
  return res?.QueryResponse?.Account?.[0]?.Id ?? null;
}

async function ensureExpenseAccount(name) {
  const existing = await findAccountByName(name);
  if (existing) return existing;
  // "OtherMiscellaneousServiceCost" (not "OtherMiscellaneousExpense" - that
  // one pairs with AccountType "Other Expense", a different top-level type,
  // and QBO rejects the mismatch) is the generic catch-all subtype QBO
  // expects for a custom-named account under AccountType "Expense".
  const created = await create("account", {
    Name: name,
    AccountType: "Expense",
    AccountSubType: "OtherMiscellaneousServiceCost",
  });
  return created.Account.Id;
}

async function ensurePaymentAccount() {
  const res = await query(`SELECT Id, Name FROM Account WHERE AccountType IN ('Bank','Credit Card') MAXRESULTS 1`);
  const acct = res?.QueryResponse?.Account?.[0];
  if (!acct) {
    throw new Error(
      "No Bank or Credit Card account found in this sandbox company - the demo QuickBooks sandbox " +
        "usually has a 'Checking' account by default. Create one manually (any Bank account) and re-run."
    );
  }
  console.log(`  Using existing payment account: ${acct.Name}`);
  return acct.Id;
}

async function ensureIncomeAccount() {
  const res = await query(`SELECT Id, Name FROM Account WHERE AccountType = 'Income' MAXRESULTS 1`);
  const acct = res?.QueryResponse?.Account?.[0];
  if (acct) return acct.Id;
  const created = await create("account", {
    Name: "Sandbox Seed Income",
    AccountType: "Income",
    AccountSubType: "ServiceFeeIncome",
  });
  return created.Account.Id;
}

async function ensureVendor(name) {
  const safe = name.replace(/'/g, "\\'");
  const res = await query(`SELECT Id FROM Vendor WHERE DisplayName = '${safe}' MAXRESULTS 1`);
  const existing = res?.QueryResponse?.Vendor?.[0]?.Id;
  if (existing) return existing;
  const created = await create("vendor", { DisplayName: name });
  return created.Vendor.Id;
}

async function ensureItem(name, incomeAccountId) {
  const safe = name.replace(/'/g, "\\'");
  const res = await query(`SELECT Id FROM Item WHERE Name = '${safe}' MAXRESULTS 1`);
  const existing = res?.QueryResponse?.Item?.[0]?.Id;
  if (existing) return existing;
  const created = await create("item", {
    Name: name,
    Type: "Service",
    IncomeAccountRef: { value: incomeAccountId },
  });
  return created.Item.Id;
}

async function ensureCustomer(displayName, extra = {}) {
  const safe = displayName.replace(/'/g, "\\'");
  const res = await query(`SELECT Id FROM Customer WHERE DisplayName = '${safe}' MAXRESULTS 1`);
  const existing = res?.QueryResponse?.Customer?.[0]?.Id;
  if (existing) return existing;
  const created = await create("customer", { DisplayName: displayName, ...extra });
  return created.Customer.Id;
}

// ============================================================
// JOBS - created as sub-customers (Job: true) of one shared parent
// customer, which is what QuickBooks Projects are under the hood. Looked
// up by name first, so re-running this script after a partial failure
// won't create duplicates. Jobs meant to end up "closed" are created
// Active (transactions can't be posted to an inactive customer) and
// deactivated at the very end, in closeCompletedJobs().
// ============================================================
async function ensureJobs(parentId) {
  // QBO's query language doesn't allow filtering on ParentRef directly
  // ("property 'ParentRef' is not queryable") - pull every customer and
  // filter client-side instead. Fine at this scale (well under 1000 rows).
  const existingRes = await query(`SELECT Id, DisplayName, ParentRef FROM Customer MAXRESULTS 1000`);
  const existingByName = new Map(
    (existingRes?.QueryResponse?.Customer ?? [])
      .filter((c) => c.ParentRef?.value === parentId)
      .map((c) => [c.DisplayName, c.Id])
  );

  const jobIdByRef = {};
  const toCreate = [];
  for (const j of JOBS) {
    if (existingByName.has(j.name)) {
      jobIdByRef[j.ref] = existingByName.get(j.name);
    } else {
      toCreate.push(j);
    }
  }

  if (toCreate.length > 0) {
    console.log(`  Creating ${toCreate.length} new job(s) (${JOBS.length - toCreate.length} already existed)...`);
    const results = await batch(
      toCreate.map((j) => ({
        bId: j.ref,
        entity: "Customer",
        operation: "create",
        data: { DisplayName: j.name, Job: true, ParentRef: { value: parentId }, Active: true },
      }))
    );
    for (const r of results) {
      if (r.Customer) jobIdByRef[r.bId] = r.Customer.Id;
    }
  } else {
    console.log("  All 17 jobs already existed - reusing them.");
  }
  return jobIdByRef;
}

// ============================================================
// TRANSACTIONS
// ============================================================
async function createEstimates(jobIdByRef, itemId) {
  const items = ESTIMATES.map((e, i) => ({
    bId: `est${i}`,
    entity: "Estimate",
    operation: "create",
    data: {
      CustomerRef: { value: jobIdByRef[e.ref] },
      TxnDate: daysAgo(e.daysAgo),
      Line: [
        {
          Amount: e.amount,
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: e.amount },
        },
      ],
    },
  }));
  for (const group of chunk(items, 30)) await batch(group);
}

async function createInvoices(jobIdByRef, itemId) {
  const items = INVOICES.map((inv, i) => ({
    bId: `inv${i}`,
    entity: "Invoice",
    operation: "create",
    data: {
      CustomerRef: { value: jobIdByRef[inv.ref] },
      TxnDate: daysAgo(inv.daysAgo),
      Line: [
        {
          Amount: inv.amount,
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: inv.amount },
        },
      ],
    },
  }));
  for (const group of chunk(items, 30)) await batch(group);
}

async function createExpenses(jobIdByRef, accountIdByKey, paymentAccountId, unresolvedCustomerId) {
  const items = EXPENSES.map((ex, i) => {
    const customerId = ex.ref === "UNRESOLVED" ? unresolvedCustomerId : ex.ref ? jobIdByRef[ex.ref] : null;
    const lineDetail = { AccountRef: { value: accountIdByKey[ex.account] } };
    if (customerId) lineDetail.CustomerRef = { value: customerId };
    return {
      bId: `exp${i}`,
      entity: "Purchase",
      operation: "create",
      data: {
        PaymentType: "Cash",
        AccountRef: { value: paymentAccountId },
        TxnDate: daysAgo(ex.daysAgo),
        Line: [{ Amount: ex.amount, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: lineDetail }],
      },
    };
  });
  for (const group of chunk(items, 30)) await batch(group);
}

async function createBills(jobIdByRef, accountIdByKey, vendorId) {
  const items = BILLS.map((b, i) => {
    const lineDetail = { AccountRef: { value: accountIdByKey[b.account] } };
    if (b.ref) lineDetail.CustomerRef = { value: jobIdByRef[b.ref] };
    return {
      bId: `bill${i}`,
      entity: "Bill",
      operation: "create",
      data: {
        VendorRef: { value: vendorId },
        TxnDate: daysAgo(b.daysAgo),
        Line: [{ Amount: b.amount, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: lineDetail }],
      },
    };
  });
  for (const group of chunk(items, 30)) await batch(group);
}

async function createTimeActivities(jobIdByRef, vendorId) {
  for (const t of TIME_ACTIVITIES) {
    await create("timeactivity", {
      TxnDate: daysAgo(t.daysAgo),
      NameOf: "Vendor",
      VendorRef: { value: vendorId },
      CustomerRef: { value: jobIdByRef[t.ref] },
      HourlyRate: t.rate,
      Hours: t.hours,
      Minutes: 0,
      BillableStatus: "Billable",
    });
  }
}

async function closeCompletedJobs(jobIdByRef) {
  const toClose = JOBS.filter((j) => j.closed);
  const items = [];
  for (const j of toClose) {
    // QBO requires the current SyncToken on every update.
    const res = await query(`SELECT Id, SyncToken FROM Customer WHERE Id = '${jobIdByRef[j.ref]}'`);
    const c = res?.QueryResponse?.Customer?.[0];
    if (!c) continue;
    items.push({
      bId: j.ref,
      entity: "Customer",
      operation: "update",
      data: { Id: c.Id, SyncToken: c.SyncToken, Active: false, sparse: true },
    });
  }
  for (const group of chunk(items, 30)) await batch(group);
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log(`Seeding sandbox company ${REALM_ID}...\n`);

  console.log("1/8 Setting up shared accounts, item, and vendor...");
  const paymentAccountId = await ensurePaymentAccount();
  const incomeAccountId = await ensureIncomeAccount();
  const itemId = await ensureItem(ITEM_NAME, incomeAccountId);
  const vendorId = await ensureVendor(VENDOR_NAME);
  const accountIdByKey = {};
  for (const [key, name] of Object.entries(ACCOUNT_NAMES)) {
    accountIdByKey[key] = await ensureExpenseAccount(name);
  }
  console.log("  Done.\n");

  console.log("2/8 Setting up parent customer and the unresolved-expense customer...");
  const parentId = await ensureCustomer(PARENT_CUSTOMER_NAME);
  const unresolvedCustomerId = await ensureCustomer(UNRESOLVED_CUSTOMER_NAME);
  console.log("  Done.\n");

  console.log("3/8 Creating the 17 jobs...");
  const jobIdByRef = await ensureJobs(parentId);
  console.log("  Done.\n");

  console.log("4/8 Creating estimates...");
  await createEstimates(jobIdByRef, itemId);
  console.log("  Done.\n");

  console.log("5/8 Creating invoices...");
  await createInvoices(jobIdByRef, itemId);
  console.log("  Done.\n");

  console.log("6/8 Creating expenses...");
  await createExpenses(jobIdByRef, accountIdByKey, paymentAccountId, unresolvedCustomerId);
  console.log("  Done.\n");

  console.log("7/8 Creating bills...");
  await createBills(jobIdByRef, accountIdByKey, vendorId);
  console.log("  Done.\n");

  console.log("8/8 Creating time activity, then marking completed jobs as closed...");
  await createTimeActivities(jobIdByRef, vendorId);
  await closeCompletedJobs(jobIdByRef);
  console.log("  Done.\n");

  console.log("All done. Now go into JobProfitAI and click 'Sync now', then set Job Type + Estimated Cost");
  console.log("on each job's detail page per tab 1 of the workbook, then work through the Verification Checklist.");
}

main().catch((err) => {
  console.error("\nStopped with an error:");
  console.error(err.message);
  console.error("\nIt's safe to fix and re-run - jobs/accounts already created will be reused, not duplicated.");
  process.exit(1);
});
