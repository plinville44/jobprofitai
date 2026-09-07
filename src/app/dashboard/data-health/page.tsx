import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import UpgradeRequired from "@/components/dashboard/UpgradeRequired";
import { prisma } from "@/lib/prisma";
import { getConnectionProfitData, type DataHealthReport } from "@/lib/profitability";
import { formatCurrency } from "@/lib/format";
import { DataQualityBadge, StatusDot } from "@/components/dashboard/Badges";

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
  low: "More than half your jobs are missing revenue or cost data, so company totals may be misleading until that is filled in.",
  insufficient_data:
    "There is not enough synced data yet to say anything reliable about job profitability.",
};

export default async function DataHealthPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  // Server-side entitlement gate. An expired trial gets a proper "choose a
  // plan" screen rather than an authorization error - and because the check
  // happens here, before any financial data is loaded, a lapsed account
  // never has its numbers computed and sent to the browser either.
  const entitlements = await getEntitlements(session.userId);
  if (!entitlements.active) {
    return <UpgradeRequired access={entitlements.access} />;
  }

  const connection = await prisma.quickBooksConnection.findFirst({
    where: { userId: session.userId, disconnectedAt: null },
    orderBy: { connectedAt: "desc" },
  });

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
        A plain-English look at where your QuickBooks data is complete enough to trust, and where it isn&apos;t - so nothing
        about your numbers is a surprise.
      </p>

      <div className="mt-6 rounded-xl border border-gray-200 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold text-navy">
            {h.totalJobs === 0
              ? "No jobs synced from QuickBooks yet"
              : h.jobsMissingData === 0
                ? `All ${h.totalJobs} of your jobs have what we need to calculate profit`
                : `${h.jobsWithEnoughData} of your ${h.totalJobs} jobs have what we need to calculate profit`}
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
              , so {h.jobsMissingData === 1 ? "it is" : "they are"} left out of your company
              totals rather than counted as zero.{" "}
            </>
          ) : null}
          {COMPLETENESS_EXPLANATION[h.overallConfidence]}
        </p>

        {h.jobsMissingData > 0 ? (
          <p className="mt-2 text-sm text-gray-500">
            The lists below show exactly which jobs, and what each one is missing. Most of it is
            fixed in QuickBooks by tagging costs to the right job, or by adding a cost estimate in
            Settings.
          </p>
        ) : null}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <JobListSection
          title="Jobs missing a cost estimate"
          help="Without an estimate on file, we can't tell you if a job is on track or headed for trouble."
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

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CountAmountSection
          title="Unassigned expenses"
          help="Expenses synced from QuickBooks with no customer or project tagged at all - could be genuine overhead, or a missed tagging opportunity worth a look."
          count={h.unassignedExpenseCount}
          amount={h.unassignedExpenseAmount}
        />
        <CountAmountSection
          title="Expenses tagged to an unrecognized customer"
          help="Tagged to a real QuickBooks customer, but not one of your tracked jobs, and not unambiguously one of their sub-projects either - so it isn't counted toward any job's cost."
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
  items: { jobId: string; jobName: string }[];
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
}: {
  title: string;
  help: string;
  count: number | null;
  amount: number | null;
  neutral?: boolean;
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
              {count === 1 ? "transaction" : "transactions"}
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
