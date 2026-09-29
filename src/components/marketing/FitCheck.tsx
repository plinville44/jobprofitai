"use client";

import { useState } from "react";
import Link from "next/link";
import { QUESTIONS, notesFor, planFor, type Answers, type Level } from "./fitCheckRules";

/**
 * "Will this work with my QuickBooks?" Six one-tap questions, about thirty
 * seconds, and an honest answer: a good fit, works with one change, or not a
 * fit yet, with what each answer means and the plan that fits.
 *
 * The questions and every line of the answers live in fitCheckRules.ts, where
 * a test holds them to what the product does.
 */

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
