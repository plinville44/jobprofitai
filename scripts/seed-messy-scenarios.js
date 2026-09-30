/**
 * JobProfitAI - messy real-world data seeder
 * ------------------------------------------
 * Adds the awkward cases real books are full of to the QuickBooks test
 * company, one small job per case so each job's figures are easy to check:
 * costs with no job on them, costs on a parent customer, a refund check to a
 * customer, a supplier refund, Construction in Progress, inventory used on a
 * job, income with no invoice, a vendor credit, a discount, two identical
 * expenses, time with and without a cost rate, the work in progress cases
 * (materials bought early, costs past the estimate, billed past the contract,
 * an expected loss, an overdue invoice, an idle job) and three pending
 * estimates for the Estimate Check.
 *
 * The checklist that says what JobProfitAI should show for each case is the
 * answer key that came with this script. The same records are simulated in
 * src/lib/__tests__/messyScenarios.test.ts, which runs this file against a
 * pretend QuickBooks and checks every figure in the answer key.
 *
 * How it differs from scripts/seed-test-company.js, which it is modelled on:
 *
 *  - It CREATES what it needs: new test customers and jobs (their names end
 *    in "(test)" or start with "MX"), two test employees, two test products,
 *    and a few accounts, but only when an account of that kind is missing.
 *    Everything is looked up by name first and reused, so a second run
 *    creates nothing twice.
 *  - Every transaction carries a marker like jpai-messy:refund-check:2 in its
 *    PrivateNote (Description, for time entries). A re-run reads the markers
 *    back first and skips what is already there.
 *  - Each case runs on its own. One that QuickBooks refuses is reported with
 *    QuickBooks' own message, and the rest carry on. The run ends with a
 *    count of what was created, skipped and failed.
 *  - It never changes or deletes anything it didn't create. It only reads
 *    the rest of the company.
 *
 * HOW TO RUN
 *   1. developer.intuit.com -> your app -> OAuth 2.0 Playground. Choose the
 *      PRODUCTION environment and the com.intuit.quickbooks.accounting scope,
 *      authorize the test company, and copy the access token and realm ID.
 *      The token lasts 60 minutes, so get it just before running.
 *
 *   2. PowerShell, from the project folder:
 *        $env:QBO_ACCESS_TOKEN="paste-token"
 *        $env:QBO_REALM_ID="paste-realm-id"
 *        node scripts/seed-messy-scenarios.js --dry-run
 *
 *      The dry run writes nothing. It prints every record it would create,
 *      with the exact data it would send, so a mistake shows up cheaply.
 *      When it looks right, run it again without --dry-run.
 *
 *   3. Optional, after the live run:
 *        node scripts/seed-messy-scenarios.js --inspect
 *
 *      Prints what QuickBooks actually stored for the details that matter
 *      most (cost rates on time entries, invoice numbers and due dates,
 *      estimate statuses), so you can see whether it kept them.
 *
 *   For safety, a live run stops unless the QuickBooks company's name has
 *   "test" in it. Add --any-company only if you are sure.
 *
 * Some of the data shapes sent to QuickBooks are marked "not verified"
 * below: they follow Intuit's v3 API as closely as known, but haven't been
 * tried against a real company yet. If QuickBooks refuses one, that case
 * fails with QuickBooks' message and the others still run.
 *
 * Requires Node 18+ for the built-in fetch. No npm install.
 */

const DAY = 86_400_000;
const MARK = "jpai-messy";
const MARK_RE = /jpai-messy:[a-z0-9-]+:\d+/g;
// The minor version the app itself reads with. CostRate on time entries
// needs 65 or later.
const MINOR_VERSION = 70;

// ============================================================
// THE DATA
// ============================================================

// Names match what the first seeder and QuickBooks' Construction chart of
// accounts created. Matched ignoring capitals and extra spaces.
const EXISTING = {
  vendors: { supply: "Coastal Supply Co", subs: "Delgado Tile and Stone" },
  accounts: { materials: "Job materials", subs: "Subcontractors", equipment: "Job equipment rental" },
  serviceItem: "Construction services",
};

const PARENTS = {
  oak: "Oakridge Homes (test)",
  birch: "Birchwood Builders (test)", // exactly two jobs: MX08 and MX09
  cedar: "Cedar Lane Owner (test)", // exactly one job: MX07
  walnut: "Walnut Street Prospect (test)", // no jobs: the pending estimates
};

const JOBS = {
  mx01: { name: "MX01 Early Materials", parent: "oak" },
  mx02: { name: "MX02 Past Estimate", parent: "oak" },
  mx03: { name: "MX03 Billed Past Contract", parent: "oak" },
  mx04: { name: "MX04 Expected Loss", parent: "oak" },
  mx05: { name: "MX05 Overdue Invoice", parent: "oak" },
  mx06: { name: "MX06 Idle Job", parent: "oak" },
  mx07: { name: "MX07 Parent Match", parent: "cedar" },
  mx08: { name: "MX08 Refund Check", parent: "birch" },
  mx09: { name: "MX09 Supplier Refund", parent: "birch" },
  mx10: { name: "MX10 Construction in Progress", parent: "oak" },
  mx11: { name: "MX11 Inventory Relief", parent: "oak" },
  mx12: { name: "MX12 Deposit Income", parent: "oak" },
  mx13: { name: "MX13 Journal Income", parent: "oak" },
  mx14: { name: "MX14 Vendor Credit", parent: "oak" },
  mx15: { name: "MX15 Discount Invoice", parent: "oak" },
  mx16: { name: "MX16 Duplicate Expenses", parent: "oak" },
  mx17: { name: "MX17 Crew Time", parent: "oak" },
};

const EMPLOYEES = {
  // Hours at a $60 cost rate (what the hour costs you), billed at $85.
  rated: { display: "MX Rated Crew (test)", given: "MX Rated", family: "Crew (test)", costRate: 60, billRate: 85 },
  // No cost rate at all: its hours cost nothing in JobProfitAI.
  unrated: { display: "MX Unrated Crew (test)", given: "MX Unrated", family: "Crew (test)", costRate: null, billRate: null },
};

const ITEMS = {
  // Sold installed at $450 a unit, costing $110 a unit to buy.
  tile: { name: "MX Tile materials (test)", type: "NonInventory", purchaseCost: 110, price: 450, expense: "materials" },
  // Labor sold by the hour. No purchase cost on purpose, so the Estimate
  // Check costs its hours at the company's average labor cost per hour.
  labor: { name: "MX Framing labor (test)", type: "Service", purchaseCost: null, price: 85, expense: null },
};

// ============================================================
// QuickBooks plumbing
// ============================================================

class QboError extends Error {
  constructor(status, path, fault, text) {
    const errors = Array.isArray(fault?.Error) ? fault.Error : [];
    const said = errors.map((e) => [e.Message, e.Detail].filter(Boolean).join(". ")).join(" | ");
    super(`QuickBooks refused it (${status}): ${said || text || "no message"}`);
    this.name = "QboError";
    this.status = status;
    this.path = path;
    this.errors = errors;
  }
}

function makeClient({ token, realm, fetchImpl }) {
  const base = `https://quickbooks.api.intuit.com/v3/company/${realm}`;
  async function call(path, options = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
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
    if (!res.ok || body?.Fault) throw new QboError(res.status, path, body?.Fault, typeof body === "string" ? body : "");
    return body;
  }
  const query = (sql) => call(`/query?query=${encodeURIComponent(sql)}&minorversion=${MINOR_VERSION}`);
  /** Every row of an entity, a page at a time. `where` is added as written. */
  async function queryAll(entity, where = "") {
    const out = [];
    for (let start = 1; ; start += 1000) {
      const res = await query(`SELECT * FROM ${entity}${where ? ` ${where}` : ""} STARTPOSITION ${start} MAXRESULTS 1000`);
      const rows = res?.QueryResponse?.[entity] ?? [];
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
  }
  const create = (entity, payload) =>
    call(`/${entity.toLowerCase()}?minorversion=${MINOR_VERSION}`, { method: "POST", body: JSON.stringify(payload) });
  const companyName = async () => {
    const res = await call(`/companyinfo/${realm}?minorversion=${MINOR_VERSION}`);
    return res?.CompanyInfo?.CompanyName ?? null;
  };
  return { query, queryAll, create, companyName };
}

const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const money = (n) => `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

// ============================================================
// The run
// ============================================================

/**
 * Runs every scenario. Returns { created, skipped, failed: [{ scenario, message }] }.
 * `fetchImpl` and `now` are there so the test can run this against a
 * pretend QuickBooks on a fixed clock.
 */
async function run({ token, realm, dryRun = false, inspect = false, anyCompany = false, fetchImpl = globalThis.fetch, now = Date.now(), log = console.log } = {}) {
  const qbo = makeClient({ token, realm, fetchImpl });
  const day = (n) => new Date(now - n * DAY).toISOString().slice(0, 10);
  const tally = { created: 0, skipped: 0, failed: [] };
  const warnings = [];
  const warn = (msg) => {
    warnings.push(msg);
    log(`  WARNING ${msg}`);
  };

  const company = await qbo.companyName().catch(() => null);
  log("JobProfitAI messy-data seeder");
  log(`Target: PRODUCTION QuickBooks, company ${realm}${company ? ` (${company})` : ""}`);
  log(dryRun ? "Mode:   dry run, nothing will be written\n" : inspect ? "Mode:   inspect, nothing will be written\n" : "Mode:   live, this writes to real books\n");
  if (!dryRun && !inspect && !anyCompany && !/test/i.test(company ?? "")) {
    log(`Stopped: this company's name (${company ?? "unknown"}) doesn't have "test" in it.`);
    log("This script is for the test company only. Add --any-company if you are sure.");
    tally.failed.push({ scenario: "safety check", message: "company name has no \"test\" in it" });
    return tally;
  }

  // ---------- What's already there ----------
  log("Reading what already exists...");
  const [accounts, vendors, customers, items, employees] = await Promise.all([
    qbo.queryAll("Account", "WHERE Active IN (true, false)"),
    qbo.queryAll("Vendor", "WHERE Active IN (true, false)"),
    qbo.queryAll("Customer", "WHERE Active IN (true, false)"),
    qbo.queryAll("Item", "WHERE Active IN (true, false)"),
    qbo.queryAll("Employee", "WHERE Active IN (true, false)"),
  ]);
  log(`  ${accounts.length} accounts, ${vendors.length} vendors, ${customers.length} customers, ${items.length} products and services, ${employees.length} employees.`);

  if (inspect) {
    await inspectRecords(qbo, log);
    return tally;
  }

  const seen = new Set();
  for (const entity of ["Purchase", "Bill", "VendorCredit", "JournalEntry", "Invoice", "SalesReceipt", "Deposit", "Estimate"]) {
    for (const row of await qbo.queryAll(entity)) for (const m of String(row.PrivateNote ?? "").match(MARK_RE) ?? []) seen.add(m);
  }
  for (const row of await qbo.queryAll("TimeActivity")) for (const m of String(row.Description ?? "").match(MARK_RE) ?? []) seen.add(m);
  if (seen.size) log(`  ${seen.size} records from an earlier run found; they will be skipped.`);

  // ---------- Creating or reusing names (each done once, then cached) ----------
  const cache = new Map();
  const once = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };
  const placeholder = (name) => `(id of new ${name})`;

  /** Writes one list record (customer, account, item...). In a dry run, returns a stand-in for its id. */
  async function createName(entity, label, payload) {
    if (dryRun) {
      tally.created++;
      log(`  would create ${entity} ${label}`);
      log(indent(JSON.stringify(payload, null, 2)));
      return placeholder(payload.DisplayName ?? payload.Name ?? label);
    }
    const res = await qbo.create(entity, payload);
    tally.created++;
    log(`  created ${entity} ${label}`);
    return res[entity];
  }

  const findAccount = (pred) => accounts.find((a) => a.Active !== false && pred(a));
  const byName = (name) => (a) => norm(a.Name) === norm(name) || norm(a.FullyQualifiedName) === norm(name);

  function account(key) {
    return once(`account:${key}`, async () => {
      if (EXISTING.accounts[key]) {
        const a = findAccount(byName(EXISTING.accounts[key]));
        if (!a) throw new Error(`The account "${EXISTING.accounts[key]}" isn't in the chart of accounts. It comes with QuickBooks' Construction chart of accounts.`);
        if (a.AccountType !== "Cost of Goods Sold") warn(`"${a.Name}" is a ${a.AccountType} account, not Cost of Goods Sold. JobProfitAI counts untagged costs on it as overhead, so the answer key's untagged figures won't match.`);
        return a.Id;
      }
      if (key === "bank") {
        const a = findAccount((x) => x.AccountType === "Bank");
        if (!a) throw new Error("There is no Bank account in this company. Add a Checking account in QuickBooks and run this again.");
        return a.Id;
      }
      if (key === "income") {
        // The income account "Construction services" sells to, as long as it
        // is an Income account: JobProfitAI leaves Other Income out of job
        // revenue, so the deposit and journal entry cases need Income.
        const service = await serviceItem();
        const own = service.incomeAccountId ? accounts.find((x) => String(x.Id) === String(service.incomeAccountId)) : null;
        if (own?.AccountType === "Income") return own.Id;
        const a = findAccount((x) => x.AccountType === "Income");
        if (!a) throw new Error("There is no Income account in this company.");
        return a.Id;
      }
      if (key === "office") {
        const a = findAccount((x) => x.AccountType === "Expense" && /office/i.test(x.Name));
        if (a) return a.Id;
        const made = await createName("Account", "Office supplies (Expense)", { Name: "Office supplies", AccountType: "Expense", AccountSubType: "OfficeGeneralAdministrativeExpenses" });
        return made.Id ?? made;
      }
      if (key === "refunds") {
        const a = findAccount((x) => x.AccountType === "Income" && /refund|allowance/i.test(x.Name));
        if (a) return a.Id;
        // Not verified: DiscountsRefundsGiven is Intuit's detail type for this.
        const made = await createName("Account", "Refunds and Allowances (Income)", { Name: "Refunds and Allowances", AccountType: "Income", AccountSubType: "DiscountsRefundsGiven" });
        return made.Id ?? made;
      }
      if (key === "cip") {
        const a = findAccount((x) => x.AccountType === "Other Current Asset" && /construction in progress|work in progress/i.test(x.Name));
        if (a) return a.Id;
        const made = await createName("Account", "Construction in Progress (Other Current Asset)", { Name: "Construction in Progress", AccountType: "Other Current Asset", AccountSubType: "OtherCurrentAssets" });
        return made.Id ?? made;
      }
      if (key === "inventory") {
        const a = findAccount((x) => x.AccountType === "Other Current Asset" && (x.AccountSubType === "Inventory" || /inventory/i.test(x.Name)));
        if (a) return a.Id;
        const made = await createName("Account", "Inventory Asset (Other Current Asset)", { Name: "Inventory Asset", AccountType: "Other Current Asset", AccountSubType: "Inventory" });
        return made.Id ?? made;
      }
      throw new Error(`Unknown account ${key}`);
    });
  }

  function vendor(key) {
    return once(`vendor:${key}`, async () => {
      const name = EXISTING.vendors[key];
      const v = vendors.find((x) => norm(x.DisplayName) === norm(name));
      if (v) return v.Id;
      const made = await createName("Vendor", name, { DisplayName: name });
      return made.Id ?? made;
    });
  }

  function serviceItem() {
    return once("item:service", async () => {
      const it = items.find((x) => norm(x.Name) === norm(EXISTING.serviceItem));
      if (it) return { id: it.Id, incomeAccountId: it.IncomeAccountRef?.value ?? null };
      const inc = findAccount((x) => x.AccountType === "Income");
      if (!inc) throw new Error("There is no Income account in this company.");
      const made = await createName("Item", EXISTING.serviceItem, { Name: EXISTING.serviceItem, Type: "Service", IncomeAccountRef: { value: inc.Id } });
      return { id: made.Id ?? made, incomeAccountId: inc.Id };
    });
  }

  function item(key) {
    if (key === "service") return serviceItem().then((s) => s.id);
    return once(`item:${key}`, async () => {
      const spec = ITEMS[key];
      const it = items.find((x) => norm(x.Name) === norm(spec.name));
      if (it) {
        const cost = Number(it.PurchaseCost ?? 0);
        if ((spec.purchaseCost ?? 0) !== cost) warn(`"${spec.name}" has a purchase cost of ${money(cost)}, not ${money(spec.purchaseCost ?? 0)}. The Estimate Check figures in the answer key assume ${money(spec.purchaseCost ?? 0)}.`);
        return it.Id;
      }
      const payload = {
        Name: spec.name,
        Type: spec.type,
        UnitPrice: spec.price,
        IncomeAccountRef: { value: await account("income") },
      };
      if (spec.purchaseCost != null) {
        // Not verified: a non-inventory product with purchasing details needs
        // an expense account alongside its purchase cost.
        payload.PurchaseCost = spec.purchaseCost;
        payload.ExpenseAccountRef = { value: await account(spec.expense) };
      }
      const made = await createName("Item", spec.name, payload);
      return made.Id ?? made;
    });
  }

  function employee(key) {
    return once(`employee:${key}`, async () => {
      const spec = EMPLOYEES[key];
      const e = employees.find((x) => norm(x.DisplayName) === norm(spec.display));
      if (e) {
        if (spec.costRate != null && Number(e.CostRate ?? 0) !== spec.costRate) warn(`${spec.display} has no ${money(spec.costRate)} cost rate on file. The time entries carry their own, which is what JobProfitAI reads.`);
        if (spec.costRate == null && Number(e.CostRate ?? 0) > 0) warn(`${spec.display} has a cost rate, so its "no rate" time entry may get one.`);
        return e.Id;
      }
      // Not verified: CostRate and BillRate on an employee (the cost rate is
      // what QuickBooks copies onto new time entries).
      const payload = { GivenName: spec.given, FamilyName: spec.family, DisplayName: spec.display };
      if (spec.costRate != null) payload.CostRate = spec.costRate;
      if (spec.billRate != null) {
        payload.BillableTime = true;
        payload.BillRate = spec.billRate;
      }
      const made = await createName("Employee", spec.display, payload);
      return made.Id ?? made;
    });
  }

  function parent(key) {
    return once(`parent:${key}`, async () => {
      const name = PARENTS[key];
      const c = customers.find((x) => norm(x.DisplayName) === norm(name));
      if (c) {
        if (c.Active === false) throw new Error(`The customer "${name}" is inactive in QuickBooks. Make it active and run this again.`);
        return c.Id;
      }
      const made = await createName("Customer", name, { DisplayName: name, CompanyName: name });
      return made.Id ?? made;
    });
  }

  function job(key) {
    return once(`job:${key}`, async () => {
      const spec = JOBS[key];
      const parentId = await parent(spec.parent);
      const c = customers.find((x) => norm(x.DisplayName) === norm(spec.name));
      if (c) {
        if (c.Active === false) throw new Error(`The job "${spec.name}" is inactive in QuickBooks. Make it active and run this again.`);
        if (c.Job !== true || String(c.ParentRef?.value ?? "") !== String(parentId)) {
          warn(`"${spec.name}" exists but isn't a job under ${PARENTS[spec.parent]}. Its figures may not match the answer key.`);
        }
        return c.Id;
      }
      // A sub-customer that is a job (Job: true), the way JobProfitAI's
      // "Projects or sub-customers" setting reads jobs.
      const made = await createName("Customer", `${spec.name} (job under ${PARENTS[spec.parent]})`, {
        DisplayName: spec.name,
        ParentRef: { value: parentId },
        Job: true,
        BillWithParent: false,
      });
      return made.Id ?? made;
    });
  }

  // ---------- Writing transactions ----------

  /**
   * Creates one transaction unless its marker is already in QuickBooks.
   * `check` looks at what QuickBooks stored and returns a warning or null.
   */
  async function make(scenario, n, label, entity, payload, check) {
    const marker = `${MARK}:${scenario}:${n}`;
    if (seen.has(marker)) {
      tally.skipped++;
      log(`  skip    ${label}  (already there)`);
      return null;
    }
    const body = { ...payload };
    if (entity === "TimeActivity") body.Description = `${payload.Description ?? "MX test time"} [${marker}]`;
    else body.PrivateNote = `MX test data, safe to delete [${marker}]`;
    if (dryRun) {
      tally.created++;
      log(`  would   ${label}`);
      log(indent(JSON.stringify(body, null, 2)));
      return null;
    }
    const res = await qbo.create(entity, body);
    tally.created++;
    seen.add(marker);
    const stored = res?.[entity];
    log(`  created ${label}${stored?.Id ? ` (Id ${stored.Id})` : ""}`);
    const problem = check && stored ? check(stored) : null;
    if (problem) warn(`${label}: ${problem}`);
    return stored;
  }

  // Line builders. Shapes from Intuit's v3 API reference.
  const costLine = (amount, accountId, customerId, description) => ({
    Amount: amount,
    DetailType: "AccountBasedExpenseLineDetail",
    ...(description ? { Description: description } : {}),
    AccountBasedExpenseLineDetail: { AccountRef: { value: accountId }, ...(customerId ? { CustomerRef: { value: customerId } } : {}) },
  });
  const saleLine = (amount, itemId, qty = 1, description) => ({
    Amount: amount,
    DetailType: "SalesItemLineDetail",
    ...(description ? { Description: description } : {}),
    SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: qty, UnitPrice: Math.round((amount / qty) * 100) / 100 },
  });
  const jeLine = (postingType, amount, accountId, customerId, description) => ({
    Amount: amount,
    DetailType: "JournalEntryLineDetail",
    ...(description ? { Description: description } : {}),
    JournalEntryLineDetail: {
      PostingType: postingType,
      AccountRef: { value: accountId },
      ...(customerId ? { Entity: { Type: "Customer", EntityRef: { value: customerId } } } : {}),
    },
  });

  /** Whether QuickBooks kept the job as the deposit line's "received from": without it JobProfitAI can't put the line on the job. */
  const depositNames = (customerId) => (s) =>
    String(s.Line?.[0]?.DepositLineDetail?.Entity?.value ?? "") === String(customerId)
      ? null
      : "QuickBooks didn't keep the job as the \"received from\" on the deposit line, so JobProfitAI won't see it on the job.";

  const ACCOUNT_LABEL = { materials: "Job materials", subs: "Subcontractors", equipment: "Job equipment rental", office: "office supplies", refunds: "refunds (income)", cip: "Construction in Progress", inventory: "inventory", bank: "bank", income: "income" };
  const target = (o) => (o.job ? JOBS[o.job].name : o.parent ? PARENTS[o.parent] : "no job");

  /** The customer id a line is tagged to: the job, the parent customer, or nobody. */
  const who = (o) => (o.job ? job(o.job) : o.parent ? parent(o.parent) : Promise.resolve(null));

  /** An expense (paid by cash), or a check with paymentType "Check". */
  async function expense(scenario, n, o) {
    const customerId = await who(o);
    const payload = {
      PaymentType: o.paymentType ?? "Cash",
      AccountRef: { value: await account("bank") },
      EntityRef: o.payeeJob ? { value: await job(o.payeeJob), type: "Customer" } : { value: await vendor(o.vendor ?? "supply"), type: "Vendor" },
      TxnDate: day(o.days),
      Line: [costLine(o.amount, await account(o.account), customerId, o.description)],
    };
    const kind = payload.PaymentType === "Check" ? "check" : "expense";
    return make(scenario, n, `${kind} ${money(o.amount)} ${ACCOUNT_LABEL[o.account]}, ${target(o)}`, "Purchase", payload);
  }

  async function bill(scenario, n, o) {
    const payload = {
      VendorRef: { value: await vendor(o.vendor ?? "supply") },
      TxnDate: day(o.days),
      DueDate: day(o.days - 30),
      Line: [costLine(o.amount, await account(o.account), await who(o), o.description)],
    };
    return make(scenario, n, `bill ${money(o.amount)} ${ACCOUNT_LABEL[o.account]}, ${target(o)}`, "Bill", payload);
  }

  async function salesReceipt(scenario, n, o) {
    // Not verified: with no DepositToAccountRef QuickBooks puts the money in
    // Undeposited Funds, which is what a receipt usually does.
    const payload = {
      CustomerRef: { value: await job(o.job) },
      TxnDate: day(o.days),
      Line: [saleLine(o.amount, await item("service"), 1, o.description ?? "Progress payment")],
    };
    return make(scenario, n, `sales receipt ${money(o.amount)}, ${target(o)}`, "SalesReceipt", payload);
  }

  async function invoice(scenario, n, o) {
    const lines = [saleLine(o.amount, await item("service"), 1, o.description ?? "Contract work")];
    // Not verified: a fixed-amount discount line. QuickBooks may refuse it
    // unless Discount is turned on in Account and settings, Sales.
    if (o.discount) lines.push({ Amount: o.discount, DetailType: "DiscountLineDetail", DiscountLineDetail: { PercentBased: false } });
    const payload = { CustomerRef: { value: await job(o.job) }, TxnDate: day(o.days), DueDate: day(o.dueDays), DocNumber: o.docNumber, Line: lines };
    const total = o.amount - (o.discount ?? 0);
    return make(scenario, n, `invoice ${o.docNumber} ${money(total)}, ${target(o)}`, "Invoice", payload, (s) => {
      const out = [];
      if (s.DocNumber !== o.docNumber) out.push(`stored invoice number ${s.DocNumber ?? "none"}, not ${o.docNumber}`);
      if (s.DueDate !== day(o.dueDays)) out.push(`stored due date ${s.DueDate ?? "none"}, not ${day(o.dueDays)}`);
      if (Math.abs(Number(s.TotalAmt) - total) > 0.005) out.push(`stored total ${money(s.TotalAmt)}, not ${money(total)}`);
      return out.length ? out.join("; ") : null;
    });
  }

  async function estimate(scenario, n, o) {
    const customerId = o.job ? await job(o.job) : await parent(o.parent);
    const lines = [];
    for (const l of o.lines) lines.push(saleLine(l.amount, await item(l.item), l.qty, l.description));
    // Not verified: TxnStatus "Accepted" set when the estimate is created.
    // If QuickBooks keeps it Pending instead, the job's contract value is the
    // same (it's the job's only estimate), but it also shows on the
    // Estimate Check.
    const payload = { CustomerRef: { value: customerId }, TxnDate: day(o.days), DocNumber: o.docNumber, TxnStatus: o.status, Line: lines };
    if (o.expiresInDays) payload.ExpirationDate = day(-o.expiresInDays);
    const total = o.lines.reduce((s, l) => s + l.amount, 0);
    return make(scenario, n, `estimate ${o.docNumber} ${money(total)} ${o.status}, ${target(o)}`, "Estimate", payload, (s) =>
      s.TxnStatus !== o.status ? `stored as ${s.TxnStatus ?? "no status"}, not ${o.status}` : null
    );
  }

  async function journal(scenario, n, o) {
    const lines = [];
    for (const l of o.lines) lines.push(jeLine(l.post, l.amount, await account(l.account), l.job ? await job(l.job) : null, l.description));
    return make(scenario, n, `journal entry ${money(o.lines[0].amount)} ${o.label}`, "JournalEntry", { TxnDate: day(o.days), Line: lines });
  }

  // ---------- The scenarios ----------
  const scenarios = [
    // --- Work in progress, forecast, money owed ---
    {
      key: "early-materials",
      title: "MX01: materials bought early, little billed, no percent complete",
      run: async (k) => {
        await estimate(k, 1, { job: "mx01", days: 35, docNumber: "MX-E101", status: "Accepted", lines: [{ item: "service", amount: 60000, qty: 1, description: "Addition, fixed price" }] });
        await bill(k, 2, { job: "mx01", account: "materials", amount: 18000, days: 10, description: "Framing and window package delivered" });
        await salesReceipt(k, 3, { job: "mx01", amount: 6000, days: 8, description: "Deposit at signing" });
      },
    },
    {
      key: "past-estimate",
      title: "MX02: costs past the cost estimate, no percent complete",
      run: async (k) => {
        await estimate(k, 1, { job: "mx02", days: 45, docNumber: "MX-E102", status: "Accepted", lines: [{ item: "service", amount: 40000, qty: 1 }] });
        await bill(k, 2, { job: "mx02", vendor: "subs", account: "subs", amount: 22000, days: 20 });
        await expense(k, 3, { job: "mx02", account: "materials", amount: 12000, days: 15 });
        await salesReceipt(k, 4, { job: "mx02", amount: 24000, days: 10 });
      },
    },
    {
      key: "billed-past-contract",
      title: "MX03: billed past the contract",
      run: async (k) => {
        await estimate(k, 1, { job: "mx03", days: 50, docNumber: "MX-E103", status: "Accepted", lines: [{ item: "service", amount: 30000, qty: 1 }] });
        await salesReceipt(k, 2, { job: "mx03", amount: 20000, days: 25 });
        await bill(k, 3, { job: "mx03", vendor: "subs", account: "subs", amount: 15000, days: 20 });
        await expense(k, 4, { job: "mx03", account: "materials", amount: 6000, days: 12 });
        await salesReceipt(k, 5, { job: "mx03", amount: 13500, days: 6, description: "Extra work the customer asked for" });
      },
    },
    {
      key: "expected-loss",
      title: "MX04: cost estimate above the contract (expected loss)",
      run: async (k) => {
        await estimate(k, 1, { job: "mx04", days: 40, docNumber: "MX-E104", status: "Accepted", lines: [{ item: "service", amount: 50000, qty: 1 }] });
        await bill(k, 2, { job: "mx04", vendor: "subs", account: "subs", amount: 20000, days: 18 });
        await expense(k, 3, { job: "mx04", account: "materials", amount: 10000, days: 14 });
        await salesReceipt(k, 4, { job: "mx04", amount: 25000, days: 9 });
      },
    },
    {
      key: "overdue-invoice",
      title: "MX05: an invoice 45 days past due",
      run: async (k) => {
        await invoice(k, 1, { job: "mx05", amount: 8000, days: 75, dueDays: 45, docNumber: "MX-1005" });
        await expense(k, 2, { job: "mx05", account: "materials", amount: 3000, days: 20 });
      },
    },
    {
      key: "idle-job",
      title: "MX06: an open job with nothing for 150+ days",
      run: async (k) => {
        await estimate(k, 1, { job: "mx06", days: 200, docNumber: "MX-E106", status: "Accepted", lines: [{ item: "service", amount: 20000, qty: 1 }] });
        await expense(k, 2, { job: "mx06", account: "materials", amount: 7000, days: 170 });
        await salesReceipt(k, 3, { job: "mx06", amount: 10000, days: 160 });
      },
    },

    // --- Reading costs and revenue ---
    {
      key: "untagged",
      title: "Job costs on no job, and office supplies on no job",
      run: async (k) => {
        await bill(k, 1, { vendor: "subs", account: "subs", amount: 3200, days: 12, description: "MX test: tile sub, no job picked" });
        await expense(k, 2, { account: "materials", amount: 1900, days: 9, description: "MX test: lumber, no job picked" });
        await expense(k, 3, { paymentType: "Check", account: "equipment", amount: 960, days: 6, description: "MX test: lift rental, no job picked" });
        await expense(k, 4, { account: "office", amount: 230, days: 5, description: "MX test: printer paper and ink" });
      },
    },
    {
      key: "parent-one-job",
      title: "MX07: a cost on a parent customer that has one job",
      run: async (k) => {
        await salesReceipt(k, 1, { job: "mx07", amount: 2500, days: 10 });
        await expense(k, 2, { parent: "cedar", account: "materials", amount: 800, days: 8, description: "MX test: tagged to the customer, not the job" });
      },
    },
    {
      key: "parent-two-jobs",
      title: "A cost on a parent customer that has two jobs",
      run: async (k) => {
        // Both jobs first, so the parent really has two when the cost lands.
        await job("mx08");
        await job("mx09");
        await expense(k, 1, { parent: "birch", account: "materials", amount: 450, days: 11, description: "MX test: tagged to the customer, which has two jobs" });
      },
    },
    {
      key: "refund-check",
      title: "MX08: a refund check to the customer, to an income account",
      run: async (k) => {
        await salesReceipt(k, 1, { job: "mx08", amount: 6000, days: 14 });
        await expense(k, 2, { job: "mx08", account: "materials", amount: 2000, days: 13 });
        // Paid to the customer, posted to an income account, tagged to the job.
        await expense(k, 3, { job: "mx08", payeeJob: "mx08", paymentType: "Check", account: "refunds", amount: 500, days: 7, description: "MX test: refund for a cancelled window" });
      },
    },
    {
      key: "supplier-refund",
      title: "MX09: a supplier refund deposited to a cost account",
      run: async (k) => {
        await salesReceipt(k, 1, { job: "mx09", amount: 5000, days: 15 });
        await bill(k, 2, { job: "mx09", account: "materials", amount: 1800, days: 14 });
        // Not verified: the job as the "received from" on the deposit line,
        // which is how a deposit names a customer.
        const customerId = await job("mx09");
        await make(k, 3, "deposit $300 Job materials, received from MX09", "Deposit", {
          DepositToAccountRef: { value: await account("bank") },
          TxnDate: day(6),
          Line: [
            {
              Amount: 300,
              DetailType: "DepositLineDetail",
              Description: "MX test: supplier refund for returned tile",
              DepositLineDetail: { AccountRef: { value: await account("materials") }, Entity: { value: customerId, type: "Customer" } },
            },
          ],
        }, depositNames(customerId));
      },
    },
    {
      key: "construction-in-progress",
      title: "MX10: a bill to Construction in Progress, then the closing journal entry",
      run: async (k) => {
        await salesReceipt(k, 1, { job: "mx10", amount: 15000, days: 20 });
        await bill(k, 2, { job: "mx10", vendor: "subs", account: "cip", amount: 10000, days: 18, description: "MX test: sub work held in Construction in Progress" });
        await journal(k, 3, {
          days: 6,
          label: "MX10 close Construction in Progress to Subcontractors",
          lines: [
            { post: "Debit", amount: 10000, account: "subs", job: "mx10", description: "MX test: move finished job cost to cost of goods sold" },
            { post: "Credit", amount: 10000, account: "cip", job: "mx10", description: "MX test: move finished job cost to cost of goods sold" },
          ],
        });
      },
    },
    {
      key: "inventory-relief",
      title: "MX11: inventory used on a job, by journal entry",
      run: async (k) => {
        await salesReceipt(k, 1, { job: "mx11", amount: 4000, days: 16 });
        // Not verified: QuickBooks may warn about journal entries to an
        // inventory account; this moves dollars only, no quantities.
        await journal(k, 2, {
          days: 10,
          label: "MX11 inventory used on the job",
          lines: [
            { post: "Debit", amount: 1200, account: "materials", job: "mx11", description: "MX test: tile taken from stock" },
            { post: "Credit", amount: 1200, account: "inventory", job: "mx11", description: "MX test: tile taken from stock" },
          ],
        });
      },
    },
    {
      key: "deposit-income",
      title: "MX12: a customer payment deposited with no invoice",
      run: async (k) => {
        await expense(k, 1, { job: "mx12", account: "materials", amount: 1000, days: 11 });
        const customerId = await job("mx12");
        await make(k, 2, "deposit $3,000 to income, received from MX12", "Deposit", {
          DepositToAccountRef: { value: await account("bank") },
          TxnDate: day(9),
          Line: [
            {
              Amount: 3000,
              DetailType: "DepositLineDetail",
              Description: "MX test: customer check, no invoice",
              DepositLineDetail: { AccountRef: { value: await account("income") }, Entity: { value: customerId, type: "Customer" } },
            },
          ],
        }, depositNames(customerId));
      },
    },
    {
      key: "journal-income",
      title: "MX13: a journal entry crediting income and naming the job",
      run: async (k) => {
        await expense(k, 1, { job: "mx13", account: "materials", amount: 700, days: 12 });
        await journal(k, 2, {
          days: 8,
          label: "MX13 income by journal entry",
          lines: [
            { post: "Debit", amount: 2500, account: "bank", description: "MX test: cash received, recorded by journal entry" },
            { post: "Credit", amount: 2500, account: "income", job: "mx13", description: "MX test: cash received, recorded by journal entry" },
          ],
        });
      },
    },
    {
      key: "vendor-credit",
      title: "MX14: a vendor credit on the job",
      run: async (k) => {
        await salesReceipt(k, 1, { job: "mx14", amount: 4500, days: 17 });
        await bill(k, 2, { job: "mx14", account: "materials", amount: 2200, days: 16 });
        await make(k, 3, "vendor credit $350 Job materials MX14", "VendorCredit", {
          VendorRef: { value: await vendor("supply") },
          TxnDate: day(7),
          Line: [costLine(350, await account("materials"), await job("mx14"), "MX test: credit for damaged boards")],
        });
      },
    },
    {
      key: "discount-invoice",
      title: "MX15: an invoice with a discount line",
      run: async (k) => {
        await invoice(k, 1, { job: "mx15", amount: 5000, discount: 250, days: 10, dueDays: -20, docNumber: "MX-1015" });
        await expense(k, 2, { job: "mx15", account: "materials", amount: 1500, days: 9 });
      },
    },
    {
      key: "duplicate-expenses",
      title: "MX16: the same expense entered twice",
      run: async (k) => {
        await salesReceipt(k, 1, { job: "mx16", amount: 3000, days: 12 });
        await expense(k, 2, { job: "mx16", account: "materials", amount: 640, days: 7, description: "MX test: drywall" });
        await expense(k, 3, { job: "mx16", account: "materials", amount: 640, days: 7, description: "MX test: drywall" });
      },
    },
    {
      key: "time-entries",
      title: "MX17: 40 hours with a cost rate, 6 hours with none",
      run: async (k) => {
        await salesReceipt(k, 1, { job: "mx17", amount: 4000, days: 12 });
        const jobId = await job("mx17");
        const laborItem = await item("labor");
        const rated = await employee("rated");
        // Billable, with the bill rate: QuickBooks drops a rate it doesn't
        // think is billable (see seed-test-company.js). Not verified: that
        // CostRate set here is kept as sent.
        for (const [i, d] of [12, 11, 10, 9, 8].entries()) {
          await make(k, 2 + i, `time 8 h at $60 cost rate, MX17 (day ${i + 1} of 5)`, "TimeActivity", {
            TxnDate: day(d),
            NameOf: "Employee",
            EmployeeRef: { value: rated },
            CustomerRef: { value: jobId },
            ItemRef: { value: laborItem },
            BillableStatus: "Billable",
            HourlyRate: EMPLOYEES.rated.billRate,
            CostRate: EMPLOYEES.rated.costRate,
            Hours: 8,
            Minutes: 0,
            Description: "MX crew time",
          }, (s) => (Number(s.CostRate ?? 0) !== EMPLOYEES.rated.costRate ? `stored cost rate ${s.CostRate ?? "none"}, not $60. JobProfitAI will count these hours as having no cost rate.` : null));
        }
        await make(k, 7, "time 6 h with no cost rate, MX17", "TimeActivity", {
          TxnDate: day(10),
          NameOf: "Employee",
          EmployeeRef: { value: await employee("unrated") },
          CustomerRef: { value: jobId },
          BillableStatus: "NotBillable",
          Hours: 6,
          Minutes: 0,
          Description: "MX crew time, no rate",
        }, (s) => (Number(s.CostRate ?? 0) > 0 ? `stored a cost rate of ${s.CostRate}; it was meant to have none.` : null));
      },
    },

    // --- Estimate Check ---
    {
      key: "estimate-check",
      title: "Three pending estimates for the Estimate Check",
      run: async (k) => {
        await estimate(k, 1, {
          parent: "walnut",
          days: 3,
          expiresInDays: 30,
          docNumber: "MX-E1",
          status: "Pending",
          lines: [{ item: "tile", qty: 30, amount: 13500, description: "Tile, supplied and installed" }],
        });
        await estimate(k, 2, {
          parent: "walnut",
          days: 3,
          expiresInDays: 30,
          docNumber: "MX-E2",
          status: "Pending",
          lines: [{ item: "labor", qty: 40, amount: 3400, description: "Framing, by the hour" }],
        });
        await estimate(k, 3, {
          parent: "walnut",
          days: 3,
          expiresInDays: 30,
          docNumber: "MX-E3",
          status: "Pending",
          lines: [
            { item: "labor", qty: 1, amount: 4000, description: "Framing, all in" },
            { item: "tile", qty: 1, amount: 6000, description: "Tile, all in" },
          ],
        });
      },
    },
  ];

  for (const s of scenarios) {
    log(`\n${s.title}`);
    try {
      await s.run(s.key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tally.failed.push({ scenario: s.key, message });
      log(`  FAILED  ${message}`);
      if (err instanceof QboError && err.status === 401) log("  The access token has expired (they last 60 minutes). Get a fresh one and run this again.");
    }
  }

  log(`\nDone. ${tally.created} ${dryRun ? "would be created" : "created"}, ${tally.skipped} skipped (already there), ${tally.failed.length} failed.`);
  for (const f of tally.failed) log(`  failed: ${f.scenario}: ${f.message}`);
  if (warnings.length) log(`${warnings.length} warning${warnings.length === 1 ? "" : "s"} above: read them before checking the answer key.`);
  if (!dryRun && tally.failed.length === 0) log("\nNext: press Sync now in JobProfitAI, then work through the answer key.");
  if (tally.failed.length) log("\nAnything created is marked, so running this again after a fix creates only what is missing.");
  return { ...tally, warnings };
}

/** Prints what QuickBooks stored for the details this script cares about most. */
async function inspectRecords(qbo, log) {
  const mine = (s) => /jpai-messy:[a-z0-9-]+:\d+/.test(String(s ?? ""));
  log("\nTime entries from this script:");
  for (const t of await qbo.queryAll("TimeActivity")) {
    if (!mine(t.Description)) continue;
    const hours = Number(t.Hours ?? 0) + Number(t.Minutes ?? 0) / 60;
    log(`  ${t.TxnDate}  ${t.EmployeeRef?.name ?? "?"}  ${hours} h  cost rate ${t.CostRate ?? "NONE"}  bill rate ${t.HourlyRate ?? "none"}  ${t.BillableStatus}`);
  }
  log("\nInvoices from this script:");
  for (const i of await qbo.queryAll("Invoice")) {
    if (!mine(i.PrivateNote)) continue;
    log(`  number ${i.DocNumber ?? "none"}  dated ${i.TxnDate}  due ${i.DueDate ?? "none"}  total ${money(i.TotalAmt)}  unpaid ${money(i.Balance)}`);
  }
  log("\nEstimates from this script:");
  for (const e of await qbo.queryAll("Estimate")) {
    if (!mine(e.PrivateNote)) continue;
    log(`  number ${e.DocNumber ?? "none"}  ${e.CustomerRef?.name ?? "?"}  ${money(e.TotalAmt)}  status ${e.TxnStatus ?? "none"}`);
  }
}

function indent(text) {
  return text
    .split("\n")
    .map((l) => `            ${l}`)
    .join("\n");
}

module.exports = { run, PARENTS, JOBS, EMPLOYEES, ITEMS, MARK };

async function main() {
  const token = process.env.QBO_ACCESS_TOKEN;
  const realm = process.env.QBO_REALM_ID;
  if (!token || !realm) {
    console.error("Missing QBO_ACCESS_TOKEN or QBO_REALM_ID. See the comment at the top of this file.");
    process.exit(1);
  }
  if (typeof globalThis.fetch !== "function") {
    console.error("This needs Node 18 or later (for the built-in fetch). Run node --version to check.");
    process.exit(1);
  }
  const result = await run({
    token,
    realm,
    dryRun: process.argv.includes("--dry-run"),
    inspect: process.argv.includes("--inspect"),
    anyCompany: process.argv.includes("--any-company"),
  });
  process.exit(result.failed.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nFailed:", err instanceof Error ? err.message : err);
    console.error("\nIf this is a 401, the access token expired. They last 60 minutes. Get a fresh one and run this again.");
    console.error("Anything already written is marked, so running it again does not duplicate it.");
    process.exit(1);
  });
}
