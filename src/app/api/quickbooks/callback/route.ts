import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { getSession } from "@/lib/auth";
import { accountFor, ACTIVE_COMPANY_COOKIE } from "@/lib/account";
import { exchangeCodeForTokens } from "@/lib/quickbooks";
import { attachCompany } from "@/lib/connectCompany";
import { handleIntuitFlow } from "@/lib/intuitSignIn";

// Token exchange, company lookups and a revoke can all happen here.
export const maxDuration = 60;

const appUrl = (path: string) => new URL(path, process.env.APP_URL);

/**
 * GET /api/quickbooks/callback?code=...&state=...&realmId=...
 * Intuit redirects here after the contractor approves (or denies) access.
 *
 * The state must come back to the same signed-in browser session that
 * started the connection. Checking only the state's signature (as this
 * route used to) let a link generated in one account, if someone else
 * approved it on Intuit's screen within ten minutes, attach THEIR company
 * to the first account.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const realmId = url.searchParams.get("realmId");
  const error = url.searchParams.get("error");

  if (error) {
    // Most commonly "access_denied": the contractor backed out of the consent screen.
    return NextResponse.redirect(appUrl(`/dashboard?qbo_error=${encodeURIComponent(error)}`));
  }
  if (!code || !state) {
    return NextResponse.redirect(appUrl("/dashboard?qbo_error=missing_params"));
  }

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(state, new TextEncoder().encode(process.env.AUTH_SECRET)));
  } catch {
    // Expired or forged state: refuse rather than trust the realmId blindly.
    return NextResponse.redirect(appUrl("/dashboard?qbo_error=invalid_state"));
  }

  const flow = typeof payload.flow === "string" ? payload.flow : "connect";
  try {
    if (flow === "connect") return await handleConnect(payload, code, realmId);
    // Sign in with Intuit and the QuickBooks App Store flow live in their
    // own module; see src/lib/intuitSignIn.ts.
    return await handleIntuitFlow(flow, payload, code, realmId);
  } catch (err) {
    console.error("quickbooks/callback failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.redirect(appUrl("/dashboard?qbo_error=connection_failed"));
  }
}

async function handleConnect(payload: Record<string, unknown>, code: string, realmId: string | null) {
  if (!realmId) return NextResponse.redirect(appUrl("/dashboard?qbo_error=missing_params"));
  const actorId = typeof payload.actorId === "string" ? payload.actorId : null;
  const ownerId = typeof payload.ownerId === "string" ? payload.ownerId : null;
  const reconnectId = typeof payload.reconnect === "string" ? payload.reconnect : null;

  const session = await getSession();
  if (!actorId || !ownerId || !session || session.userId !== actorId) {
    // Not the browser that started this. Nothing is exchanged or stored.
    return NextResponse.redirect(appUrl("/login?next=/dashboard&notice=qbo_session"));
  }
  // Still a member of that account? (An owner could have removed them in
  // the ten minutes since.)
  const account = await accountFor(actorId);
  if (account.ownerId !== ownerId) {
    return NextResponse.redirect(appUrl("/dashboard?qbo_error=invalid_state"));
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code);
  } catch (err) {
    console.error("quickbooks/callback: token exchange failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.redirect(appUrl("/dashboard?qbo_error=token_exchange_failed"));
  }

  const result = await attachCompany({ ownerId, realmId, tokens, reconnectId });
  if (!result.ok) {
    const target =
      result.code === "already_connected" || result.code === "verify_failed"
        ? `/dashboard?qbo_error=${result.code}`
        : `/dashboard/billing?limit=${result.code}`;
    return NextResponse.redirect(appUrl(target));
  }

  const res = NextResponse.redirect(appUrl("/dashboard?qbo_connected=1"));
  // Show the company just connected, which matters on a multi-company plan.
  res.cookies.set(ACTIVE_COMPANY_COOKIE, result.connectionId, {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
