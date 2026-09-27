"use client";

import { useState } from "react";
import Link from "next/link";
import { PLANS } from "@/lib/plans";

/**
 * "Will this work with my QuickBooks?" Six one-tap questions, about thirty
 * seconds, and an honest answer: a good fit, works with one change, or not a
 * fit yet, with what each answer means and the plan that fits.
 *
 * Every line here has to match what the product does. It reads QuickBooks
 * Online only; jobs from Projects, one customer per job, or Classes; labor
 * from time entries at each person's pay rate. Nothing else.
 */

type Level = "good" | "change" | "no";

interface Option {
  value: string;
  label: string;
}

interface Question {
  id: "qb" | "jobs" | "costs" | "labor" | "open" | "companies";
  q: string;
  options: Option[];
}

const QUESTIONS: Question[] = [
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
    id: "companies",
    q: "How many QuickBooks companies (separate sets of books)?",
    options: [
      { value: "1", label: "One" },
      { value: "2to3", label: "2 or 3" },
      { value: "4plus", label: "4 or more" },
    ],
  },
];

type Answers = Partial<Record<Question["id"], string>>;

interface Note {
  level: Level;
  text: string;
}

function notesFor(a: Answers): Note[] {
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
  if (a.jobs === "customers") notes.push({ level: "good", text: "One customer per job works. It's picked up on the first sync, and you can switch in Settings." });
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
    notes.push({ level: "good", text: "That works. The Data Health page lists every cost from the last 12 months that isn't on a job, so you can fix the ones that matter." });
  if (a.costs === "rarely")
    notes.push({
      level: "change",
      text: "Profit per job will look higher than it really is until costs are picked on the job. Data Health lists every untagged cost from the last 12 months so you can see the size of the gap.",
    });

  if (a.labor === "time")
    notes.push({ level: "good", text: "Time entries are costed at each person's pay rate, with your labor burden (payroll taxes, workers' comp, benefits) added on top if you set one." });
  if (a.labor === "payroll")
    notes.push({
      level: "change",
      text: "Paychecks alone don't say which job the hours went to, so labor won't show on your jobs and margins will read too high. Record time by job (timesheets or QuickBooks Time) and it's costed at each person's pay rate, or post payroll to jobs with journal entries that name the job.",
    });
  if (a.labor === "subs") notes.push({ level: "good", text: "Subcontractor bills picked on the job count as subcontractor cost on that job." });
  if (a.labor === "owner")
    notes.push({ level: "good", text: "Margins won't include your own time. That's normal for an owner-operator; set your target margin with it in mind." });

  return notes;
}

function planFor(a: Answers): { name: string; price: string; why: string; href: string; cta: string } | null {
  if (!a.open || !a.companies) return null;
  if (a.companies === "4plus") {
    return {
      name: "Talk to us",
      price: "",
      why: "The plans cover up to 3 QuickBooks companies. If you're a bookkeeper or accountant with contractor clients, or run more companies than that, get in touch and we'll set you up.",
      href: "/contact",
      cta: "Get in touch",
    };
  }
  const pro = PLANS.profit_intelligence_pro;
  const std = PLANS.profit_intelligence;
  if (a.companies === "2to3" || a.open === "over100") {
    return {
      name: pro.name,
      price: `${pro.priceLabel}/month`,
      why:
        a.companies === "2to3"
          ? "It covers up to 3 QuickBooks companies, unlimited open jobs, and forecasts on jobs in progress."
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
        ? `It covers up to ${std.limits.maxActiveJobs} open jobs. Finished jobs don't count, and jobs with no activity in 90 days can be marked finished in one click. Choose Pro if you want forecasts on jobs in progress.`
        : `It covers up to ${std.limits.maxActiveJobs} open jobs, plenty of room. Choose Pro if you want forecasts on jobs in progress.`,
    href: "/signup",
    cta: "Start your free trial",
  };
}

const VERDICT: Record<Level, { title: string; body: string; tone: string }> = {
  good: {
    title: "Good fit",
    body: "Your QuickBooks is set up the way JobProfitAI reads it. Connect it and you'll see your jobs after the first sync.",
    tone: "border-jp-green/40 bg-green-50",
  },
  change: {
    title: "Works, with a change",
    body: "JobProfitAI will read your books, and the notes below say what to change to get accurate job profit. The trial is a good way to see how close you are.",
    tone: "border-amber-300 bg-amber-50",
  },
  no: {
    title: "Not a fit yet",
    body: "Something below stops JobProfitAI from reading your jobs today. It's better to know that now than after you sign up.",
    tone: "border-red-200 bg-red-50",
  },
};

const DOT: Record<Level, string> = { good: "bg-jp-green", change: "bg-amber-500", no: "bg-red-500" };

export default function FitCheck() {
  const [answers, setAnswers] = useState<Answers>({});
  const answered = QUESTIONS.filter((q) => answers[q.id]).length;
  const done = answered === QUESTIONS.length;
  const notes = notesFor(answers);
  const level: Level = notes.some((n) => n.level === "no") ? "no" : notes.some((n) => n.level === "change") ? "change" : "good";
  const plan = planFor(answers);
  const verdict = VERDICT[level];

  return (
    <div className="mx-auto max-w-3xl rounded-2xl border border-jp-line bg-white p-6 sm:p-8">
      <ol className="space-y-6">
        {QUESTIONS.map((question, i) => (
          <li key={question.id}>
            <p className="text-[15px] font-semibold text-jp-ink">
              <span className="mr-2 text-jp-muted">{i + 1}.</span>
              {question.q}
            </p>
            <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label={question.q}>
              {question.options.map((o) => {
                const selected = answers[question.id] === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setAnswers((prev) => ({ ...prev, [question.id]: o.value }))}
                    className={`rounded-full border px-4 py-2 text-sm transition-colors ${
                      selected
                        ? "border-jp-blue bg-jp-blue text-white"
                        : "border-jp-line bg-white text-jp-slate hover:border-jp-blue hover:text-jp-blue"
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-8 border-t border-jp-line pt-6" aria-live="polite">
        {!done ? (
          <p className="text-sm text-jp-muted">
            {answered === 0 ? "Tap an answer to each question to see your result." : `${answered} of ${QUESTIONS.length} answered.`}
          </p>
        ) : (
          <>
            <div className={`rounded-xl border p-5 ${verdict.tone}`}>
              <p className="text-lg font-bold text-jp-ink">{verdict.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-jp-slate">{verdict.body}</p>
            </div>
            <ul className="mt-5 space-y-3">
              {notes.map((n) => (
                <li key={n.text} className="flex gap-3 text-sm leading-relaxed text-jp-slate">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[n.level]}`} aria-hidden="true" />
                  {n.text}
                </li>
              ))}
            </ul>
            {plan && level !== "no" ? (
              <div className="mt-6 flex flex-col gap-4 rounded-xl border border-jp-line bg-jp-surface p-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-jp-muted">The plan that fits</p>
                  <p className="mt-1 text-base font-bold text-jp-ink">
                    {plan.name}
                    {plan.price ? <span className="ml-2 text-sm font-normal text-jp-muted">{plan.price}</span> : null}
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-jp-slate">{plan.why}</p>
                </div>
                <Link
                  href={plan.href}
                  className="inline-flex shrink-0 items-center justify-center rounded-lg bg-jp-blue px-5 py-3 text-sm font-semibold text-white hover:bg-jp-navy"
                >
                  {plan.cta}
                </Link>
              </div>
            ) : (
              <p className="mt-6 text-sm text-jp-slate">
                Questions about your setup?{" "}
                <Link href="/contact" className="font-medium text-jp-blue hover:underline">
                  Ask us
                </Link>{" "}
                and we&rsquo;ll tell you straight whether it will work.
              </p>
            )}
            <button
              type="button"
              onClick={() => setAnswers({})}
              className="mt-5 text-sm font-medium text-jp-muted hover:text-jp-blue"
            >
              Start over
            </button>
          </>
        )}
      </div>
    </div>
  );
}
