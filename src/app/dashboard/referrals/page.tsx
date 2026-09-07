import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { getReferralHistory, getReferralSummary } from "@/lib/referrals";
import { REFERRAL_QUALIFY_DAYS, priceCentsForStoredPlan } from "@/lib/plans";
import { formatDate } from "@/lib/format";
import CopyLinkButton from "@/components/dashboard/CopyLinkButton";

export const dynamic = "force-dynamic";

function money(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

const STATUS_COPY: Record<string, { label: string; tone: string; help: string }> = {
  signed_up: {
    label: "Trial started",
    tone: "bg-gray-100 text-gray-700",
    help: "They're evaluating JobProfitAI.",
  },
  paid: {
    label: "Subscribed",
    tone: "bg-blue-50 text-blue-700",
    help: `Your credit is earned after ${REFERRAL_QUALIFY_DAYS} days of paid subscription.`,
  },
  qualified: {
    label: "Credit earned",
    tone: "bg-green-50 text-green-700",
    help: "Applied to your account.",
  },
  disqualified: {
    label: "Not eligible",
    tone: "bg-gray-100 text-gray-500",
    help: "The subscription ended or was refunded before qualifying.",
  },
};

export default async function ReferralsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const [summary, history, entitlements] = await Promise.all([
    getReferralSummary(session.userId),
    getReferralHistory(session.userId),
    getEntitlements(session.userId),
  ]);

  const rewardAmount = priceCentsForStoredPlan(entitlements.plan);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-navy">Refer a contractor, get a free month</h1>
        <p className="mt-1 max-w-2xl text-sm text-gray-600">
          Share your link. When someone you refer becomes a paying customer and stays subscribed for{" "}
          {REFERRAL_QUALIFY_DAYS} days, you earn a free month of your current plan as an account
          credit, currently {money(rewardAmount)}. Credits stack and come off future invoices
          automatically.
        </p>
      </header>

      {/* ── Link ─────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="text-base font-semibold text-navy">Your referral link</h2>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          <label htmlFor="referral-url" className="sr-only">
            Your referral link
          </label>
          <input
            id="referral-url"
            readOnly
            value={summary.url}
            className="w-full flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3.5 py-2.5 font-mono text-sm text-navy"
          />
          <CopyLinkButton value={summary.url} />
        </div>
        <p className="mt-3 text-sm text-gray-600">
          Anyone who signs up through this link starts a 14-day free trial with no credit card
          required. Your referral code is{" "}
          <span className="font-mono font-semibold text-navy">{summary.code}</span>.
        </p>
      </section>

      {/* ── Stats ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Signed up", value: String(summary.signedUp) },
          { label: "Paying customers", value: String(summary.paying) },
          { label: "Credits earned", value: money(summary.totalEarnedCents) },
          { label: "Credits applied", value: money(summary.appliedRewardCents) },
        ].map((stat) => (
          <div key={stat.label} className="rounded-xl border border-gray-200 bg-white px-4 py-3.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
              {stat.label}
            </div>
            <div className="mt-1 text-xl font-bold text-navy">{stat.value}</div>
          </div>
        ))}
      </div>

      {summary.pendingRewardCents > 0 ? (
        <div className="rounded-xl border border-green-300 bg-green-50 px-5 py-4">
          <p className="text-sm text-green-900">
            <strong>{money(summary.pendingRewardCents)} in credit is waiting.</strong> It will be
            applied automatically as soon as you have an active subscription.
          </p>
        </div>
      ) : null}

      {/* ── History ──────────────────────────────────────────────── */}
      <section className="rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-200 px-6 py-4">
          <h2 className="text-base font-semibold text-navy">Referral history</h2>
          <p className="mt-1 text-xs text-gray-500">
            We don&rsquo;t show who signed up, that&rsquo;s their business, not ours to pass
            along.
          </p>
        </div>

        {history.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-gray-500">
            No referrals yet. Share your link above to get started.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th scope="col" className="px-6 py-2.5 font-medium">Signed up</th>
                  <th scope="col" className="px-6 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-6 py-2.5 font-medium">Reward</th>
                  <th scope="col" className="px-6 py-2.5 font-medium">Applied</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {history.map((row) => {
                  const status = STATUS_COPY[row.status] ?? {
                    label: row.status,
                    tone: "bg-gray-100 text-gray-700",
                    help: "",
                  };
                  return (
                    <tr key={row.id}>
                      <td className="px-6 py-3.5 text-gray-600">{formatDate(row.signedUpAt)}</td>
                      <td className="px-6 py-3.5">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${status.tone}`}
                        >
                          {status.label}
                        </span>
                        {status.help ? (
                          <p className="mt-1 text-xs text-gray-500">{status.help}</p>
                        ) : null}
                      </td>
                      <td className="px-6 py-3.5 font-medium text-navy">
                        {row.rewardAmountCents != null ? money(row.rewardAmountCents) : ", "}
                      </td>
                      <td className="px-6 py-3.5 text-gray-600">
                        {row.rewardAppliedAt ? formatDate(row.rewardAppliedAt) : ", "}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-gray-200 bg-gray-50 p-6">
        <h2 className="text-base font-semibold text-navy">Are you an accountant or bookkeeper?</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-gray-600">
          If you bring JobProfitAI to several contractor clients, free months aren&rsquo;t the right
          deal for you. The Partner Program pays 20&ndash;30% recurring commission on subscription
          revenue for each client&rsquo;s first 12 paid months instead.
        </p>
        <Link
          href="/dashboard/partner"
          className="mt-4 inline-block text-sm font-medium text-brand hover:underline"
        >
          Learn about the Partner Program &rarr;
        </Link>
      </section>
    </div>
  );
}
