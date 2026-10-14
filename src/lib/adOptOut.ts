import { prisma } from "@/lib/prisma";
import { OPT_OUT_COOKIE, OPT_OUT_MAX_AGE_SECONDS, optedOutByCookie } from "@/lib/tracking";

/**
 * Opt-outs of the sale or sharing of personal information and targeted
 * advertising, saved on the account so they reach the server as well as the
 * browser. A browser opt-out only stops the tags in that browser; once we
 * know who the person is, the choice also has to stop anything we send
 * Google from the server about their account (California's
 * regulations apply a Global Privacy Control signal to the consumer when
 * they're known). The Privacy Policy, section 8, describes exactly this.
 *
 * Sources: "gpc" (the browser's Sec-GPC header while signed in or at
 * signup), "privacy_page" (the switch on Your Privacy Choices while signed
 * in, or its cookie at signup), "email" (a request by email, set by us).
 */
export type AdOptOutSource = "gpc" | "privacy_page" | "email";

/** The opt-out a request carries: the Sec-GPC header, or the Your Privacy Choices cookie. */
export function requestAdOptOut(headers: Headers): AdOptOutSource | null {
  if (headers.get("sec-gpc")?.trim() === "1") return "gpc";
  if (optedOutByCookie(headers.get("cookie") ?? "")) return "privacy_page";
  return null;
}

/** Fields for a new account, carrying over an opt-out made before signing up. */
export function signupAdOptOut(req: { headers: Headers }): { adOptOutAt?: Date; adOptOutSource?: AdOptOutSource } {
  const source = requestAdOptOut(req.headers);
  return source ? { adOptOutAt: new Date(), adOptOutSource: source } : {};
}

/** Saves an opt-out on the account, keeping the first one. */
export async function recordAdOptOut(userId: string, source: AdOptOutSource): Promise<void> {
  await prisma.user.updateMany({
    where: { id: userId, adOptOutAt: null },
    data: { adOptOutAt: new Date(), adOptOutSource: source },
  });
}

/**
 * Turning the tags back on from Your Privacy Choices undoes only an opt-out
 * made there. One that came from Global Privacy Control or an email request
 * stays until the person asks us.
 */
export async function clearPrivacyPageOptOut(userId: string): Promise<void> {
  await prisma.user.updateMany({
    where: { id: userId, adOptOutSource: "privacy_page" },
    data: { adOptOutAt: null, adOptOutSource: null },
  });
}

/**
 * Called when someone signs in and on signed-in page loads: a browser that
 * sends Global Privacy Control, or carries the Your Privacy Choices opt-out
 * cookie (set while signed out, say), opts the account out, so nothing is
 * reported about it from the server from then on.
 */
export async function noteBrowserOptOut(userId: string, headers: Headers): Promise<void> {
  const source = requestAdOptOut(headers);
  if (source) await recordAdOptOut(userId, source);
}

/**
 * On sign-in, a browser of someone who has opted out on their account gets
 * the Your Privacy Choices cookie too, so the tags stay off on our public
 * pages in that browser as well ("applies wherever you sign in", Privacy
 * Policy section 8). Called from route handlers, right after createSession.
 */
export async function carryAdOptOutToBrowser(user: { adOptOutAt: Date | null }): Promise<void> {
  if (!user.adOptOutAt) return;
  const { cookies } = await import("next/headers");
  (await cookies()).set(OPT_OUT_COOKIE, "1", {
    path: "/",
    maxAge: OPT_OUT_MAX_AGE_SECONDS,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}
