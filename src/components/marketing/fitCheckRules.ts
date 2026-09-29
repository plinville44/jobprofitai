import { PLANS } from "@/lib/plans";

/**
 * The questions and answers behind the "Will this work with my QuickBooks?"
 * check (FitCheck.tsx). Kept free of React so a test can hold every line to
 * what the product does.
 *
 * What the product does, and so all this may promise: it reads QuickBooks
 * Online only; jobs come from Projects or sub-customers, one customer per
 * job, or Classes; labor comes from time entries at the cost rate on each
 * entry (the employee's cost rate in QuickBooks), and an entry with no cost
 * rate adds nothing. Nothing else.
 */

export type Level = "good" | "change" | "no";

export interface Option {
  value: string;
  label: string;
}

export interface Question {
  id: "qb" | "jobs" | "costs" | "labor" | "open" | "companies";
  q: string;
  options: Option[];
}

export const QUESTIONS: Question[] = [
  {
    id: "qb",
    q: "Which QuickBooks do you use?",
    options: [
      { value: "online", label: "QuickBooks Online" },
      { value: "desktop", label: "QuickBooks Desktop" },
      { value: "unsure", label: "Not sure" },
    ],
  },
  {
    id: "jobs",
    q: "How do you keep each job separate in QuickBooks?",
    options: [
      { value: "projects", label: "A Project for each job" },
      { value: "customers", label: "A customer or sub-customer for each job" },
      { value: "classes", label: "A Class for each job" },
      { value: "client", label: "One customer per client, jobs not split out" },
      { value: "none", label: "Jobs aren't in QuickBooks" },
    ],
  },
  {
    id: "costs",
    q: "When you enter bills, expenses and checks for a job's materials and subs, do you pick the job on them?",
    options: [
      { value: "always", label: "Always or nearly always" },
      { value: "sometimes", label: "Sometimes" },
      { value: "rarely", label: "Rarely" },
    ],
  },
  {
    id: "labor",
    q: "How does your crew's time get into QuickBooks?",
    options: [
      { value: "time", label: "Time entries by job" },
      { value: "payroll", label: "Payroll only, not split by job" },
      { value: "subs", label: "We mostly use subcontractors" },
      { value: "owner", label: "It's just me, or labor isn't tracked" },
    ],
  },
  {
    id: "open",
    q: "How many jobs do you usually have open at once?",
    options: [
      { value: "under25", label: "Fewer than 25" },
      { value: "25to100", label: "25 to 100" },
      { value: "over100", label: "More than 100" },
    ],
  },
  {
    // Bookkeepers answer with their client count. A bookkeeper with 2 or 3
    // clients belongs on Pro, which covers 3 companies for less than Firm's
    // 4-company minimum, so being a bookkeeper is not an answer on its own.
    id: "companies",
    q: "How many QuickBooks companies (separate sets of books) will you connect? Bookkeepers: one for each contractor client.",
    options: [
      { value: "1", label: "One" },
      { value: "2to3", label: "2 or 3" },
      { value: "4plus", label: "4 or more" },
    ],
  },
];

export type Answers = Partial<Record<Question["id"], string>>;

export interface Note {
  level: Level;
  text: string;
}

export function notesFor(a: Answers): Note[] {
  const notes: Note[] = [];
  if (a.qb === "desktop") {
    notes.push({ level: "no", text: "JobProfitAI connects to QuickBooks Online only. QuickBooks Desktop (Pro, Premier or Enterprise) isn't supported." });
  } else if (a.qb === "unsure") {
    notes.push({
      level: "change",
      text: "If you sign in to QuickBooks in a web browser, it's QuickBooks Online and it works. If you open it from a program installed on your computer, it's usually Desktop, which isn't supported.",
    });
  }

  if (a.jobs === "projects") notes.push({ level: "good", text: "Projects are what JobProfitAI reads by default. Nothing to change." });
  // The first sync switches to one customer per job only when the company
  // has no Projects or sub-customers at all (quickbooksSync.ts).
  if (a.jobs === "customers")
    notes.push({
      level: "good",
      text: "That works. Sub-customers are read as jobs by default. If you make one customer per job and have no Projects or sub-customers, that's picked up on the first sync; otherwise choose One customer per job in Settings.",
    });
  if (a.jobs === "classes")
    notes.push({
      level: "good",
      text: "Classes work. Choose Classes as your job setting (in Settings, or when the dashboard asks) and costs and sales are matched by the class on each line.",
    });
  if (a.jobs === "client")
    notes.push({
      level: "change",
      text: "Each customer is read as one job, so you'd see profit by client rather than by job. For profit on each job, add a Project for each new job (QuickBooks Online Plus or Advanced) and pick it on the job's bills and invoices.",
    });
  if (a.jobs === "none")
    notes.push({
      level: "no",
      text: "JobProfitAI reads jobs from QuickBooks, so they need to be there first: a Project or a customer for each job, picked on its bills, expenses and invoices.",
    });

  if (a.costs === "always") notes.push({ level: "good", text: "Costs picked on the job are what makes profit per job accurate. You're set." });
  if (a.costs === "sometimes")
    notes.push({
      level: "good",
      text: "That works. The Data Health page lists each cost from the last 12 months that isn't on a job, biggest first, so you can fix the ones that matter.",
    });
  if (a.costs === "rarely")
    notes.push({
      level: "change",
      text: "Profit per job will look higher than it really is until costs are picked on the job. The Data Health page lists each cost from the last 12 months that isn't on a job, biggest first, so you can see the size of the gap.",
    });

  if (a.labor === "time")
    notes.push({
      level: "good",
      text: "Time entries are costed at the cost rate on each entry, which comes from each employee's cost rate in QuickBooks. Each employee needs a cost rate there for their time to count. If those rates are just wages, add your labor burden (payroll taxes, workers' comp, benefits) in Settings; if they already include it, leave the burden at 0.",
    });
  if (a.labor === "payroll")
    notes.push({
      level: "change",
      text: "Paychecks alone don't say which job the hours went to, so labor won't show on your jobs and margins will read too high. Record time by job (timesheets or QuickBooks Time), with a cost rate set for each employee in QuickBooks, or post payroll to jobs with journal entries that name the job.",
    });
  if (a.labor === "subs") notes.push({ level: "good", text: "Subcontractor bills picked on the job count as subcontractor cost on that job." });
  if (a.labor === "owner")
    notes.push({ level: "good", text: "Margins won't include your own time. That's normal for an owner-operator; set your target margin with it in mind." });

  return notes;
}

export interface PlanPick {
  name: string;
  price: string;
  why: string;
  href: string;
  cta: string;
}

export function planFor(a: Answers): PlanPick | null {
  if (!a.open || !a.companies) return null;
  const std = PLANS.profit_intelligence;
  const pro = PLANS.profit_intelligence_pro;
  const firm = PLANS.firm;
  const firmMin = firm.perCompany!.minCompanies;
  if (a.companies === "4plus") {
    return {
      name: firm.name,
      price: `${firm.priceLabel} per company/month, ${firmMin} minimum`,
      why: `Every company in one login, with a portfolio view of all of them and view-only logins for your clients. The free trial covers ${pro.limits.maxConnections} companies, client logins included; choose ${firm.name} to connect the rest.`,
      href: "/pricing#firm",
      cta: `See the ${firm.name} plan`,
    };
  }
  if (a.companies === "2to3" || a.open === "over100") {
    return {
      name: pro.name,
      price: `${pro.priceLabel}/month`,
      why:
        a.companies === "2to3"
          ? `It covers up to ${pro.limits.maxConnections} QuickBooks companies, all on one portfolio page, unlimited open jobs, and forecasts on jobs in progress. Bookkeepers with 2 or 3 clients: this costs less than ${firm.name}, which starts at ${firmMin} companies and adds view-only logins for your clients.`
          : `More than ${std.limits.maxActiveJobs} open jobs needs unlimited jobs. Pro also forecasts where each job in progress will finish.`,
      href: "/signup",
      cta: "Start your free trial",
    };
  }
  return {
    name: std.name,
    price: `${std.priceLabel}/month`,
    why:
      a.open === "25to100"
        ? `It covers up to ${std.limits.maxActiveJobs} open jobs. Finished jobs don't count, and jobs with no activity in 90 days can be marked finished in one click. If you go over, we'll ask you to move to Pro; nothing stops working. Choose Pro if you want forecasts on jobs in progress.`
        : `It covers up to ${std.limits.maxActiveJobs} open jobs, plenty of room. Choose Pro if you want forecasts on jobs in progress.`,
    href: "/signup",
    cta: "Start your free trial",
  };
}
