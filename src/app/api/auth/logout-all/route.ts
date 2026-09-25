import { NextResponse } from "next/server";
import { clearSession, getSession, revokeAllSessions } from "@/lib/auth";

/**
 * POST /api/auth/logout-all
 *
 * Signs this account out on every device, this one included. For a lost
 * phone, a shared computer, or a login that was given to someone who
 * shouldn't have it any more.
 */
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  await revokeAllSessions(session.userId);
  await clearSession();
  return NextResponse.json({ ok: true });
}
