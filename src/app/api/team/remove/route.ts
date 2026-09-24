import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccount } from "@/lib/account";
import { revokeAllSessions } from "@/lib/auth";

/**
 * POST /api/team/remove { id }
 *
 * Owner only. Cancels an invitation or removes a team member. A removed
 * member is signed out everywhere at once, so access ends now rather than
 * when their session cookie happens to expire.
 */
export async function POST(req: NextRequest) {
  const account = await getAccount();
  if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (account.role !== "owner") {
    return NextResponse.json({ error: "Only the account owner can remove team members." }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const id = typeof body?.id === "string" ? body.id : "";
  const row = id ? await prisma.teamMember.findUnique({ where: { id } }) : null;
  if (!row || row.ownerUserId !== account.ownerId) {
    return NextResponse.json({ error: "Team member not found." }, { status: 404 });
  }
  await prisma.teamMember.delete({ where: { id: row.id } });
  if (row.memberUserId) await revokeAllSessions(row.memberUserId);
  return NextResponse.json({ ok: true });
}
