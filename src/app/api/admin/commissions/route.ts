import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/adminAuth";
import { markCommissionsPaid } from "@/lib/partners";
import { sendPartnerPayoutRecorded } from "@/lib/email/lifecycle";

/**
 * POST /api/admin/commissions  { commissionIds: string[], note?: string }
 *
 * Marks earned partner commissions as paid.
 *
 * This records a payout that a human has already made by other means. It
 * does NOT move money: there is no Stripe Connect account, no partner
 * identity verification, and no tax-reporting pipeline behind it, and
 * implementing automated payouts without those would be a compliance
 * problem, not a feature. The partner-facing UI says the same thing rather
 * than implying commissions are paid automatically.
 */
export const runtime = "nodejs";

const PaySchema = z.object({
  commissionIds: z.array(z.string().min(1)).min(1).max(500),
  note: z.string().trim().max(500).optional(),
});

export async function POST(req: NextRequest) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Not authorized" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = PaySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const { commissionIds, note } = parsed.data;

  try {
    // Load first so we know which partners to notify and for how much -
    // markCommissionsPaid only flips rows that are still "earned", so this
    // is naturally idempotent against a double-click.
    const rows = await prisma.partnerCommission.findMany({
      where: { id: { in: commissionIds }, status: "earned" },
      select: { id: true, partnerId: true, commissionCents: true },
    });

    if (rows.length === 0) {
      return NextResponse.json({ ok: true, updated: 0, detail: "Nothing left to mark paid." });
    }

    const updated = await markCommissionsPaid(
      rows.map((r) => r.id),
      note ?? null
    );

    // One notification per partner covering their whole payout, rather than
    // an email per commission row.
    const byPartner = new Map<string, number>();
    for (const row of rows) {
      byPartner.set(row.partnerId, (byPartner.get(row.partnerId) ?? 0) + row.commissionCents);
    }

    for (const [partnerId, amountCents] of byPartner) {
      try {
        const partner = await prisma.partner.findUnique({
          where: { id: partnerId },
          select: { userId: true },
        });
        if (!partner) continue;

        // Stable per-payout key so re-running this can't email twice, but a
        // genuinely separate later payout still notifies.
        const payoutRef = crypto
          .createHash("sha256")
          .update(rows.filter((r) => r.partnerId === partnerId).map((r) => r.id).sort().join(","))
          .digest("hex")
          .slice(0, 32);

        await sendPartnerPayoutRecorded({
          partnerUserId: partner.userId,
          payoutRef,
          amountCents,
          note: note ?? null,
        });
      } catch (err) {
        console.error(
          "admin/commissions: payout email failed (commissions still marked paid):",
          err instanceof Error ? err.message : "Unknown error"
        );
      }
    }

    return NextResponse.json({ ok: true, updated });
  } catch (err) {
    console.error(
      "admin/commissions failed:",
      err instanceof Error ? err.message : "Unknown error"
    );
    return NextResponse.json({ error: "Action failed." }, { status: 500 });
  }
}
