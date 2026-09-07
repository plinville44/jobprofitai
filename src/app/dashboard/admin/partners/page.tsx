import { prisma } from "@/lib/prisma";
import { countPayingClients } from "@/lib/partners";
import { partnerTierFor } from "@/lib/plans";
import { formatDate } from "@/lib/format";
import { AdminSection, AdminTable, Pill, Td } from "@/components/dashboard/AdminTable";
import { MarkPaidButton, PartnerStatusActions } from "./PartnerAdminActions";

export const dynamic = "force-dynamic";

function money(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

export default async function AdminPartnersPage() {
  const partners = await prisma.partner.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
    include: {
      user: { select: { email: true } },
      referralCode: { select: { code: true } },
      commissions: {
        select: { id: true, status: true, commissionCents: true },
      },
      _count: { select: { referrals: true } },
    },
  });

  // Live paying-client counts drive the tier, so they're resolved per partner
  // rather than inferred from the commission rows.
  const payingCounts = await Promise.all(
    partners.map(async (p) => [p.id, await countPayingClients(p.id)] as const)
  );
  const payingById = new Map(payingCounts);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 bg-gray-50 px-5 py-4">
        <p className="text-sm leading-relaxed text-gray-700">
          <strong className="text-navy">Payouts are recorded here, not executed here.</strong>{" "}
          JobProfitAI has no automated partner payout system, no Stripe Connect, no identity
          verification, no tax reporting. Pay the partner by your own means first, then record it
          below so the ledger and their dashboard stay accurate.
        </p>
      </div>

      <AdminSection
        title="Partner firms"
        description="Approve applications, review commission owed, and record payouts."
      >
        <AdminTable
          headers={[
            "Firm",
            "Contact",
            "Status",
            "Code",
            "Referrals",
            "Paying",
            "Tier",
            "Owed",
            "Paid",
            "Actions",
          ]}
          empty={partners.length === 0}
          minWidth={1180}
        >
          {partners.map((p) => {
            const paying = payingById.get(p.id) ?? 0;
            const tier = partnerTierFor(paying);
            const earned = p.commissions.filter((c) => c.status === "earned");
            const owedCents = earned.reduce((t, c) => t + c.commissionCents, 0);
            const paidCents = p.commissions
              .filter((c) => c.status === "paid")
              .reduce((t, c) => t + c.commissionCents, 0);

            return (
              <tr key={p.id}>
                <Td className="whitespace-nowrap font-medium text-navy">
                  {p.firmName}
                  <span className="block text-xs font-normal text-gray-500">
                    applied {formatDate(p.createdAt)}
                  </span>
                </Td>
                <Td className="whitespace-nowrap">
                  {p.contactName}
                  <span className="block text-xs text-gray-500">{p.user?.email}</span>
                </Td>
                <Td>
                  {p.status === "approved" ? (
                    <Pill tone="good">approved</Pill>
                  ) : p.status === "pending" ? (
                    <Pill tone="warn">pending</Pill>
                  ) : (
                    <Pill tone="bad">{p.status}</Pill>
                  )}
                  {p.freeAccountGrantedAt ? (
                    <span className="mt-1 block text-xs text-gray-500">free account earned</span>
                  ) : null}
                </Td>
                <Td className="whitespace-nowrap font-mono text-xs">
                  {p.referralCode?.code ?? ", "}
                </Td>
                <Td>{p._count.referrals}</Td>
                <Td>{paying}</Td>
                <Td>{tier.ratePct}%</Td>
                <Td className="font-semibold text-navy">{money(owedCents)}</Td>
                <Td>{money(paidCents)}</Td>
                <Td>
                  <div className="space-y-2">
                    <PartnerStatusActions partnerId={p.id} status={p.status} />
                    {owedCents > 0 ? (
                      <MarkPaidButton
                        commissionIds={earned.map((c) => c.id)}
                        amountLabel={money(owedCents)}
                      />
                    ) : null}
                  </div>
                </Td>
              </tr>
            );
          })}
        </AdminTable>
      </AdminSection>
    </div>
  );
}
