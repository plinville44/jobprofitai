import { NextResponse } from "next/server";
import { refuseCrossSite } from "@/lib/sameOrigin";
import { createSession } from "@/lib/auth";
import { clearPendingIntuitIdentity, provisionIntuitUser, readPendingIntuitIdentity } from "@/lib/intuitSignIn";
import { sendTrialWelcome } from "@/lib/email/lifecycle";
import { acceptanceData } from "@/lib/termsAcceptance";
import { signupAdOptOut } from "@/lib/adOptOut";
import { SOURCE_COOKIE } from "@/lib/adSource";
import { reportServerEvent, signupAdSource, signupSessionId } from "@/lib/serverEvents";
import { findLoginByEmail } from "@/lib/loginThrottle";

export const runtime = "nodejs";

/**
 * POST /api/auth/intuit/create
 *
 * Creates a JobProfitAI account (with its free trial) for the Intuit
 * identity waiting in the pending cookie. Only when no login already uses
 * that email address; an existing one has to be linked with its password.
 * Body: { acceptTerms: true }, from the unchecked agreement box.
 */
export async function POST(req: Request) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  const body = (await req.json().catch(() => ({}))) as { acceptTerms?: unknown };
  if (body.acceptTerms !== true) {
    return NextResponse.json(
      { error: "Please check the box to agree to the Terms of Service and Privacy Policy." },
      { status: 400 }
    );
  }
  const pending = await readPendingIntuitIdentity();
  if (!pending || !pending.email) {
    return NextResponse.json({ error: "That took too long. Choose Sign in with Intuit again." }, { status: 410 });
  }
  // Exact, ignoring case, never a wildcard match (findLoginByEmail).
  const existing = await findLoginByEmail(pending.email);
  if (existing) {
    return NextResponse.json(
      { error: `There's already a JobProfitAI login for ${pending.email}. Enter its password to link it instead.` },
      { status: 409 }
    );
  }

  let userId: string;
  try {
    const user = await provisionIntuitUser(
      { sub: pending.sub, email: pending.email, name: pending.name },
      {
        termsAcceptances: { create: acceptanceData("intuit_signup", req.headers) },
        ...signupAdOptOut(req),
        ...signupAdSource(req.headers),
      }
    );
    userId = user.id;
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      return NextResponse.json({ error: "That Intuit account or email is already in use. Log in instead." }, { status: 409 });
    }
    throw err;
  }
  await clearPendingIntuitIdentity();
  await createSession(userId);
  // The address is already verified, so the welcome goes now (password
  // signups get it after they verify; see src/app/verify-email/page.tsx).
  await sendTrialWelcome(userId).catch(() => {});
  await reportServerEvent(userId, "sign_up", { method: "intuit" }, { sessionId: signupSessionId(req.headers) });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SOURCE_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
