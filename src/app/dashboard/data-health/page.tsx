import { redirect } from "next/navigation";
import Link from "next/link";
import { getAccount, getActiveConnection } from "@/lib/account";
import { getEntitlements } from "@/lib/entitlements";
import UpgradeRequired from "@/components/dashboard/UpgradeRequired";
import { getConnectionProfitData, type DataHealthReport } from "@/lib/profitability";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { DataQualityBadge, StatusDot } from "@/components/dashboard/Badges";
import CloseIdleJobsButton from "@/components/dashboard/CloseIdleJobsButton";

/**
 * What each data-completeness level actually means for the customer's
 * numbers, in terms of what they should do about it.
 *
 * This replaced a set of "Medium confidence" style labels. The problem with
 * a confidence grade is that it reads as the software hedging about itself,
 * when what it really describes is a gap in the customer's QuickBooks data
 * that they can go and fix. So the banner now leads with the count, names
 * the consequence, and points at the lists below.
 */
const COMPLETENESS_EXPLANATION: Record<string, string> = {
  high: "Your dashboard totals are built on complete data, so you can act on them directly.",
  medium:
    "Company totals are still directionally right, but check an individual job below before making a decision on it.",
  low: "More than half of these jobs are missing revenue or cost data, so company totals may be misleading until that is filled in.",
  insufficient_data:
    "There is not enough synced data yet to say anything reliable about job profitability.",
};

export default async function DataHealthPage() {
  const account = await getAccount();
  if (!account) redirect("/login");

  // Server-side entitlement gate. An expired trial gets a proper "choose a
  // plan" screen rather than an authorization error - and because the check
  // happens here, before any financial data is loaded, a lapsed account
  // never has its numbers computed and sent to the browser either.
  const entitlements = await getEntitlements(account.ownerId);
  if (!entitlements.active) {
    return <UpgradeRequired access={entitlements.access} />;
  }

  // The company picked in the company switcher (see src/lib/account.ts).
  const { connection } = await getActiveConnection(account.ownerId);

  if (!connection) {
    return (
      <main>
        <h1 className="text-2xl font-bold text-navy">Data Health</h1>
        <p className="mt-4 text-gray-600">Connect QuickBooks from the Dashboard to see your data health here.</p>
      </main>
    );
  }

  // Full lifetime data, same reasoning as the Jobs table - data quality is a
  // property of the whole connection, not something that should change
  // depending on which calendar window happens to be selected.
  const profitData = await getConnectionProfitData(connection.id, new Date());
  const h = profitData.dataHealth;

  return (
    <main>
      <h1 className="text-2xl font-bold text-navy">Data Health</h1>
      <p className="mt-2 text-sm text-gray-500">
        A plain-English look at where your QuickBooks data is complete enough to trust, and where it isn&apos;t, so nothing
        about your numbers is a surprise. It covers every open job and every job with activity in the last 12 months;
        older finished jobs are left out.
      </p>

      {h.idleOpenJobs.length > 0 ? (
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5">
          <h2 className="text-sm font-semibold text-navy">
            {h.idleOpenJobs.length} open {h.idleOpenJobs.length === 1 ? "job has" : "jobs have"} had no activity in 90 days or more
          </h2>
          <p className="mt-1 text-sm text-gray-700">
            These are almost always finished jobs that were never marked complete. QuickBooks doesn&apos;t tell us when a
            project wraps up, so until they are marked here they count as active, show up as stale, and are left out of the
            comparisons between finished jobs. You can reopen any of them later from its job page.
          </p>
          <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto text-sm">
            {h.idleOpenJobs.slice(0, 50).map((j) => (
              <li key={j.jobId} className="flex justify-between gap-3">
                <Link href={`/dashboard/jobs/${j.jobId}`} className="text-brand hover:underline">
                  {j.jobName}
                </Link>
                <span className="text-xs text-gray-500">
                  {j.daysSinceActivity == null ? "no activity ever" : `${j.daysSinceActivity} days`}
                </span>
              </li>
            ))}
          </ul>
          {h.idleOpenJobs.length > 50 ? (
            <p className="mt-1 text-xs text-gray-500">and {h.idleOpenJobs.length - 50} more</p>
          ) : null}
          <div className="mt-4">
            <CloseIdleJobsButton connectionId={connection.id} count={h.idleOpenJobs.length} />
          </div>
        </div>
      ) : null}

      <div className="mt-6 rounded-xl border border-gray-200 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold text-navy">
            {h.totalJobs === 0
              ? "No open or recently active jobs synced from QuickBooks yet"
              : h.jobsMissingData === 0
                ? `All ${h.totalJobs} of your open and recent jobs have what we need to calculate profit`
                : `${h.jobsWithEnoughData} of your ${h.totalJobs} open and recent jobs have what we need to calculate profit`}
          </h2>
          <DataQualityBadge confidence={h.overallConfidence} />
        </div>

        {h.totalJobs > 0 ? (
          <div
            className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-100"
            role="img"
            aria-label={`${h.jobsWithEnoughData} of ${h.totalJobs} jobs have complete data`}
          >
            <div
              className="h-full rounded-full bg-status-good"
              style={{ width: `${Math.round((h.jobsWithEnoughData / h.totalJobs) * 100)}%` }}
            />
          </div>
        ) : null}

        <p className="mt-3 text-sm leading-relaxed text-gray-600">
          {h.jobsMissingData > 0 ? (
            <>
              <strong className="text-navy">
                {h.jobsMissingData} {h.jobsMissingData === 1 ? "job is" : "jobs are"} missing
                revenue or cost data
              </strong>
              , so {h.jobsMissingData === 1 ? "its margin is" : "their margins are"} left out of
              your company profit and margin figures rather than counted as zero. Whatever revenue
              and cost {h.jobsMissingData === 1 ? "it does" : "they do"} have is still included in
              those totals.{" "}
            </>
          ) : null}
          {COMPLETENESS_EXPLANATION[h.overallConfidence]}
        </p>

        {h.jobsMissingData > 0 ? (
          <p className="mt-2 text-sm text-gray-500">
            The first list below names every one of them and what each is missing. Most of it is
            fixed in QuickBooks by tagging costs to the right job. A missing cost estimate is
            added here instead: open the job and fill in Job Details.
          </p>
        ) : null}
      </div>

      {/* Every job the headline above counts, by name. The four lists below
          it each cover one specific gap, and an open job with costs but no
          invoice yet belongs to none of them, so without this list the
          headline counted jobs nothing on the page would name. */}
      {h.jobsWithoutEnoughData.length > 0 ? (
        <div className="mt-6">
          <JobListSection
            title="Jobs we can't calculate profit for yet"
            help="These are the jobs counted above. Most are simply early: an open job with costs and no invoice yet is normal. Each one says what's missing."
            items={h.jobsWithoutEnoughData}
          />
        </div>
      ) : null}

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <JobListSection
          title="Open jobs missing a cost estimate"
          help="Without an estimated cost we can't tell you if a job is on track or headed for trouble. Add them one at a time in Job Details, import them from a spreadsheet on the Jobs page, or fill them from your target margin there."
          items={h.jobsMissingEstimates}
        />
        <JobListSection
          title="Jobs with revenue but no costs recorded"
          help="Usually means expenses aren't being tagged to this job in QuickBooks yet, or the work hasn't hit the books."
          items={h.jobsMissingCosts}
        />
        <StaleJobsSection items={h.staleJobs} />
        <JobListSection
          title="Completed jobs with unresolved activity"
          help="These jobs are marked complete but still show a revenue/cost mismatch worth a final look."
          items={h.completedJobsWithUnresolvedActivity}
        />
      </div>

      <p className="mt-8 text-xs text-gray-500">
        {h.countsAsOf
          ? `Expenses and time entries below are counted during a full sync of your whole company, last run ${formatDateTime(h.countsAsOf, connection.emailTimezone)}. Possible duplicates, and the lists above, are worked out from your synced data every time this page loads.`
          : "Expenses and time entries below are counted during a full sync of your whole company, which hasn't run yet for this connection. Possible duplicates, and the lists above, are worked out from your synced data every time this page loads."}
      </p>

      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CountAmountSection
          title="Job costs not tagged to a job (last 12 months)"
          help="Bills and expenses posted to a job-cost account (Cost of Goods Sold) or bought as an item, with no customer or project on the line. Each one belongs to some job and is missing from it. Tag the customer or project on the line in QuickBooks. Overhead such as rent, fuel or insurance is not counted here."
          count={h.untaggedJobCostCount}
          amount={h.untaggedJobCostAmount}
        />
        <CountAmountSection
          title="Expenses tagged to an unrecognized customer"
          help="Last 12 months. Tagged to a real QuickBooks customer, but not one of your tracked jobs, and not unambiguously one of their projects either, so it isn't counted toward any job's cost. Usually the customer has two or more projects and the cost was tagged to the customer instead of the project."
          count={h.unresolvedExpenseCount}
          amount={h.unresolvedExpenseAmount}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CountAmountSection
          title="Costs matched via a parent customer"
          help="Not a problem - these were tagged to a job's top-level customer instead of the job itself, and matched automatically since that customer has only one tracked job. Worth a quick glance for accuracy, not a fix."
          count={h.costsMatchedViaParentCount}
          amount={h.costsMatchedViaParentAmount}
          neutral
        />
        <DuplicatesSection items={h.possibleDuplicates} />
        <JobListSection
          title="Labor that may be counted twice"
          help="These jobs have labor from timesheets and labor from journal entries (often a payroll service posting wages to jobs). That is usually the same wages twice. If your payroll posts to jobs, turn off labor from time entries in Settings; otherwise check the journal entries."
          items={h.jobsWithDoubleLabor}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CountAmountSection
          title="Employee time with no pay rate (last 12 months)"
          help="Labor is costed as hours times what you pay the employee. These entries are for employees with no pay rate (cost rate) in QuickBooks, so their hours add no labor cost here. Set the employee's pay rate in QuickBooks and sync again. If you tag payroll to jobs another way, turn off labor from time entries in Settings."
          count={h.timeEntriesWithoutPayRate}
          amount={null}
          noun="time entry"
          nounPlural="time entries"
        />
        <CountAmountSection
          title="Overhead not tagged to a job (last 12 months)"
          help="Information only, not a problem. Rent, fuel, insurance, software and other overhead are supposed to stay off individual jobs. Overhead can be spread across jobs with the overhead setting in Settings."
          count={h.untaggedOverheadCount}
          amount={h.untaggedOverheadAmount}
          neutral
        />
      </div>

      <p className="mt-8 text-xs text-gray-400">
        Every number on this page is computed directly from your synced QuickBooks data - nothing here is estimated or
        written by AI.
      </p>
    </main>
  );
}

function statusFor(count: number | null): "good" | "warning" | "unmeasured" {
  if (count == null) return "unmeasured";
  return count > 0 ? "warning" : "good";
}

function JobListSection({
  title,
  help,
  items,
}: {
  title: string;
  help: string;
  items: { jobId: string; jobName: string; reason?: string }[];
}) {
  const status = statusFor(items.length);
  return (
    <section className="rounded-xl border border-gray-200 p-5">
      <div className="flex items-center gap-2">
        <StatusDot status={status} />
        <h3 className="text-sm font-semibold text-navy">{title}</h3>
      </div>
      <p className="mt-1 text-xs text-gray-500">{help}</p>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500">None right now.</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {items.map((item) => (
            <li key={item.jobId} className="text-sm">
              <Link href={`/dashboard/jobs/${item.jobId}`} className="text-brand hover:underline">
                {item.jobName}
              </Link>
              {item.reason ? <span className="block text-xs text-gray-500">{item.reason}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StaleJobsSection({ items }: { items: { jobId: string; jobName: string; daysSinceActivity: number }[] }) {
  const status = statusFor(items.length);
  return (
    <section className="rounded-xl border border-gray-200 p-5">
      <div className="flex items-center gap-2">
        <StatusDot status={status} />
        <h3 className="text-sm font-semibold text-navy">Stale jobs</h3>
      </div>
      <p className="mt-1 text-xs text-gray-500">Open jobs with no synced financial activity in over 30 days.</p>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500">None right now.</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {items.map((item) => (
            <li key={item.jobId} className="flex items-center justify-between text-sm">
              <Link href={`/dashboard/jobs/${item.jobId}`} className="text-brand hover:underline">
                {item.jobName}
              </Link>
              <span className="text-xs text-gray-400">
                {Number.isFinite(item.daysSinceActivity) ? `${item.daysSinceActivity} days` : "no activity on file"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CountAmountSection({
  title,
  help,
  count,
  amount,
  neutral = false,
  noun = "transaction",
  nounPlural,
}: {
  title: string;
  help: string;
  count: number | null;
  amount: number | null;
  neutral?: boolean;
  /** Singular. Not everything counted here is a transaction. */
  noun?: string;
  /** Supply when adding an "s" is wrong, e.g. "time entry" -> "time entries". */
  nounPlural?: string;
}) {
  const status = neutral ? (count == null ? "unmeasured" : count > 0 ? "unmeasured" : "good") : statusFor(count);
  return (
    <section className="rounded-xl border border-gray-200 p-5">
      <div className="flex items-center gap-2">
        <StatusDot status={status} />
        <h3 className="text-sm font-semibold text-navy">{title}</h3>
      </div>
      <p className="mt-1 text-xs text-gray-500">{help}</p>
      <div className="mt-3 flex items-baseline gap-2">
        {count == null ? (
          <p className="text-sm text-gray-500">Not yet measured - sync QuickBooks to check.</p>
        ) : (
          <>
            <span className="text-xl font-bold text-navy">{count}</span>
            <span className="text-sm text-gray-500">
              {count === 1 ? noun : nounPlural ?? `${noun}s`}
              {amount != null && amount > 0 ? ` · ${formatCurrency(amount)}` : ""}
            </span>
          </>
        )}
      </div>
    </section>
  );
}

function DuplicatesSection({ items }: { items: DataHealthReport["possibleDuplicates"] }) {
  const status = statusFor(items.length);
  return (
    <section className="rounded-xl border border-gray-200 p-5">
      <div className="flex items-center gap-2">
        <StatusDot status={status} />
        <h3 className="text-sm font-semibold text-navy">Possible duplicate transactions</h3>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        Same job, amount, and date, but from two different QuickBooks transactions - flagged for a look, never auto-merged.
      </p>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500">None right now.</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {items.map((item, i) => (
            <li key={i} className="flex items-center justify-between text-sm">
              <Link href={`/dashboard/jobs/${item.jobId}`} className="text-brand hover:underline">
                {item.jobName}
              </Link>
              <span className="text-xs text-gray-400">
                {formatCurrency(item.amount)} on {item.date}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
