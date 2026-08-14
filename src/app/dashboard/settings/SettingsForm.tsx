"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
];

function hourLabel(h: number) {
  const period = h < 12 ? "AM" : "PM";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:00 ${period}`;
}

type Props = {
  connectionId: string;
  initial: {
    targetMarginPct: number | null;
    overheadEnabled: boolean;
    overheadMethod: "pct_of_revenue" | "pct_of_direct_cost" | null;
    overheadValuePct: number | null; // already converted to a plain percentage for display
    emailEnabled: boolean;
    emailRecipients: string[];
    emailDay: number;
    emailHour: number;
    emailTimezone: string;
  };
};

export default function SettingsForm({ connectionId, initial }: Props) {
  const router = useRouter();
  const [targetMarginPct, setTargetMarginPct] = useState(initial.targetMarginPct?.toString() ?? "");
  const [overheadEnabled, setOverheadEnabled] = useState(initial.overheadEnabled);
  const [overheadMethod, setOverheadMethod] = useState(initial.overheadMethod ?? "pct_of_revenue");
  const [overheadValue, setOverheadValue] = useState(initial.overheadValuePct?.toString() ?? "");
  const [emailEnabled, setEmailEnabled] = useState(initial.emailEnabled);
  const [emailRecipients, setEmailRecipients] = useState(initial.emailRecipients.join(", "));
  const [emailDay, setEmailDay] = useState(initial.emailDay);
  const [emailHour, setEmailHour] = useState(initial.emailHour);
  const [emailTimezone, setEmailTimezone] = useState(initial.emailTimezone);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/settings/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId,
          targetMarginPct: targetMarginPct === "" ? null : targetMarginPct,
          overheadEnabled,
          overheadMethod,
          overheadValue,
          emailEnabled,
          emailRecipients,
          emailDay,
          emailHour,
          emailTimezone,
        }),
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (res.ok) {
        setStatus({ ok: true, message: "Settings saved." });
        router.refresh();
      } else {
        setStatus({ ok: false, message: data?.error ?? `Server returned status ${res.status}.` });
      }
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Network error - please try again." });
    }
    setSaving(false);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-8">
      <section className="rounded-xl border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-navy">Profitability Settings</h2>

        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-700">Target job margin (%)</label>
          <p className="mt-0.5 text-xs text-gray-500">
            Used across the dashboard to flag jobs running below target. Leave blank to turn off target-margin comparisons.
          </p>
          <input
            type="number"
            min={0}
            max={100}
            step="0.1"
            value={targetMarginPct}
            onChange={(e) => setTargetMarginPct(e.target.value)}
            placeholder="e.g. 20"
            className="mt-2 w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="mt-6 border-t border-gray-100 pt-6">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={overheadEnabled}
              onChange={(e) => setOverheadEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            Include overhead in Fully Loaded Profit
          </label>
          <p className="mt-0.5 text-xs text-gray-500">
            Off by default. When on, Job Detail pages also show Fully Loaded Profit/Margin after allocating overhead.
          </p>
          {overheadEnabled && (
            <div className="mt-3 flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600">Allocate as</label>
                <select
                  value={overheadMethod}
                  onChange={(e) => setOverheadMethod(e.target.value as any)}
                  className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="pct_of_revenue">% of revenue</option>
                  <option value="pct_of_direct_cost">% of direct cost</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600">Percentage</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="0.1"
                  value={overheadValue}
                  onChange={(e) => setOverheadValue(e.target.value)}
                  placeholder="e.g. 12"
                  className="mt-1 w-32 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-navy">Email Preferences</h2>

        <label className="mt-4 flex items-center gap-2 text-sm font-medium text-gray-700">
          <input
            type="checkbox"
            checked={emailEnabled}
            onChange={(e) => setEmailEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300"
          />
          Send the weekly profitability email
        </label>

        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-700">Recipients</label>
          <p className="mt-0.5 text-xs text-gray-500">Comma-separated email addresses.</p>
          <textarea
            value={emailRecipients}
            onChange={(e) => setEmailRecipients(e.target.value)}
            rows={2}
            placeholder="you@example.com, partner@example.com"
            className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="mt-4 flex flex-wrap gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600">Day</label>
            <select
              value={emailDay}
              onChange={(e) => setEmailDay(Number(e.target.value))}
              className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">Time</label>
            <select
              value={emailHour}
              onChange={(e) => setEmailHour(Number(e.target.value))}
              className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">Timezone</label>
            <select
              value={emailTimezone}
              onChange={(e) => setEmailTimezone(e.target.value)}
              className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace("_", " ")}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {saving ? "Saving..." : "Save settings"}
        </button>
        {status && (
          <span className={`text-sm ${status.ok ? "text-green-700" : "text-red-600"}`}>{status.message}</span>
        )}
      </div>
    </form>
  );
}
