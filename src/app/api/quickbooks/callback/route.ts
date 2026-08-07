import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { prisma } from "@/lib/prisma";
import { exchangeCodeForTokens, detectCostTrackingMode } from "@/lib/quickbooks";
import { encryptToken } from "@/lib/crypto";

/**
 * GET /api/quickbooks/callback?code=...&state=...&realmId=...
 * Intuit redirects here after the contractor approves (or denies) access.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const realmId = url.searchParams.get("realmId");
  const error = url.searchParams.get("error");

  if (error) {
    // Most commonly "access_denied" - the contractor backed out of the consent screen.
    return NextResponse.redirect(
      new URL(`/dashboard?qbo_error=${encodeURIComponent(error)}`, process.env.APP_URL)
    );
  }

  if (!code || !state || !realmId) {
    return NextResponse.redirect(
      new URL("/dashboard?qbo_error=missing_params", process.env.APP_URL)
    );
  }

  let userId: string;
  try {
    const { payload } = await jwtVerify(
      state,
      new TextEncoder().encode(process.env.AUTH_SECRET)
    );
    if (typeof payload.userId !== "string") throw new Error("bad state payload");
    userId = payload.userId;
  } catch {
    // Expired/forged state token - refuse rather than trust the realmId blindly.
    return NextResponse.redirect(
      new URL("/dashboard?qbo_error=invalid_state", process.env.APP_URL)
    );
  }

  const tokens = await exchangeCodeForTokens(code);
  const now = Date.now();

  const connection = await prisma.quickBooksConnection.upsert({
    where: { realmId },
    create: {
      userId,
      realmId,
      environment: process.env.QBO_ENVIRONMENT ?? "sandbox",
      accessToken: encryptToken(tokens.access_token),
      refreshToken: encryptToken(tokens.refresh_token),
      accessTokenExpiresAt: new Date(now + tokens.expires_in * 1000),
      refreshTokenExpiresAt: new Date(now + tokens.x_refresh_token_expires_in * 1000),
    },
    update: {
      accessToken: encryptToken(tokens.access_token),
      refreshToken: encryptToken(tokens.refresh_token),
      accessTokenExpiresAt: new Date(now + tokens.expires_in * 1000),
      refreshTokenExpiresAt: new Date(now + tokens.x_refresh_token_expires_in * 1000),
      disconnectedAt: null,
    },
  });

  // Figure out up front whether this contractor tracks job cost via Projects
  // or Classes - the sync job (see /api/quickbooks/sync) branches on this.
  try {
    const mode = await detectCostTrackingMode(realmId, tokens.access_token);
    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: { costTrackingMode: mode },
    });
  } catch {
    // Non-fatal - sync will re-detect on first run if this lookup failed.
  }

  return NextResponse.redirect(
    new URL("/dashboard?qbo_connected=1", process.env.APP_URL)
  );
}
