import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getConnectionProfitData, type DataHealthReport } from "@/lib/profitability";
import { formatCurrency } from "@/lib/format";
import { ConfidenceBadge, StatusDot } from "@/components/dashboard/Badges";

const CONFIDENCE_EXPLANATION: Record<string, string> = {
  high: "Most of your jobs have complete revenue and cost data. The numbers on your dashboard should be reliable.",
  medium: "Some of your jobs are missing cost data or estimates. Treat totals as directionally right, but double-check individual jobs before making decisions on them.",
  low: "More than half of your jobs are missing revenue or cost data. Company-wide totals may be misleading until this is fixed.",
  insufficient_data: "There isn't enough synced data yet to say anything reliable about your job profitability.",
};

export default async function DataHealthPage() {
  const session = await getSession();
  if (!session) redirect("/login");

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

      <div className="mt-6 flex items-center gap-3 rounded-xl border border-gray-200 p-5">
        <ConfidenceBadge confidence={h.overallConfidence} />
        <p className="text-sm text-gray-600">{CONFIDENCE_EXPLANATION[h.overallConfidence]}</p>
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
