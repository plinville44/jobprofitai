"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const TIMEZONES = [
  "America/New_York",
  "America/Detroit",
  "America/Indiana/Indianapolis",
  "America/Kentucky/Louisville",
  "America/Chicago",
  "America/Denver",
  "America/Boise",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Puerto_Rico",
  "America/Toronto",
  "America/Winnipeg",
  "America/Edmonton",
  "America/Vancouver",
];

function hourLabel(h: number) {
  const period = h < 12 ? "AM" : "PM";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:00 ${period}`;
}

type Props = {
  connectionId: string;
  /** The company's job types that can take a target (hidden ones are left out). */
  jobTypes: { value: string; label: string }[];
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
    jobSource: "projects" | "customers" | "classes";
    laborFromTimeEntries: boolean;
    laborBurdenPct: number | null;
    alertsEnabled: boolean;
    marginTargets: Record<string, number>;
  };
};

export default function SettingsForm({ connectionId, jobTypes, initial }: Props) {
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
  const [jobSource, setJobSource] = useState(initial.jobSource);
  const [laborFromTimeEntries, setLaborFromTimeEntries] = useState(initial.laborFromTimeEntries);
  const [laborBurdenPct, setLaborBurdenPct] = useState(initial.laborBurdenPct?.toString() ?? "");
  const [alertsEnabled, setAlertsEnabled] = useState(initial.alertsEnabled);
  const [marginTargets, setMarginTargets] = useState<Record<string, string>>(
    Object.fromEntries(jobTypes.map((o) => [o.value, initial.marginTargets[o.value]?.toString() ?? ""]))
  );
  const [showTypeTargets, setShowTypeTargets] = useState(Object.keys(initial.marginTargets).length > 0);
  // A zone captured from the browser at signup may not be in the short list.
  const zones = TIMEZONES.includes(initial.emailTimezone) ? TIMEZONES : [initial.emailTimezone, ...TIMEZONES];
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
          jobSource,
          laborFromTimeEntries,
          laborBurdenPct: laborBurdenPct === "" ? null : laborBurdenPct,
          alertsEnabled,
          marginTargets,
        }),
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (res.ok) {
        setStatus({
          ok: true,
          message: data?.rebuild
            ? "Settings saved. Your jobs and costs are re-read the next time QuickBooks syncs; click Sync now on the Dashboard to do it now."
            : "Settings saved.",
        });
        router.refresh();
      } else {
        setStatus({ ok: false, message: data?.error ?? `Server returned status ${res.status}.` });
      }
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Network error. Please try again." });
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
            max={90}
            step="0.1"
            value={targetMarginPct}
            onChange={(e) => setTargetMarginPct(e.target.value)}
            placeholder="e.g. 20"
            className="mt-2 w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => setShowTypeTargets((v) => !v)}
            className="mt-2 block text-xs font-medium text-brand hover:underline"
          >
            {showTypeTargets ? "Hide" : "Set"} a different target for some job types
          </button>
          {showTypeTargets && (
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {jobTypes.map((o) => (
                <label key={o.value} className="flex flex-col text-xs text-gray-600">
                  {o.label} (%)
                  <input
                    type="number"
                    min={0}
                    max={90}
                    step="0.1"
                    value={marginTargets[o.value] ?? ""}
                    onChange={(e) => setMarginTargets((m) => ({ ...m, [o.value]: e.target.value }))}
                    placeholder={targetMarginPct || "company target"}
                    className="mt-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                  />
                </label>
              ))}
            </div>
          )}
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
        <h2 className="text-sm font-semibold text-navy">How your jobs are set up in QuickBooks</h2>
        <div className="mt-3 space-y-2">
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input
              type="radio"
              name="jobSource"
              checked={jobSource === "projects"}
              onChange={() => setJobSource("projects")}
              className="mt-1"
            />
            <span>
              <strong>Projects or sub-customers.</strong> Each job is a Project (QuickBooks Online Plus or Advanced) or a
              sub-customer under the client.
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input
              type="radio"
              name="jobSource"
              checked={jobSource === "customers"}
              onChange={() => setJobSource("customers")}
              className="mt-1"
            />
            <span>
              <strong>One customer per job.</strong> Every customer without sub-customers is a job; where a customer does
              have sub-customers, those are the jobs. Works on every QuickBooks Online plan.
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input
              type="radio"
              name="jobSource"
              checked={jobSource === "classes"}
              onChange={() => setJobSource("classes")}
              className="mt-1"
            />
            <span>
              <strong>Classes.</strong> Each QuickBooks Class is a job (where a class has sub-classes, those are the jobs),
              and costs and sales are matched by the class on each line. For companies that turned on class tracking and
              pick the job&apos;s class on bills, expenses, time entries and invoices. Plus or Advanced.
            </span>
          </label>
          {jobSource !== initial.jobSource ? (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Switching re-reads your jobs at the next sync. Jobs that aren&apos;t jobs under the new setting are removed,
              along with the job type, estimate and contract value typed in for them.
            </p>
          ) : null}
        </div>

        <label className="mt-5 flex items-start gap-2 border-t border-gray-100 pt-5 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={laborFromTimeEntries}
            onChange={(e) => setLaborFromTimeEntries(e.target.checked)}
            className="mt-1 h-4 w-4 rounded border-gray-300"
          />
          <span>
            <strong>Count labor from time entries.</strong> Employee hours tagged to a job, at the cost rate on each
            time entry, which comes from the employee&apos;s cost rate in QuickBooks. Time for an employee with no cost
            rate isn&apos;t counted. Turn off if you already put payroll on jobs another way (checks or journal entries
            tagged to the job), so labor isn&apos;t counted twice.
          </span>
        </label>

        {laborFromTimeEntries ? (
          <div className="mt-4 pl-6">
            <label htmlFor="laborBurdenPct" className="block text-sm font-medium text-gray-700">
              Labor burden (%)
            </label>
            <input
              id="laborBurdenPct"
              type="number"
              min={0}
              max={100}
              step="0.1"
              value={laborBurdenPct}
              onChange={(e) => setLaborBurdenPct(e.target.value)}
              placeholder="0"
              className="mt-1 w-32 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <p className="mt-1 max-w-xl text-xs text-gray-500">
              Payroll taxes, workers&apos; comp, insurance and benefits, as a percent of wages. Check your employees&apos;
              cost rates in QuickBooks first. If they already include these, leave this at 0, or labor is counted twice.
              If a cost rate is just the hourly wage, enter your burden here; your payroll provider or accountant can give
              you the figure. Changes apply straight away, with no re-sync.
            </p>
          </div>
        ) : null}
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
          Send the Weekly Profit Brief
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm font-medium text-gray-700">
          <input
            type="checkbox"
            checked={alertsEnabled}
            onChange={(e) => setAlertsEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300"
          />
          Send profit alerts between briefs, after the nightly sync (an open job&apos;s costs go more than 10% over its
          estimate, work gets well ahead of billing, or on Pro, a job&apos;s forecast drops below target)
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
              {zones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace(/_/g, " ")}
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
