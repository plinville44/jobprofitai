import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { applyToPartnerProgram } from "@/lib/partners";
import { sendPartnerApplicationReceived } from "@/lib/email/lifecycle";
import { sendEmail, SUPPORT_EMAIL } from "@/lib/email/client";

/**
 * POST /api/partner/apply
 *
 * Accountant / bookkeeper partner program application.
 *
 * Requires a signed-in account on purpose: a Partner is tied to a User, which
 * is what gives the partner somewhere to sign in and see their dashboard, and
 * what lets commission be attributed to a real, contactable party rather than
 * an anonymous form submission.
 *
 * Applications are reviewed by a human before approval. Nothing here grants
 * any access to contractor data - approval only issues a referral code.
 */
export const runtime = "nodejs";

const ApplySchema = z.object({
  firmName: z.string().trim().min(1, "Please enter your firm's name.").max(160),
  contactName: z.string().trim().min(1, "Please enter your name.").max(120),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  website: z.string().trim().max(200).optional().or(z.literal("")),
  clientCountEstimate: z.string().trim().max(120).optional().or(z.literal("")),
});

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: "Please create a JobProfitAI account first, then apply." },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const parsed = ApplySchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return NextResponse.json(
        { error: first?.message ?? "Please check the form and try again." },
        { status: 400 }
      );
    }

    const existing = await prisma.partner.findUnique({ where: { userId: session.userId } });
    if (existing) {
      return NextResponse.json({
        ok: true,
        alreadyApplied: true,
        status: existing.status,
      });
    }

    const partner = await applyToPartnerProgram(session.userId, {
      firmName: parsed.data.firmName,
      contactName: parsed.data.contactName,
      phone: parsed.data.phone || null,
      website: parsed.data.website || null,
      clientCountEstimate: parsed.data.clientCountEstimate || null,
    });

    // Confirmation to the applicant.
    try {
      await sendPartnerApplicationReceived(session.userId, partner.id, partner.firmName);
    } catch (err) {
      console.error(
        "partner/apply: applicant confirmation failed:",
        err instanceof Error ? err.message : "Unknown error"
      );
    }

    // Internal notification so an application doesn't sit unreviewed.
    try {
      const user = await prisma.user.findUnique({
        where: { id: session.userId },
        select: { email: true },
      });
      const lines = [
        `Firm: ${partner.firmName}`,
        `Contact: ${partner.contactName}`,
        `Account email: ${user?.email ?? "unknown"}`,
        `Phone: ${partner.phone ?? "-"}`,
        `Website: ${partner.website ?? "-"}`,
        `Contractor clients (estimate): ${partner.clientCountEstimate ?? "-"}`,
        "",
        `Approve in the admin partners view.`,
      ].join("\n");

      await sendEmail({
        to: process.env.CONTACT_TO_EMAIL?.trim() || SUPPORT_EMAIL,
        replyTo: user?.email ?? SUPPORT_EMAIL,
        subject: `[Partner application] ${partner.firmName}`,
        text: lines,
        html: `<pre style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;white-space:pre-wrap;">${lines
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}</pre>`,
      });
    } catch (err) {
      console.error(
        "partner/apply: internal notification failed:",
        err instanceof Error ? err.message : "Unknown error"
      );
    }

    return NextResponse.json({ ok: true, status: partner.status });
  } catch (err) {
    console.error("partner/apply failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json(
      { error: "We couldn't submit your application. Please email support@jobprofitai.com." },
      { status: 500 }
    );
  }
}
