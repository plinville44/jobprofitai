import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { StatGrid } from "@/components/dashboard/AdminTable";

export const dynamic = "force-dynamic";

function money(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/**
 * Growth-systems overview. Deliberately counts only - the detail views
 * behind each link are where individual records live.
 */
export default async function AdminOverviewPage() {
  const now = new Date();

  const [
    users,
    trialing,
    activated,
    extended,
    paying,
    pastDue,
    referralsSignedUp,
    referralsQualified,
    rewards,
    partnersPending,
    partnersApproved,
    commissions,
    contactUnread,
    emailFailures,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.subscription.count({ where: { status: "trialing", trialEndsAt: { gt: now } } }),
    prisma.subscription.count({ where: { activatedAt: { not: null } } }),
    prisma.subscription.count({ where: { trialExtendedAt: { not: null } } }),
    prisma.subscription.count({ where: { status: "active" } }),
    prisma.subscription.count({ where: { status: { in: ["past_due", "unpaid"] } } }),
    prisma.referral.count(),
    prisma.referral.count({ where: { status: "qualified" } }),
    prisma.referralReward.findMany({ select: { status: true, amountCents: true } }),
    prisma.partner.count({ where: { status: "pending" } }),
    prisma.partner.count({ where: { status: "approved" } }),
    prisma.partnerCommission.findMany({ select: { status: true, commissionCents: true } }),
    prisma.contactSubmission.count(),
    prisma.emailEvent.count({ where: { status: "failed" } }),
  ]);

  const sum = <T extends { status: string }>(
    rows: (T & { amountCents?: number; commissionCents?: number })[],
    status: string,
    key: "amountCents" | "commissionCents"
  ) => rows.filter((r) => r.status === status).reduce((t, r) => t + ((r[key] as number) ?? 0), 0);

  const activationRate = users > 0 ? Math.round((activated / users) * 100) : 0;

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Accounts &amp; trials
        </h2>
        <StatGrid
          stats={[
            { label: "Total accounts", value: String(users) },
            { label: "On trial now", value: String(trialing) },
            { label: "Activated", value: `${activated} (${activationRate}%)` },
            { label: "Trials extended", value: String(extended) },
            { label: "Paying", value: String(paying) },
          ]}
        />
        <p className="mt-2 text-xs text-gray-500">
          &ldquo;Activated&rdquo; means QuickBooks connected <em>and</em> a first analysis run
, the conversion metric worth watching.
          {pastDue > 0 ? ` ${pastDue} account(s) currently past due.` : ""}
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Customer referrals
        </h2>
        <StatGrid
          stats={[
            { label: "Referred signups", value: String(referralsSignedUp) },
            { label: "Qualified", value: String(referralsQualified) },
            { label: "Credit pending", value: money(sum(rewards, "pending", "amountCents")) },
            { label: "Credit applied", value: money(sum(rewards, "applied", "amountCents")) },
            { label: "Voided", value: money(sum(rewards, "voided", "amountCents")) },
          ]}
        />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Partner program
        </h2>
        <StatGrid
          stats={[
            { label: "Awaiting review", value: String(partnersPending) },
            { label: "Approved partners", value: String(partnersApproved) },
            {
              label: "Commission owed",
              value: money(sum(commissions, "earned", "commissionCents")),
            },
            { label: "Commission paid", value: money(sum(commissions, "paid", "commissionCents")) },
            { label: "Voided", value: money(sum(commissions, "voided", "commissionCents")) },
          ]}
        />
        {partnersPending > 0 ? (
          <p className="mt-2 text-xs font-medium text-amber-700">
            {partnersPending} partner application(s) waiting on review, {" "}
            <Link href="/dashboard/admin/partners" className="underline">
              review them
            </Link>
            .
          </p>
        ) : null}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Operations
        </h2>
        <StatGrid
          stats={[
            { label: "Contact submissions", value: String(contactUnread) },
            { label: "Failed emails", value: String(emailFailures) },
          ]}
        />
        {emailFailures > 0 ? (
          <p className="mt-2 text-xs font-medium text-amber-700">
            {emailFailures} lifecycle email(s) failed to send. They&rsquo;re retried automatically
            on the next cron run, but a persistent count usually means a Resend domain or API key
            problem.
          </p>
        ) : null}
      </section>
    </div>
  );
}
