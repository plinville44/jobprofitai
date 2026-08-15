"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";

const CATEGORIES = ["Feature Request", "Report", "Integration", "Bug/Problem", "Other"];

/**
 * Nav-triggered "Suggest an Improvement" button + modal. Self-contained
 * (owns its own open/closed state) so it can just be dropped into the shared
 * dashboard nav. `page` is filled in automatically from the current route -
 * one less thing for the user to describe by hand.
 */
export default function FeedbackModal() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  function reset() {
    setCategory(CATEGORIES[0]);
    setMessage("");
    setResult(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) {
      setResult({ ok: false, message: "Add a few words about what you'd like to see." });
      return;
    }
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, message, page: pathname }),
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (res.ok) {
        setResult({ ok: true, message: "Thanks - your feedback was sent." });
        setMessage("");
      } else {
        setResult({ ok: false, message: data?.error ?? `Server returned status ${res.status}.` });
      }
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Network error - please try again." });
    }
    setSubmitting(false);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-sm font-medium text-gray-600 hover:text-navy"
      >
        Suggest an Improvement
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-lg">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-navy">Suggest an Improvement</h2>
              <button
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
                className="text-gray-400 hover:text-gray-600"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <form onSubmit={onSubmit} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-600">Category</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600">What's on your mind?</label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={4}
                  placeholder="Tell us what you'd like to see, or what's not working..."
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
                >
                  {submitting ? "Sending..." : "Send feedback"}
                </button>
                {result && (
                  <span className={`text-sm ${result.ok ? "text-green-700" : "text-red-600"}`}>{result.message}</span>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
