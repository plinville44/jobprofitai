import { NextRequest, NextResponse } from "next/server";
import { ACTIVE_COMPANY_COOKIE, connectionForAccount, getAccount } from "@/lib/account";

/** POST /api/company/select { connectionId }: which company the dashboard shows. */
export async function POST(req: NextRequest) {
  const account = await getAccount();
  if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const connection = await connectionForAccount(account, body?.connectionId);
  if (!connection) return NextResponse.json({ error: "Company not found" }, { status: 404 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACTIVE_COMPANY_COOKIE, connection.id, {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
