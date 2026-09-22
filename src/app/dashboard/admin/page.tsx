import { formatCents } from "@/lib/format";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { StatGrid } from "@/components/dashboard/AdminTable";

export const dynamic = "force-dynamic";

/** Shared, so every screen shows the same amount to the cent. */
const money = formatCents;

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
    prisma.subscription.count({ where: { status: "past_due" } }),
    prisma.referral.count({ where: { kind: "customer" } }),
    prisma.referral.count({ where: { kind: "customer", status: "qualified" } }),
    prisma.referralReward.findMany({ select: { status: true, amountCents: true } }),
    prisma.partner.count({ where: { status: "pending" } }),
    prisma.partner.count({ where: { status: "approved" } }),
    prisma.partnerCommission.findMany({ select: { status: true, commissionCents: true } }),
    prisma.contactSubmission.count(),
    prisma.emailEvent.count({ where: { status: "failed" } }),
  ]);
  // Counted separately from past_due: unpaid accounts have lost access,
  // past_due ones haven't, and the overview used to report both as "past due".
  const unpaid = await prisma.subscription.count({ where: { status: "unpaid" } });

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
            { label: "Paying (active)", value: String(paying) },
          ]}
        />
        <p className="mt-2 text-xs text-gray-500">
          &ldquo;Activated&rdquo; means QuickBooks connected <em>and</em> a first analysis run: the
          conversion metric worth watching. &ldquo;Paying&rdquo; counts active subscriptions only;
          partner tiers also count accounts in their payment-retry period.
          {pastDue > 0 ? ` ${pastDue} account(s) in the payment-retry period, still with access.` : ""}
          {unpaid > 0 ? ` ${unpaid} account(s) unpaid, access paused.` : ""}
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
            {partnersPending} partner application(s) waiting on review:{" "}
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
            { label: "Failed sends (all time)", value: String(emailFailures) },
          ]}
        />
        {emailFailures > 0 ? (
          <p className="mt-2 text-xs font-medium text-amber-700">
            {emailFailures} send attempt(s) have failed since launch. Each failure is retried on the
            next cron run and this count never goes down, so what matters is whether it keeps
            rising. If it does, check the Resend domain and API key.
          </p>
        ) : null}
      </section>
    </div>
  );
}
