import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccount } from "@/lib/account";
import { refuseCrossSite } from "@/lib/sameOrigin";

/**
 * POST /api/opportunities/stop  { actionId, remove?: boolean }
 *
 * Stops tracking a pricing change (it stays listed with its result so far),
 * or removes it altogether when it was tracked by mistake.
 */
export async function POST(req: NextRequest) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const actionId = typeof body?.actionId === "string" ? body.actionId : null;
    if (!actionId) return NextResponse.json({ error: "Missing actionId." }, { status: 400 });

    // Ownership in the WHERE clause, as everywhere else that edits a row.
    const where = { id: actionId, connection: { userId: account.ownerId } };
    const result =
      body?.remove === true
        ? await prisma.profitAction.deleteMany({ where })
        : await prisma.profitAction.updateMany({ where: { ...where, stoppedAt: null }, data: { stoppedAt: new Date() } });
    if (result.count === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("opportunities/stop failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json({ error: "Couldn't save that. Please try again." }, { status: 500 });
  }
}
