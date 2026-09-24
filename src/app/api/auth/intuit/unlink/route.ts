import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { refuseCrossSite } from "@/lib/sameOrigin";

/**
 * POST /api/auth/intuit/unlink
 *
 * Turns off Sign in with Intuit for the signed-in login. Its password
 * keeps working (someone who only ever used Intuit sets one with Forgot
 * password first; the Settings page says so).
 */
export async function POST(req: NextRequest) {
  const refused = refuseCrossSite(req, { requireJson: false });
  if (refused) return refused;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  await prisma.user.update({ where: { id: session.userId }, data: { intuitSub: null } });
  return NextResponse.json({ ok: true });
}
