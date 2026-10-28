import { randomBytes } from "crypto";
import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { prisma } from "./prisma";
import { createSession, hashPassword } from "./auth";
import { carryAdOptOutToBrowser, noteBrowserOptOut, signupAdOptOut } from "./adOptOut";
import { SOURCE_COOKIE } from "./adSource";
import { reportServerEvent, signupAdSource, signupSessionId } from "./serverEvents";
import { findLoginByEmail } from "./loginThrottle";
import { accountFor, ACTIVE_COMPANY_COOKIE } from "./account";
import { attachCompany, OWNER_ONLY_CONNECT_NOTICE } from "./connectCompany";
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
 *                   The button on /signup uses this flow too, with
 *                   `signup: true` in the state: that visitor came through
 *                   our pages, so a new account there is measured like any
 *                   other signup (opt-out, where they came from, sign_up).
 *                   A real App Store arrival never passed our pages, and
 *                   nothing about it is kept or reported.
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
/** A 302 redirect: the callback's answers never carry a page (see /api/quickbooks/callback). */
const found = (url: URL) => NextResponse.redirect(url, 302);
const secret = () => new TextEncoder().encode(process.env.AUTH_SECRET);
const cookieBase = () => ({
  path: "/",
  sameSite: "lax" as const,
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
});

/** "signup" is the button on /signup: the App Store flow, from our own page. */
export type IntuitIntent = "signin" | "appstore" | "signup";

/** Sends the browser to Intuit's sign-in. */
export async function startIntuitFlow(intent: IntuitIntent, opts: { realmId?: string | null } = {}): Promise<NextResponse> {
  const nonce = randomBytes(16).toString("base64url");
  const connecting = intent !== "signin";
  const state = await new SignJWT({
    flow: connecting ? "intuit_appstore" : "intuit_signin",
    // Signed with the rest of the state, so only our signup page can ask
    // for a new account to be measured.
    ...(intent === "signup" ? { signup: true } : {}),
    nonce,
    // QuickBooks Online Accountant launches for a particular company; land
    // on that one if it belongs to the account.
    ...(opts.realmId && /^\d{1,32}$/.test(opts.realmId) ? { realmHint: opts.realmId } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret());

  const res = found(await buildAuthorizeUrl(state, connecting ? CONNECT_WITH_OPENID_SCOPES : OPENID_SCOPES));
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
export async function provisionIntuitUser(
  identity: { sub: string; email: string; name: string | null },
  /**
   * The agreement record (and any opt-out, or else where they came from)
   * when the person ticked the box on /login/intuit; the opt-out or source
   * alone for the button on /signup, which has no box to tick. An App Store
   * arrival has none of these, so it's asked to agree at /accept-terms
   * before the app opens (src/lib/termsAcceptance.ts), and nothing about it
   * is ever reported to Google from the server.
   */
  extra: Pick<
    Prisma.UserCreateInput,
    | "termsAcceptances"
    | "adOptOutAt"
    | "adOptOutSource"
    | "adGclid"
    | "utmSource"
    | "utmMedium"
    | "utmCampaign"
    | "utmTerm"
    | "landingPage"
    | "gaClientId"
  > = {}
) {
  const user = await prisma.user.create({
    data: {
      email: identity.email,
      passwordHash: await hashPassword(randomBytes(32).toString("base64url")),
      name: identity.name,
      emailVerifiedAt: new Date(),
      intuitSub: identity.sub,
      subscription: { create: newTrialSubscriptionData() },
      ...extra,
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

/** The request's headers, read through Next.js when the caller didn't pass them. */
async function headersOr(given: Headers | undefined): Promise<Headers> {
  if (given) return given;
  try {
    return new Headers(await headers());
  } catch {
    return new Headers();
  }
}

/**
 * The callback half. `flow` is "intuit_signin" or "intuit_appstore".
 * `requestHeaders` are the callback request's, for the opt-out and ad source
 * checks; read through Next.js when not passed.
 */
export async function handleIntuitFlow(
  flow: string,
  payload: Record<string, unknown>,
  code: string,
  realmId: string | null,
  requestHeaders?: Headers
): Promise<NextResponse> {
  if (flow !== "intuit_signin" && flow !== "intuit_appstore") {
    return found(appUrl("/login?notice=invalid_state"));
  }
  const connecting = flow === "intuit_appstore";
  // Started from the button on /signup (startIntuitFlow), not the App Store.
  const fromSignupPage = connecting && payload.signup === true;
  const reqHeaders = await headersOr(requestHeaders);

  const cookieStore = await cookies();
  const nonce = cookieStore.get(OIDC_NONCE_COOKIE)?.value;
  cookieStore.delete(OIDC_NONCE_COOKIE);
  if (!nonce || payload.nonce !== nonce) {
    // Not the browser that started this. Nothing is exchanged.
    return found(appUrl("/login?notice=intuit_session"));
  }
  if (connecting && !realmId) return found(appUrl("/login?notice=intuit_failed"));

  let tokens;
  let info: IntuitUserInfo;
  try {
    tokens = await exchangeCodeForTokens(code);
    info = await fetchIntuitUserInfo(tokens.access_token);
  } catch (err) {
    console.error("intuit sign-in: token or userinfo failed:", err instanceof Error ? err.message : "Unknown error");
    return found(appUrl("/login?notice=intuit_failed"));
  }

  // Intuit's rule: no access unless Intuit has verified the address. Any
  // QuickBooks tokens from this attempt are discarded, not stored.
  if (!info.emailVerified || !info.email) {
    if (connecting) await discardGrant(realmId!, tokens.refresh_token);
    return found(appUrl("/login?notice=intuit_unverified"));
  }

  let user = await prisma.user.findUnique({ where: { intuitSub: info.sub } });
  let newUser = false;

  if (!user) {
    // Exact, ignoring case, never a wildcard match (findLoginByEmail).
    const sameEmail = await findLoginByEmail(info.email);
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
      const res = found(appUrl("/login/intuit"));
      res.cookies.set(INTUIT_PENDING_COOKIE, pending, { ...cookieBase(), maxAge: 900 });
      return res;
    }
    // New person arriving from the App Store, or from the button on our
    // signup page: account and trial, no questions. Only the signup page's
    // carries an opt-out or where they came from (as the email signup
    // does); an App Store arrival gets neither.
    try {
      user = await provisionIntuitUser(
        { sub: info.sub, email: info.email, name: displayName(info) },
        fromSignupPage ? { ...signupAdOptOut({ headers: reqHeaders }), ...signupAdSource(reqHeaders) } : {}
      );
      newUser = true;
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        return found(appUrl("/login?notice=intuit_failed"));
      }
      throw err;
    }
  }

  await createSession(user.id);
  // Opt-outs go both ways, as on the login form: this browser's onto the
  // account before anything below can be reported (connecting the company
  // reports qbo_connected), and the account's onto this browser.
  await noteBrowserOptOut(user.id, reqHeaders).catch(() => {});
  await carryAdOptOutToBrowser(user);
  const account = await accountFor(user.id);

  // The signup, before the company is attached so the steps arrive in
  // order. Only from our signup page: an App Store arrival is never
  // reported, as the Privacy Policy promises (and has no browser ID saved).
  const measuredSignup = newUser && fromSignupPage;
  if (measuredSignup) {
    await reportServerEvent(user.id, "sign_up", { method: "intuit" }, { sessionId: signupSessionId(reqHeaders) });
  }
  // A new account hasn't agreed to the Terms yet (no form to tick on this
  // path), so it goes by /accept-terms on its way to where it was headed,
  // keeping that address (the dashboard would otherwise send it there and
  // lose ?qbo_connected=1). Where they came from is on the account now, so
  // the browser's jpai_src goes, as after an email signup.
  const redirectTo = (path: string) => {
    const res = found(appUrl(newUser ? `/accept-terms?next=${encodeURIComponent(path)}` : path));
    if (measuredSignup) res.cookies.set(SOURCE_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  };

  if (!connecting) {
    const res = redirectTo("/dashboard");
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

  // A client's view-only login can't add a company to the firm's account
  // (the firm would be billed for it).
  if (account.role === "client") {
    await discardGrant(realmId!, tokens.refresh_token);
    return redirectTo("/dashboard?qbo_error=view_only");
  }
  // The role goes along so a Firm team member can't add a billed company
  // this way either, same as through Settings (see attachCompany).
  const result = await attachCompany({ ownerId: account.ownerId, realmId: realmId!, tokens, actorRole: account.role });
  if (!result.ok) {
    const target =
      result.code === "already_connected" || result.code === "verify_failed"
        ? `/dashboard?qbo_error=${result.code}`
        : result.code === "owner_only"
          ? `/dashboard/settings?notice=${OWNER_ONLY_CONNECT_NOTICE}`
          : `/dashboard/billing?limit=${result.code}`;
    return redirectTo(target);
  }
  const res = redirectTo("/dashboard?qbo_connected=1");
  res.cookies.set(ACTIVE_COMPANY_COOKIE, result.connectionId, { ...cookieBase(), maxAge: 60 * 60 * 24 * 365 });
  return res;
}
