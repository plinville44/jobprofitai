import { syncFirmQuantity } from "@/lib/stripe/firmQuantity";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccount, refuseClient } from "@/lib/account";
import { revokeToken } from "@/lib/quickbooks";
import { decryptToken } from "@/lib/crypto";
import { revokeAllSessions } from "@/lib/auth";
import { removeClientLoginsForCompany } from "@/lib/teamRemoval";

/**
 * POST /api/quickbooks/disconnect  { connectionId }
 *
 * Revokes the connection's tokens with Intuit and marks it disconnected
 * locally (soft delete via `disconnectedAt`, not a hard delete - keeps the
 * historical Jobs/CostEntries/Digests around in case the customer
 * reconnects). Reconnecting the same QuickBooks company later clears
 * `disconnectedAt` again (see /api/quickbooks/callback).
 *
 * Client logins for the company lose their access here, and are signed
 * out. Reconnecting doesn't give it back: the owner invites them again, so
 * nobody regains a view of a client's books without the owner choosing it.
 */
export async function POST(req: NextRequest) {
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const refused = refuseClient(account);
    if (refused) return refused;
    if (account.role !== "owner") {
      return NextResponse.json({ error: "Only the account owner can disconnect a QuickBooks company." }, { status: 403 });
    }

    const { connectionId } = await req.json();
    const connection = await prisma.quickBooksConnection.findUnique({
      where: { id: connectionId },
    });
    if (!connection || connection.userId !== account.ownerId) {
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
    const signOut = await removeClientLoginsForCompany(account.ownerId, connection.id);
    for (const userId of signOut) await revokeAllSessions(userId).catch(() => {});
    // Firm: one company fewer to bill (never below the minimum).
    await syncFirmQuantity(account.ownerId);

    return NextResponse.json({ ok: true });
  } catch (err) {
    // Message only, never the full error object - see the matching comment
    // in api/quickbooks/sync/route.ts for why.
    console.error("quickbooks/disconnect failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Disconnect failed." },
      { status: 500 }
    );
  }
}
