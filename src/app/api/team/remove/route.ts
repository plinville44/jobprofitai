import { NextRequest, NextResponse } from "next/server";
import { getAccount, refuseClient } from "@/lib/account";
import { revokeAllSessions } from "@/lib/auth";
import { removeTeamLogin } from "@/lib/teamRemoval";

/**
 * POST /api/team/remove { id }
 *
 * Owner only. Cancels an invitation or removes a team member or client
 * login. The address comes off every company's Weekly Profit Brief and alert
 * list too (see removeTeamLogin), and a removed login is signed out
 * everywhere at once, so access ends now rather than when their session
 * cookie happens to expire.
 */
export async function POST(req: NextRequest) {
  const account = await getAccount();
  if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const refused = refuseClient(account);
  if (refused) return refused;
  if (account.role !== "owner") {
    return NextResponse.json({ error: "Only the account owner can remove team members." }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const result = await removeTeamLogin(account.ownerId, body?.id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  if (result.memberUserId) await revokeAllSessions(result.memberUserId);
  return NextResponse.json({ ok: true });
}
