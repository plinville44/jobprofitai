import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { getSession } from "@/lib/auth";
import { accountFor, ACTIVE_COMPANY_COOKIE } from "@/lib/account";
import { exchangeCodeForTokens } from "@/lib/quickbooks";
import { attachCompany, OWNER_ONLY_CONNECT_NOTICE } from "@/lib/connectCompany";
import { handleIntuitFlow } from "@/lib/intuitSignIn";

// Token exchange, company lookups and a revoke can all happen here.
export const maxDuration = 60;

const appUrl = (path: string) => new URL(path, process.env.APP_URL);
/**
 * Every answer from this route is a 302 redirect with no page in it. Intuit
 * puts the authorization code and the company's realm ID in this URL, and
 * its security requirements say an endpoint that receives them must answer
 * with a 302 rather than HTML, so they can't leak to another site in a
 * Referer header.
 */
const found = (path: string) => NextResponse.redirect(appUrl(path), 302);

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
    return found(`/dashboard?qbo_error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return found("/dashboard?qbo_error=missing_params");
  }

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(state, new TextEncoder().encode(process.env.AUTH_SECRET)));
  } catch {
    // Expired or forged state: refuse rather than trust the realmId blindly.
    return found("/dashboard?qbo_error=invalid_state");
  }

  const flow = typeof payload.flow === "string" ? payload.flow : "connect";
  try {
    if (flow === "connect") return await handleConnect(payload, code, realmId);
    // Sign in with Intuit and the QuickBooks App Store flow live in their
    // own module; see src/lib/intuitSignIn.ts.
    // The request's own headers: the ad source and opt-out cookies and the
    // country header are read from them for a signup (see intuitSignIn.ts).
    return await handleIntuitFlow(flow, payload, code, realmId, req.headers);
  } catch (err) {
    console.error("quickbooks/callback failed:", err instanceof Error ? err.message : "Unknown error");
    return found("/dashboard?qbo_error=connection_failed");
  }
}

async function handleConnect(payload: Record<string, unknown>, code: string, realmId: string | null) {
  if (!realmId) return found("/dashboard?qbo_error=missing_params");
  const actorId = typeof payload.actorId === "string" ? payload.actorId : null;
  const ownerId = typeof payload.ownerId === "string" ? payload.ownerId : null;
  const reconnectId = typeof payload.reconnect === "string" ? payload.reconnect : null;

  const session = await getSession();
  if (!actorId || !ownerId || !session || session.userId !== actorId) {
    // Not the browser that started this. Nothing is exchanged or stored.
    return found("/login?next=/dashboard&notice=qbo_session");
  }
  // Still a member of that account? (An owner could have removed them in
  // the ten minutes since.)
  const account = await accountFor(actorId);
  if (account.ownerId !== ownerId) {
    return found("/dashboard?qbo_error=invalid_state");
  }
  if (account.role === "client") {
    return found("/dashboard?qbo_error=view_only");
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code);
  } catch (err) {
    console.error("quickbooks/callback: token exchange failed:", err instanceof Error ? err.message : "Unknown error");
    return found("/dashboard?qbo_error=token_exchange_failed");
  }

  const result = await attachCompany({ ownerId, realmId, tokens, reconnectId, actorRole: account.role });
  if (!result.ok) {
    const target =
      result.code === "already_connected" || result.code === "verify_failed"
        ? `/dashboard?qbo_error=${result.code}`
        : result.code === "owner_only"
          ? `/dashboard/settings?notice=${OWNER_ONLY_CONNECT_NOTICE}`
          : `/dashboard/billing?limit=${result.code}`;
    return found(target);
  }

  const res = found("/dashboard?qbo_connected=1");
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
