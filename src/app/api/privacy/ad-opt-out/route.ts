import { NextRequest, NextResponse } from "next/server";
import { refuseCrossSite } from "@/lib/sameOrigin";
import { getSession } from "@/lib/auth";
import { clearPrivacyPageOptOut, recordAdOptOut } from "@/lib/adOptOut";

/**
 * POST /api/privacy/ad-opt-out  { optOut: boolean }
 *
 * Called by Your Privacy Choices. The browser part of the choice (the
 * jpai_optout cookie) is set by the page itself; this saves it on the
 * account when someone is signed in, so it also stops anything reported to
 * Google or LinkedIn from the server. A request that carries the browser's
 * Global Privacy Control header is recorded as a GPC opt-out. Signed out,
 * there's nothing to save and it says so.
 */
export async function POST(req: NextRequest) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  const body = (await req.json().catch(() => ({}))) as { optOut?: unknown };
  if (typeof body.optOut !== "boolean") return NextResponse.json({ error: "optOut must be true or false." }, { status: 400 });

  const session = await getSession();
  if (!session) return NextResponse.json({ saved: false });

  if (body.optOut) {
    const gpc = req.headers.get("sec-gpc")?.trim() === "1";
    await recordAdOptOut(session.userId, gpc ? "gpc" : "privacy_page");
  } else {
    await clearPrivacyPageOptOut(session.userId);
  }
  return NextResponse.json({ saved: true });
}
