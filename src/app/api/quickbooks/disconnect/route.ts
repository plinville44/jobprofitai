import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { revokeToken } from "@/lib/quickbooks";
import { decryptToken } from "@/lib/crypto";

/**
 * POST /api/quickbooks/disconnect  { connectionId }
 *
 * Revokes the connection's tokens with Intuit and marks it disconnected
 * locally (soft delete via `disconnectedAt`, not a hard delete - keeps the
 * historical Jobs/CostEntries/Digests around in case the customer
 * reconnects). Reconnecting the same QuickBooks company later clears
 * `disconnectedAt` again (see /api/quickbooks/callback).
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const { connectionId } = await req.json();
    const connection = await prisma.quickBooksConnection.findUnique({
      where: { id: connectionId },
    });
    if (!connection || connection.userId !== session.userId) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    // Revoking the refresh token invalidates the paired access token too.
    // Best-effort: revokeToken() logs and swallows failures internally so a
    // token that's already invalid on Intuit's side doesn't block the local
    // disconnect below.
    await revokeToken(decryptToken(connection.refreshToken));

    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: { disconnectedAt: new Date() },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("quickbooks/disconnect failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Disconnect failed." },
      { status: 500 }
    );
  }
}
