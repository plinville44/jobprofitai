import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { decryptToken } from "@/lib/crypto";
import { getValidAccessToken } from "@/lib/quickbooksSync";

/**
 * TEMPORARY debug route - not part of the product, just a shortcut for
 * running scripts/seed-sandbox.js without having to go hunting through
 * Intuit's Developer Portal for the OAuth Playground (which moves around
 * and is easy to lose - see the chat where this got added).
 *
 * Returns a fresh access token + realm ID for the logged-in user's own
 * QuickBooks connection, using the exact same refresh-if-needed logic the
 * real sync already relies on (getValidAccessToken, exported from
 * quickbooksSync.ts for this purpose). Gated by session + ownership, same
 * as every other route - only useful to someone already logged into this
 * QuickBooks connection's JobProfitAI account, and only ever returns a
 * short-lived access token (never the refresh token), so it doesn't expose
 * anything a logged-in user couldn't already do by clicking "Sync now."
 *
 * Safe to delete once you're done seeding - it's not linked from anywhere
 * in the app, just a URL you visit directly.
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Not authenticated - log into JobProfitAI first, then reload this page." }, { status: 401 });

    const connection = await prisma.quickBooksConnection.findFirst({
      where: { userId: session.userId, disconnectedAt: null },
    });
    if (!connection) return NextResponse.json({ error: "No connected QuickBooks company found for this account." }, { status: 404 });

    const accessToken = await getValidAccessToken(connection);
    const realmId = decryptToken(connection.realmId);

    return NextResponse.json({
      accessToken,
      realmId,
      companyName: connection.companyName,
      note: "This access token is valid for about 60 minutes from now. Run scripts/seed-sandbox.js right away.",
    });
  } catch (err) {
    console.error("debug/qbo-token failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't get a token." },
      { status: 500 }
    );
  }
}
