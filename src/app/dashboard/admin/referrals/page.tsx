import { prisma } from "@/lib/prisma";
import { NO_VALUE, formatDate } from "@/lib/format";
import { AdminSection, AdminTable, Pill, Td } from "@/components/dashboard/AdminTable";

export const dynamic = "force-dynamic";

function money(cents: number | null | undefined): string {
  if (cents == null) return NO_VALUE;
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

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
            <Td>{r.referredUser?.subscription?.plan ?? NO_VALUE}</Td>
            <Td>
              <Pill tone={TONE[r.status] ?? "neutral"}>{r.status}</Pill>
              {r.disqualifiedReason ? (
                <span className="mt-1 block text-xs text-gray-500">{r.disqualifiedReason}</span>
              ) : null}
            </Td>
            <Td className="font-medium text-navy">{money(r.reward?.amountCents)}</Td>
            <Td className="whitespace-nowrap">
              {r.reward?.appliedAt ? (
                formatDate(r.reward.appliedAt)
              ) : r.reward?.status === "pending" ? (
                <Pill tone="warn">pending</Pill>
              ) : r.reward?.status === "voided" ? (
                <Pill tone="bad">voided</Pill>
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
