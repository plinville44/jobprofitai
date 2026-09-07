import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/adminAuth";
import { approvePartner } from "@/lib/partners";
import { sendPartnerApproved } from "@/lib/email/lifecycle";

/**
 * POST /api/admin/partners  { partnerId, action }
 *
 * Approve, reject or suspend a partner firm. Approving issues the partner's
 * referral code and emails them their link.
 *
 * Approval grants a referral code and nothing else. It confers no access to
 * any contractor's QuickBooks data, financials or reports - that would
 * require the contractor's own explicit invitation, which is a separate
 * system entirely.
 */
export const runtime = "nodejs";

const ActionSchema = z.object({
  partnerId: z.string().min(1),
  action: z.enum(["approve", "reject", "suspend"]),
});

export async function POST(req: NextRequest) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Not authorized" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const { partnerId, action } = parsed.data;

  try {
    const partner = await prisma.partner.findUnique({ where: { id: partnerId } });
    if (!partner) return NextResponse.json({ error: "Partner not found." }, { status: 404 });

    if (action === "approve") {
      const { code, url } = await approvePartner(partnerId);
      try {
        await sendPartnerApproved(partner.userId, partner.id, partner.firmName, url);
      } catch (err) {
        console.error(
          "admin/partners: approval email failed (partner still approved):",
          err instanceof Error ? err.message : "Unknown error"
        );
      }
      return NextResponse.json({ ok: true, code, url });
    }

    await prisma.partner.update({
      where: { id: partnerId },
      data:
        action === "reject"
          ? { status: "rejected", rejectedAt: new Date() }
          : { status: "suspended" },
    });

    return NextResponse.json({ ok: true, status: action === "reject" ? "rejected" : "suspended" });
  } catch (err) {
    console.error("admin/partners failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json({ error: "Action failed." }, { status: 500 });
  }
}
