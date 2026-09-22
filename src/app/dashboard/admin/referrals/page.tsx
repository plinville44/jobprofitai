import { prisma } from "@/lib/prisma";
import { NO_VALUE, formatDate, formatCents } from "@/lib/format";
import { AdminSection, AdminTable, Pill, Td } from "@/components/dashboard/AdminTable";
import { planDisplayName } from "@/lib/plans";

export const dynamic = "force-dynamic";

/** Shared, so every screen shows the same amount to the cent. */
const money = formatCents;

const TONE: Record<string, "neutral" | "good" | "warn" | "bad" | "info"> = {
  signed_up: "neutral",
  paid: "info",
  qualified: "good",
  disqualified: "bad",
};

/**
 * Full referral ledger. Unlike the customer-facing referral dashboard - which
 * deliberately shows no identifying detail about referred businesses - this
 * admin view does show both sides, because reconciling a credit against a
 * Stripe balance transaction is impossible without knowing who's who.
 */
export default async function AdminReferralsPage() {
  const referrals = await prisma.referral.findMany({
    orderBy: { signedUpAt: "desc" },
    take: 300,
    include: {
      referrer: { select: { email: true } },
      referredUser: { select: { email: true, subscription: { select: { status: true, plan: true } } } },
      partner: { select: { firmName: true } },
      reward: true,
    },
  });

  return (
    <AdminSection
      title="Referrals"
      description="Both programs. Customer referrals earn account credit; partner referrals earn commission (see the Partners tab)."
    >
      <AdminTable
        headers={["Signed up", "Type", "Referrer", "Referred account", "Plan", "Status", "Credit", "Applied"]}
        empty={referrals.length === 0}
        minWidth={1040}
      >
        {referrals.map((r) => (
          <tr key={r.id}>
            <Td className="whitespace-nowrap">{formatDate(r.signedUpAt)}</Td>
            <Td>
              {r.kind === "partner" ? <Pill tone="info">Partner</Pill> : <Pill>Customer</Pill>}
            </Td>
            <Td className="whitespace-nowrap">
              {r.kind === "partner" ? (r.partner?.firmName ?? NO_VALUE) : (r.referrer?.email ?? NO_VALUE)}
            </Td>
            <Td className="whitespace-nowrap">
              {r.referredUser?.email ?? <span className="text-gray-400">account deleted</span>}
            </Td>
            {/* The plan is only meaningful once they pay. Every new account
                carries the default plan id while on trial, so this column used
                to show a raw "profit_intelligence" for people paying nothing. */}
            <Td>
              {r.referredUser?.subscription?.status === "active" || r.referredUser?.subscription?.status === "past_due"
                ? planDisplayName(r.referredUser.subscription.plan)
                : r.referredUser?.subscription?.status === "trialing"
                  ? "On trial"
                  : NO_VALUE}
            </Td>
            <Td>
              <Pill tone={TONE[r.status] ?? "neutral"}>{r.status}</Pill>
              {r.disqualifiedReason ? (
                <span className="mt-1 block text-xs text-gray-500">{r.disqualifiedReason}</span>
              ) : null}
            </Td>
            <Td className="font-medium text-navy">{money(r.reward?.amountCents)}</Td>
            <Td className="whitespace-nowrap">
              {/* Status first: a reversed credit keeps its applied date, and
                  used to show that date instead of saying it was voided. */}
              {r.reward?.status === "voided" ? (
                <Pill tone="bad">voided</Pill>
              ) : r.reward?.status === "pending" ? (
                <Pill tone="warn">pending</Pill>
              ) : r.reward?.appliedAt ? (
                formatDate(r.reward.appliedAt)
              ) : (
                NO_VALUE
              )}
            </Td>
          </tr>
        ))}
      </AdminTable>
    </AdminSection>
  );
}
