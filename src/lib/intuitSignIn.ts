import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { prisma } from "./prisma";
import { createSession, hashPassword } from "./auth";
import { accountFor, ACTIVE_COMPANY_COOKIE } from "./account";
import { attachCompany } from "./connectCompany";
import { hashRealmId, legacyHashRealmId } from "./crypto";
import { newTrialSubscriptionData } from "./trial";
import { attributeSignupReferral } from "./signupReferral";
import { REFERRAL_COOKIE } from "./referrals";
import {
  buildAuthorizeUrl,
  CONNECT_WITH_OPENID_SCOPES,
  exchangeCodeForTokens,
  fetchIntuitUserInfo,
  OPENID_SCOPES,
  revokeToken,
  type IntuitUserInfo,
} from "./quickbooks";

/**
 * Sign in with Intuit, and the QuickBooks App Store's "Get integration now".
 *
 * Both go through Intuit's OpenID Connect sign-in and come back to the same
 * callback as the Connect button (/api/quickbooks/callback), which hands
 * them here by the `flow` in the signed state.
 *
 *   intuit_signin   openid profile email. Signs in an existing person, or
 *                   asks an unknown one whether to link an existing login
 *                   (with its password) or create an account.
 *   intuit_appstore the same, plus QuickBooks access. A new person gets an
 *                   account and a free trial with the company connected,
 *                   and no password, plan or payment questions, which is
 *                   what the App Store's one-click trial requires.
 *
 * Intuit's rules, and where each is enforced:
 *   - Accounts are matched on Intuit's `sub`, never the email address
 *     (User.intuitSub; the email is only used to spot a possible existing
 *     login, which is then linked only after its password is entered).
 *   - Nobody gets in unless Intuit says the email is verified
 *     (`emailVerified`); otherwise they are sent to Intuit's page to fix it.
 *   - The callback must come back to the browser that started the flow: a
 *     random value in a short-lived cookie is also carried in the state.
 */

export const OIDC_NONCE_COOKIE = "jpai_oidc";
export const INTUIT_PENDING_COOKIE = "jpai_intuit";
export const INTUIT_VERIFY_EMAIL_URL = "https://accounts.intuit.com/app/account-manager/security";

const appUrl = (path: string) => new URL(path, process.env.APP_URL);
const secret = () => new TextEncoder().encode(process.env.AUTH_SECRET);
const cookieBase = () => ({
  path: "/",
  sameSite: "lax" as const,
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
});

export type IntuitIntent = "signin" | "appstore";

/** Sends the browser to Intuit's sign-in. */
export async function startIntuitFlow(intent: IntuitIntent, opts: { realmId?: string | null } = {}): Promise<NextResponse> {
  const nonce = randomBytes(16).toString("base64url");
  const state = await new SignJWT({
    flow: intent === "appstore" ? "intuit_appstore" : "intuit_signin",
    nonce,
    // QuickBooks Online Accountant launches for a particular company; land
    // on that one if it belongs to the account.
    ...(opts.realmId && /^\d{1,32}$/.test(opts.realmId) ? { realmHint: opts.realmId } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret());

  const res = NextResponse.redirect(
    await buildAuthorizeUrl(state, intent === "appstore" ? CONNECT_WITH_OPENID_SCOPES : OPENID_SCOPES)
  );
  res.cookies.set(OIDC_NONCE_COOKIE, nonce, { ...cookieBase(), maxAge: 600 });
  return res;
}

/** The Intuit identity waiting to be linked or turned into an account (see /login/intuit). */
export interface PendingIntuitIdentity {
  sub: string;
  email: string | null;
  name: string | null;
  /** They came from the App Store and still need to connect QuickBooks. */
  connect: boolean;
}

export async function readPendingIntuitIdentity(): Promise<PendingIntuitIdentity | null> {
  const token = (await cookies()).get(INTUIT_PENDING_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.purpose !== "intuit_pending" || typeof payload.sub !== "string") return null;
    return {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
      name: typeof payload.name === "string" ? payload.name : null,
      connect: payload.connect === true,
    };
  } catch {
    return null;
  }
}

export async function clearPendingIntuitIdentity(): Promise<void> {
  (await cookies()).delete(INTUIT_PENDING_COOKIE);
}

function displayName(info: Pick<IntuitUserInfo, "givenName" | "familyName">): string | null {
  const name = [info.givenName, info.familyName].filter(Boolean).join(" ").trim();
  return name ? name.slice(0, 120) : null;
}

/**
 * A new account for an Intuit identity: verified email (Intuit checked it),
 * linked to the `sub`, on a free trial. It gets a random password nobody
 * knows; "Forgot password" sets a real one if they ever want to sign in
 * without Intuit.
 */
export async function provisionIntuitUser(identity: { sub: string; email: string; name: string | null }) {
  const user = await prisma.user.create({
    data: {
      email: identity.email,
      passwordHash: await hashPassword(randomBytes(32).toString("base64url")),
      name: identity.name,
      emailVerifiedAt: new Date(),
      intuitSub: identity.sub,
      subscription: { create: newTrialSubscriptionData() },
    },
  });
  const hadReferralCookie = await attributeSignupReferral(user.id);
  if (hadReferralCookie) (await cookies()).set(REFERRAL_COOKIE, "", { path: "/", maxAge: 0 });
  return user;
}

/**
 * Gives back a QuickBooks grant this flow won't use, but only when no
 * account here has that company connected: revoking may disconnect the app
 * from the company altogether (not verified with Intuit either way), which
 * would cut off whoever legitimately has it.
 */
async function discardGrant(realmId: string, refreshToken: string): Promise<void> {
  try {
    const live = await prisma.quickBooksConnection.findFirst({
      where: { realmIdHash: { in: [hashRealmId(realmId), legacyHashRealmId(realmId)] }, disconnectedAt: null },
      select: { id: true },
    });
    if (!live) await revokeToken(refreshToken);
  } catch {
    // Best effort.
  }
}

/** The callback half. `flow` is "intuit_signin" or "intuit_appstore". */
export async function handleIntuitFlow(
  flow: string,
  payload: Record<string, unknown>,
  code: string,
  realmId: string | null
): Promise<NextResponse> {
  if (flow !== "intuit_signin" && flow !== "intuit_appstore") {
    return NextResponse.redirect(appUrl("/login?notice=invalid_state"));
  }
  const connecting = flow === "intuit_appstore";

  const cookieStore = await cookies();
  const nonce = cookieStore.get(OIDC_NONCE_COOKIE)?.value;
  cookieStore.delete(OIDC_NONCE_COOKIE);
  if (!nonce || payload.nonce !== nonce) {
    // Not the browser that started this. Nothing is exchanged.
    return NextResponse.redirect(appUrl("/login?notice=intuit_session"));
  }
  if (connecting && !realmId) return NextResponse.redirect(appUrl("/login?notice=intuit_failed"));

  let tokens;
  let info: IntuitUserInfo;
  try {
    tokens = await exchangeCodeForTokens(code);
    info = await fetchIntuitUserInfo(tokens.access_token);
  } catch (err) {
    console.error("intuit sign-in: token or userinfo failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.redirect(appUrl("/login?notice=intuit_failed"));
  }

  // Intuit's rule: no access unless Intuit has verified the address. Any
  // QuickBooks tokens from this attempt are discarded, not stored.
  if (!info.emailVerified || !info.email) {
    if (connecting) await discardGrant(realmId!, tokens.refresh_token);
    return NextResponse.redirect(appUrl("/login?notice=intuit_unverified"));
  }

  let user = await prisma.user.findUnique({ where: { intuitSub: info.sub } });

  if (!user) {
    const sameEmail = await prisma.user.findFirst({
      where: { email: { equals: info.email, mode: "insensitive" } },
      select: { id: true },
    });
    if (sameEmail || !connecting) {
      // Unknown Intuit identity. Either a login with this address already
      // exists (it can only be linked after its password is entered), or
      // they signed in without connecting QuickBooks: ask which they want.
      if (connecting) await discardGrant(realmId!, tokens.refresh_token);
      const pending = await new SignJWT({
        purpose: "intuit_pending",
        sub: info.sub,
        email: info.email,
        name: displayName(info),
        connect: connecting,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("15m")
        .sign(secret());
      const res = NextResponse.redirect(appUrl("/login/intuit"));
      res.cookies.set(INTUIT_PENDING_COOKIE, pending, { ...cookieBase(), maxAge: 900 });
      return res;
    }
    // New person arriving from the App Store: account and trial, no questions.
    try {
      user = await provisionIntuitUser({ sub: info.sub, email: info.email, name: displayName(info) });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        return NextResponse.redirect(appUrl("/login?notice=intuit_failed"));
      }
      throw err;
    }
  }

  await createSession(user.id);
  const account = await accountFor(user.id);

  if (!connecting) {
    const res = NextResponse.redirect(appUrl("/dashboard"));
    const hint = typeof payload.realmHint === "string" ? payload.realmHint : null;
    if (hint) {
      const company = await prisma.quickBooksConnection.findFirst({
        where: { realmIdHash: hashRealmId(hint), userId: account.ownerId, disconnectedAt: null },
        select: { id: true },
      });
      if (company) res.cookies.set(ACTIVE_COMPANY_COOKIE, company.id, { ...cookieBase(), maxAge: 60 * 60 * 24 * 365 });
    }
    return res;
  }

  const result = await attachCompany({ ownerId: account.ownerId, realmId: realmId!, tokens });
  if (!result.ok) {
    const target =
      result.code === "already_connected" || result.code === "verify_failed"
        ? `/dashboard?qbo_error=${result.code}`
        : `/dashboard/billing?limit=${result.code}`;
    return NextResponse.redirect(appUrl(target));
  }
  const res = NextResponse.redirect(appUrl("/dashboard?qbo_connected=1"));
  res.cookies.set(ACTIVE_COMPANY_COOKIE, result.connectionId, { ...cookieBase(), maxAge: 60 * 60 * 24 * 365 });
  return res;
}
