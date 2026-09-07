"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

const QUESTIONS = [
  {
    name: "mostValuable",
    label: "What has been most valuable about JobProfitAI so far?",
    placeholder: "Even one specific thing is useful.",
  },
  {
    name: "confusing",
    label: "What has been confusing or difficult?",
    placeholder: "Anything that took you longer than it should have.",
  },
  {
    name: "wishItShowed",
    label: "What information do you wish JobProfitAI showed you?",
    placeholder: "Something you looked for and couldn't find.",
  },
  {
    name: "worthPayingFor",
    label: "What would make JobProfitAI valuable enough for you to pay for every month?",
    placeholder: "Be blunt. This is the most useful answer on the form.",
  },
  {
    name: "anythingElse",
    label: "Anything else you would change or add?",
    placeholder: "Optional.",
    optional: true,
  },
] as const;

const textareaClass =
  "w-full rounded-lg border border-gray-300 bg-white px-3.5 py-2.5 text-[15px] text-navy outline-none transition-colors placeholder:text-gray-400 focus:border-brand focus:ring-2 focus:ring-brand/20";

export default function TrialFeedbackForm({ wouldEndAt }: { wouldEndAt: string | null }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState<{ newTrialEndsAt: string } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/trial/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "We couldn't save your feedback. Please try again.");
        setLoading(false);
        return;
      }
      setDone({ newTrialEndsAt: data.newTrialEndsAt });
      router.refresh();
    } catch {
      setError("We couldn't reach the server. Please check your connection and try again.");
      setLoading(false);
    }
  }

  if (done) {
    const newDate = new Date(done.newTrialEndsAt).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    return (
      <div role="status" className="rounded-xl border border-green-300 bg-green-50 p-8 text-center">
        <h2 className="text-xl font-bold text-green-900">Your trial has been extended by 14 days</h2>
        <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-green-900">
          Thanks. This genuinely helps shape what gets built next. Your full-access trial now
          runs through <strong>{newDate}</strong>, and we&rsquo;ve emailed you a confirmation.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/dashboard"
            className="rounded-lg bg-navy px-5 py-2.5 text-sm font-semibold text-white hover:bg-gray-800"
          >
            Back to your dashboard
          </Link>
          <Link
            href="/dashboard/billing"
            className="rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-navy hover:border-brand hover:text-brand"
          >
            View billing
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {QUESTIONS.map((q, index) => (
        <div key={q.name}>
          <label htmlFor={q.name} className="mb-1.5 block text-sm font-medium text-navy">
            {index + 1}. {q.label}
            {"optional" in q && q.optional ? (
              <span className="ml-1 font-normal text-gray-500">(optional)</span>
            ) : (
              <span className="ml-1 text-red-600">*</span>
            )}
          </label>
          <textarea
            id={q.name}
            name={q.name}
            rows={3}
            required={!("optional" in q && q.optional)}
            maxLength={2000}
            placeholder={q.placeholder}
            value={values[q.name] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [q.name]: e.target.value }))}
            className={textareaClass}
          />
        </div>
      ))}

      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-4 border-t border-gray-200 pt-5">
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-navy px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Submitting…" : "Submit feedback & extend my trial"}
        </button>
        {wouldEndAt ? (
          <p className="text-sm text-gray-600">
            Your trial will run through{" "}
            <strong className="text-navy">
              {new Date(wouldEndAt).toLocaleDateString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </strong>
            .
          </p>
        ) : null}
      </div>
    </form>
  );
}
