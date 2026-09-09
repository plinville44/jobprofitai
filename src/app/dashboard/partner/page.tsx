import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPartnerCommissionHistory, getPartnerDashboardData } from "@/lib/partners";
import { PARTNER_COMMISSION_MONTHS, PARTNER_FREE_ACCOUNT_THRESHOLD, PARTNER_TIERS } from "@/lib/plans";
import { formatDate } from "@/lib/format";
import CopyLinkButton from "@/components/dashboard/CopyLinkButton";
import PartnerApplicationForm from "./PartnerApplicationForm";

export const dynamic = "force-dynamic";

function money(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

export default async function PartnerPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const partner = await prisma.partner.findUnique({ where: { userId: session.userId } });

  // ── Not yet applied ────────────────────────────────────────────
  if (!partner) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="text-2xl font-bold text-navy">JobProfitAI Partner Program</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-gray-600">
            For accountants, bookkeepers, fractional CFOs and QuickBooks ProAdvisors who work with
            contractor clients. Earn recurring commission on every client you refer, 20% to
            30% of subscription revenue for their first {PARTNER_COMMISSION_MONTHS} paid months.
          </p>
        </header>

        <section className="grid gap-3 sm:grid-cols-3">
          {[...PARTNER_TIERS].reverse().map((tier) => (
            <div key={tier.key} className="rounded-xl border border-gray-200 bg-white p-5 text-center">
              <p className="text-xs font-medium text-gray-500">{tier.label}</p>
              <p className="mt-2 text-3xl font-bold text-navy">{tier.ratePct}%</p>
            </div>
          ))}
        </section>

        <section className="rounded-xl border border-blue-200 bg-blue-50 p-5">
          <h2 className="text-sm font-semibold text-navy">
            Referring a client gives you no access to their data
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-gray-700">
            Partner status grants a referral code and a commission ledger. Nothing else. It
            gives you no visibility into any client&rsquo;s QuickBooks data, jobs or margins. If a
            contractor wants you working in their numbers, that happens through the QuickBooks
            access they already give your firm, not through anything here.
          </p>
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-6">
          <h2 className="text-base font-semibold text-navy">Apply</h2>
          <p className="mt-1 text-sm text-gray-600">
            Free to join. At around {PARTNER_FREE_ACCOUNT_THRESHOLD} active paying clients your firm
            also earns a complimentary JobProfitAI account.
          </p>
          <div className="mt-5">
            <PartnerApplicationForm />
          </div>
        </section>

        <p className="text-sm text-gray-500">
          Full details on the{" "}
          <Link href="/partners" className="font-medium text-brand hover:underline">
            Partner Program page
          </Link>
          .
        </p>
      </div>
    );
  }

  // ── Applied, awaiting review ───────────────────────────────────
  if (partner.status !== "approved") {
    const copy: Record<string, { title: string; body: string }> = {
      pending: {
        title: "Your application is under review",
        body: "Thanks for applying. A person reviews every application, usually within a couple of business days. We'll email you as soon as it's approved, along with your referral link.",
      },
      rejected: {
        title: "We weren't able to approve this application",
        body: "If you think this was a mistake, or your circumstances have changed, email support@jobprofitai.com and we'll take another look.",
      },
      suspended: {
        title: "This partner account is suspended",
        body: "Please email support@jobprofitai.com and we'll sort it out with you.",
      },
    };
    const state = copy[partner.status] ?? copy.pending;

    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-bold text-navy">JobProfitAI Partner Program</h1>
        <div className="mt-5 rounded-xl border border-gray-200 bg-white p-6">
          <h2 className="text-base font-semibold text-navy">{state.title}</h2>
          <p className="mt-2 text-[15px] leading-relaxed text-gray-600">{state.body}</p>
          <dl className="mt-5 border-t border-gray-100 pt-4 text-sm">
            <div className="flex justify-between py-1.5">
              <dt className="text-gray-600">Firm</dt>
              <dd className="font-medium text-navy">{partner.firmName}</dd>
            </div>
            <div className="flex justify-between py-1.5">
              <dt className="text-gray-600">Applied</dt>
              <dd className="font-medium text-navy">{formatDate(partner.createdAt)}</dd>
            </div>
          </dl>
        </div>
      </div>
    );
  }

  // ── Approved partner dashboard ─────────────────────────────────
  const [data, commissions] = await Promise.all([
    getPartnerDashboardData(partner.id),
    getPartnerCommissionHistory(partner.id),
  ]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-navy">Partner Dashboard</h1>
          <p className="mt-1 text-sm text-gray-600">{data.partner.firmName}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-right">
          <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
            Current commission rate
          </p>
          <p className="text-2xl font-bold text-navy">{data.tier.ratePct}%</p>
        </div>
      </header>

      {/* ── Referral link ────────────────────────────────────────── */}
      {data.url ? (
        <section className="rounded-xl border border-gray-200 bg-white p-6">
          <h2 className="text-base font-semibold text-navy">Your partner referral link</h2>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
            <label htmlFor="partner-url" className="sr-only">
              Your partner referral link
            </label>
            <input
              id="partner-url"
              readOnly
              value={data.url}
              className="w-full flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3.5 py-2.5 font-mono text-sm text-navy"
            />
            <CopyLinkButton value={data.url} />
          </div>
          <p className="mt-3 text-sm text-gray-600">
            Referral code{" "}
            <span className="font-mono font-semibold text-navy">{data.code}</span>. Clients who sign
            up through this link start a 14-day free trial with no credit card required.
          </p>
        </section>
      ) : null}

      {/* ── Stats ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Referred signups", value: String(data.referredSignups) },
          { label: "On trial", value: String(data.trialingClients) },
          { label: "Paying clients", value: String(data.payingClients) },
          { label: "Lifetime commission", value: money(data.lifetimeCommissionCents) },
        ].map((stat) => (
          <div key={stat.label} className="rounded-xl border border-gray-200 bg-white px-4 py-3.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
              {stat.label}
            </div>
            <div className="mt-1 text-xl font-bold text-navy">{stat.value}</div>
          </div>
        ))}
      </div>

      {/* ── Tier progress ───────────────────────────────────────── */}
      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="text-base font-semibold text-navy">Your tier</h2>
        {data.nextTier && data.clientsToNextTier != null ? (
          <>
            <p className="mt-2 text-sm text-gray-600">
              You&rsquo;re earning <strong className="text-navy">{data.tier.ratePct}%</strong> with{" "}
              {data.payingClients} paying{" "}
              {data.payingClients === 1 ? "client" : "clients"}.{" "}
              {data.clientsToNextTier} more takes you to{" "}
              <strong className="text-navy">{data.nextTier.ratePct}%</strong>.
            </p>
            <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-gray-100">
              <div
                className="h-full rounded-full bg-brand"
                style={{
                  width: `${Math.min(100, Math.round((data.payingClients / data.nextTier.minPayingClients) * 100))}%`,
                }}
              />
            </div>
            <p className="mt-2 text-xs text-gray-500">
              {data.payingClients} of {data.nextTier.minPayingClients} paying clients
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-gray-600">
            You&rsquo;re at the top tier, earning{" "}
            <strong className="text-navy">{data.tier.ratePct}%</strong> on subscription revenue.
          </p>
        )}
        <p className="mt-4 border-t border-gray-100 pt-3 text-xs leading-relaxed text-gray-500">
          Your rate is applied when each invoice is paid and then fixed for that commission. Moving
          up a tier raises the rate on future invoices. It doesn&rsquo;t retroactively
          re-price commissions already earned.
        </p>
      </section>

      {data.freeAccountEarned ? (
        <section className="rounded-xl border border-green-300 bg-green-50 p-5">
          <p className="text-sm text-green-900">
            <strong>Your firm has earned a complimentary JobProfitAI account.</strong> Email{" "}
            <a href="mailto:support@jobprofitai.com" className="font-medium underline">
              support@jobprofitai.com
            </a>{" "}
            and we&rsquo;ll set it up.
          </p>
        </section>
      ) : null}

      {/* ── Commission ledger ───────────────────────────────────── */}
      <section className="rounded-xl border border-gray-200 bg-white">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-navy">Commission ledger</h2>
            <p className="mt-1 text-xs text-gray-500">
              Client identities aren&rsquo;t shown. Referring a client doesn&rsquo;t entitle
              you to their account details.
            </p>
          </div>
          <div className="flex gap-4 text-right text-sm">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-gray-500">Awaiting payout</p>
              <p className="font-bold text-navy">{money(data.pendingCommissionCents)}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-gray-500">Paid</p>
              <p className="font-bold text-navy">{money(data.paidCommissionCents)}</p>
            </div>
          </div>
        </div>

        {commissions.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-gray-500">
            No commissions yet. They&rsquo;ll appear here as soon as a referred client&rsquo;s first
            invoice is paid.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th scope="col" className="px-6 py-2.5 font-medium">Earned</th>
                  <th scope="col" className="px-6 py-2.5 font-medium">Month</th>
                  <th scope="col" className="px-6 py-2.5 font-medium">Subscription revenue</th>
                  <th scope="col" className="px-6 py-2.5 font-medium">Rate</th>
                  <th scope="col" className="px-6 py-2.5 font-medium">Commission</th>
                  <th scope="col" className="px-6 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {commissions.map((row) => (
                  <tr key={row.id}>
                    <td className="px-6 py-3 text-gray-600">{formatDate(row.earnedAt)}</td>
                    <td className="px-6 py-3 text-gray-600">
                      {row.monthNumber} of {PARTNER_COMMISSION_MONTHS}
                    </td>
                    <td className="px-6 py-3 tabular-nums text-gray-600">
                      {money(row.subscriptionRevenueCents)}
                    </td>
                    <td className="px-6 py-3 text-gray-600">{row.commissionRateBps / 100}%</td>
                    <td className="px-6 py-3 font-semibold tabular-nums text-navy">
                      {money(row.commissionCents)}
                    </td>
                    <td className="px-6 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          row.status === "paid"
                            ? "bg-green-50 text-green-700"
                            : row.status === "voided"
                              ? "bg-gray-100 text-gray-500"
                              : "bg-blue-50 text-blue-700"
                        }`}
                      >
                        {row.status === "earned" ? "Awaiting payout" : row.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Honest statement about how payouts actually work. */}
      <section className="rounded-xl border border-gray-200 bg-gray-50 p-5">
        <h2 className="text-sm font-semibold text-navy">How payouts work</h2>
        <p className="mt-2 text-sm leading-relaxed text-gray-600">
          Commissions are tracked automatically in the ledger above, and paid out by our team.
          JobProfitAI does not yet move money to partners automatically, that needs
          connected-account onboarding, identity verification and tax reporting we haven&rsquo;t
          built, and we&rsquo;d rather tell you that than imply otherwise. You&rsquo;ll see every
          commission as it&rsquo;s earned and get a confirmation when a payout is recorded. Questions
          about a payout:{" "}
          <a href="mailto:support@jobprofitai.com" className="font-medium text-brand hover:underline">
            support@jobprofitai.com
          </a>
          .
        </p>
      </section>
    </div>
  );
}
