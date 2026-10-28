import { notFound } from "next/navigation";
import { getAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import { countPayingClients, partnerPayout, payoutReferralStates } from "@/lib/partners";
import { UNPROVEN_REFERRAL_NOTE_START } from "@/lib/referrals";
import { partnerTierFor } from "@/lib/plans";
import { NO_VALUE, formatDate, formatCents } from "@/lib/format";
import { AdminSection, AdminTable, Pill, Td } from "@/components/dashboard/AdminTable";
import { MarkPaidButton, PartnerStatusActions } from "./PartnerAdminActions";
import { ReferralCheckActions } from "../referrals/ReferralCheckActions";

export const dynamic = "force-dynamic";

/** Shared, so every screen shows the same amount to the cent. */
const money = formatCents;

export default async function AdminPartnersPage() {
  // Checked here as well as in the admin layout. Next.js does not re-run a
  // layout on client-side navigation, so a layout-only check can be skipped
  // by requesting this page's data directly.
  if (!(await getAdminSession())) notFound();

  const partners = await prisma.partner.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
    include: {
      user: { select: { email: true } },
      referralCode: { select: { code: true } },
      commissions: {
        select: {
          id: true,
          status: true,
          commissionCents: true,
          paidNote: true,
          stripeInvoiceId: true,
          referralId: true,
        },
      },
      _count: { select: { referrals: true } },
      // Referrals left with a note to check before paying (flagUnprovenReferral,
      // audit Oct 27, B3), shown beside the Mark paid button where payouts
      // are made, not only on the referrals page.
      referrals: {
        where: { disqualifiedReason: { startsWith: UNPROVEN_REFERRAL_NOTE_START }, status: { not: "disqualified" } },
        select: { id: true, disqualifiedReason: true, referredUser: { select: { email: true } } },
      },
    },
  });

  // Live paying-client counts drive the tier, so they're resolved per partner
  // rather than inferred from the commission rows.
  const payingCounts = await Promise.all(
    partners.map(async (p) => [p.id, await countPayingClients(p.id)] as const)
  );
  const payingById = new Map(payingCounts);

  // Which referrals behind earned commission are held for a check or
  // disqualified: that commission isn't owed and isn't offered to Mark paid
  // (audit Oct 27, B3 review).
  const referralStates = await payoutReferralStates(
    partners.flatMap((p) => p.commissions.filter((c) => c.status === "earned").map((c) => c.referralId))
  );

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
            // Commission on a referral held for a check (the list below) stays
            // out of Owed and Mark paid until someone decides, and commission
            // on a disqualified referral isn't paid (audit Oct 27, B3 review).
            const { owedCents, payableIds, heldCents } = partnerPayout(p.commissions, referralStates);
            const paidCents = p.commissions
              .filter((c) => c.status === "paid")
              .reduce((t, c) => t + c.commissionCents, 0);
            // Commission already paid out on an invoice that was later
            // refunded or charged back. The webhook cannot void these (the
            // money has left), so it appends a REVIEW note instead - and
            // until this screen read that field, the note was written to a
            // column nothing displayed.
            const needsReview = p.commissions.filter(
              (c) => c.status === "paid" && c.paidNote?.includes("REVIEW")
            );

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
                  {p.referralCode?.code ?? NO_VALUE}
                </Td>
                <Td>{p._count.referrals}</Td>
                <Td>{paying}</Td>
                <Td>{tier.ratePct}%</Td>
                <Td className="font-semibold text-navy">
                  {money(owedCents)}
                  {p.referrals.length > 0 ? (
                    <div className="mt-1 font-normal">
                      <Pill tone="warn">
                        {money(heldCents)} held: {p.referrals.length}{" "}
                        {p.referrals.length === 1 ? "referral" : "referrals"} to check before paying
                      </Pill>
                      {p.referrals.map((r) => (
                        <div key={r.id} className="mt-1 text-xs text-gray-600">
                          {r.referredUser?.email ?? "account deleted"}: {r.disqualifiedReason}
                          <ReferralCheckActions referralId={r.id} />
                        </div>
                      ))}
                    </div>
                  ) : null}
                </Td>
                <Td>
                  {money(paidCents)}
                  {needsReview.length > 0 ? (
                    <span className="mt-1 block">
                      <Pill tone="bad">
                        {needsReview.length} to review
                      </Pill>
                      {needsReview.map((c) => (
                        <span key={c.id} className="mt-1 block text-xs text-gray-600">
                          {money(c.commissionCents)} on {c.stripeInvoiceId}:{" "}
                          {c.paidNote!.split("\n").filter((l) => l.startsWith("REVIEW")).join(" ")}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <div className="space-y-2">
                    <PartnerStatusActions partnerId={p.id} status={p.status} />
                    {owedCents > 0 ? (
                      <MarkPaidButton commissionIds={payableIds} amountLabel={money(owedCents)} />
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
