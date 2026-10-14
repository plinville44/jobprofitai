import { NextRequest, NextResponse } from "next/server";
import { refuseCrossSite } from "@/lib/sameOrigin";
import { getSession } from "@/lib/auth";
import { hasAcceptedCurrentTerms, recordAcceptance } from "@/lib/termsAcceptance";

/**
 * POST /api/legal/accept  { acceptTerms: true }
 *
 * Records the signed-in login's agreement to the current Terms of Service
 * and Privacy Policy, from /accept-terms. Once per version.
 */
export async function POST(req: NextRequest) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { acceptTerms?: unknown };
  if (body.acceptTerms !== true) {
    return NextResponse.json({ error: "Please check the box to agree." }, { status: 400 });
  }
  if (!(await hasAcceptedCurrentTerms(session.userId))) {
    await recordAcceptance(session.userId, "reaccept", req.headers);
  }
  return NextResponse.json({ ok: true });
}
