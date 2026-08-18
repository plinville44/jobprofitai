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
 *
 * Returns plain text, not JSON, and deliberately formatted as two literal
 * `set` commands - the first version of this route returned JSON and asked
 * the person to manually select just the token out of a 600-character
 * quoted string, which is exactly the kind of copy-paste a browser or
 * terminal can silently corrupt (a dropped character breaks the token
 * completely - QuickBooks' API returns a generic "Could not decrypt JWT"
 * error either way, so a corrupted paste and an expired token look
 * identical from here). Selecting the *entire* page and pasting it
 * straight into Command Prompt removes that failure mode - see the chat
 * where this got added for the debugging story.
 */
export async function GET() {
  const plain = (body: string, status = 200) =>
    new NextResponse(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

  try {
    const session = await getSession();
    if (!session) return plain("Not authenticated - log into JobProfitAI first, then reload this page.", 401);

    const connection = await prisma.quickBooksConnection.findFirst({
      where: { userId: session.userId, disconnectedAt: null },
    });
    if (!connection) return plain("No connected QuickBooks company found for this account.", 404);

    const accessToken = await getValidAccessToken(connection);
    const realmId = decryptToken(connection.realmId);

    // Exactly two lines, nothing else - select-all + copy this whole page,
    // then paste directly into Command Prompt. It runs as two commands.
    return plain(`set QBO_ACCESS_TOKEN=${accessToken}\nset QBO_REALM_ID=${realmId}`);
  } catch (err) {
    console.error("debug/qbo-token failed:", err instanceof Error ? err.message : "Unknown error");
    return plain(err instanceof Error ? err.message : "Couldn't get a token.", 500);
  }
}
