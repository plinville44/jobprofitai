import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/adminAuth";
import { decideHeldReferral } from "@/lib/referrals";

/**
 * POST /api/admin/referrals  { referralId, action: "clear" | "disqualify" }
 *
 * A person's decision on a referral held for a check because its account's
 * email address was first proven by a password reset (audit Oct 27, B3).
 * "clear" (Looks fine) takes the note off and lets the referral earn as
 * usual; "disqualify" disqualifies it and voids what the hold kept back.
 * See decideHeldReferral in src/lib/referrals.ts.
 *
 * Admin only, checked here as well as on the pages. Cross-site requests are
 * refused before this runs, as for every API route (src/proxy.ts).
 */
export const runtime = "nodejs";

const DecisionSchema = z.object({
  referralId: z.string().min(1).max(100),
  action: z.enum(["clear", "disqualify"]),
});

export async function POST(req: NextRequest) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Not authorized" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = DecisionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  try {
    const result = await decideHeldReferral(parsed.data.referralId, parsed.data.action);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, decision: result.decision });
  } catch (err) {
    console.error("admin/referrals failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json({ error: "Action failed." }, { status: 500 });
  }
}
