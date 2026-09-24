import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { accountFor } from "@/lib/account";
import { getEntitlements } from "@/lib/entitlements";
import { getReferralHistory, getReferralSummary } from "@/lib/referrals";
import {
  PARTNER_COMMISSION_MONTHS,
  PARTNER_TIERS,
  REFERRAL_QUALIFY_DAYS,
  TRIAL_DAYS,
  priceCentsForStoredPlan,
} from "@/lib/plans";
import { NO_VALUE, formatDate, formatCents } from "@/lib/format";
import CopyLinkButton from "@/components/dashboard/CopyLinkButton";

export const dynamic = "force-dynamic";

/** Shared, so every screen shows the same amount to the cent. */
const money = formatCents;

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
    help: "", // set per row from the reward's own status - see rewardHelp below
  },
  disqualified: {
    label: "Not eligible",
    tone: "bg-gray-100 text-gray-500",
    help: "The subscription ended or was refunded before qualifying.",
  },
};

/**
 * What actually happened to the credit, rather than what usually happens.
 *
 * An earned reward and an applied one are different things: the reward row
 * is created first and the Stripe credit follows, and it stays pending when
 * the referrer has no Stripe customer yet, which is the normal case for
 * someone still on their own trial. The page used to say "Applied to your
 * account" for every qualified referral, so a credit that had not reached
 * Stripe still read as money already in hand.
 */
function rewardHelp(rewardStatus: string | null): string {
  switch (rewardStatus) {
    case "applied":
      return "Applied to your account as a credit.";
    case "pending":
      return "Earned. It goes on as an account credit at your next invoice.";
    case "voided":
      return "This credit was reversed. Email support@jobprofitai.com if that looks wrong.";
    default:
      return "Earned.";
  }
}

export default async function ReferralsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  // Referral credit comes off the bill, and a team member doesn't have one.
  const account = await accountFor(session.userId);
  if (account.role !== "owner") {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-navy">Refer a contractor</h1>
        <p className="text-sm text-gray-600">
          Referral credit comes off the account owner&apos;s bill, so referrals are made from the owner&apos;s login.
          Ask them for their referral link.
        </p>
      </div>
    );
  }

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
          Anyone who signs up through this link starts a {TRIAL_DAYS}-day free trial with no credit
          card required. Your referral code is{" "}
          <span className="font-mono font-semibold text-navy">{summary.code}</span>.
        </p>
      </section>

      {/* ── Stats ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Signed up", value: String(summary.signedUp) },
          { label: "Converted to paid", value: String(summary.paying) },
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
                  const base = STATUS_COPY[row.status] ?? {
                    label: row.status,
                    tone: "bg-gray-100 text-gray-700",
                    help: "",
                  };
                  // A referral disqualified AFTER its credit was earned (a later
                  // refund) is a different story from one that never
                  // qualified, and used to be told "refunded before
                  // qualifying" beside the credit amount it had earned.
                  const status =
                    row.status === "qualified"
                      ? { ...base, help: rewardHelp(row.rewardStatus) }
                      : row.status === "disqualified" && row.rewardStatus === "voided"
                        ? {
                            ...base,
                            help: "The customer's payment was refunded after the credit was earned, so the credit was reversed.",
                          }
                        : base;
                  const reversed = row.rewardStatus === "voided";
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
                        {row.rewardAmountCents != null ? (
                          reversed ? (
                            <span className="text-gray-400 line-through">{money(row.rewardAmountCents)}</span>
                          ) : (
                            money(row.rewardAmountCents)
                          )
                        ) : (
                          NO_VALUE
                        )}
                      </td>
                      <td className="px-6 py-3.5 text-gray-600">
                        {reversed
                          ? "Reversed"
                          : row.rewardAppliedAt
                            ? formatDate(row.rewardAppliedAt)
                            : row.rewardStatus === "pending"
                              ? "Pending"
                              : NO_VALUE}
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
          deal for you. The Partner Program pays {PARTNER_TIERS[PARTNER_TIERS.length - 1].ratePct}% to{" "}
          {PARTNER_TIERS[0].ratePct}% recurring commission on subscription revenue for each
          client&rsquo;s first {PARTNER_COMMISSION_MONTHS} paid months instead.
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
