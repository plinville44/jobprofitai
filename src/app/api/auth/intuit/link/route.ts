import { NextRequest, NextResponse } from "next/server";
import { sendEmail } from "@/lib/email/client";
import { intuitLinkedEmail } from "@/lib/email/templates";
import { refuseCrossSite } from "@/lib/sameOrigin";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { createSession, verifyPassword } from "@/lib/auth";
import { clientIp, findLoginByEmail, finishLoginAttempt, startLoginAttempt, WINDOW_MINUTES } from "@/lib/loginThrottle";
import { carryAdOptOutToBrowser, noteBrowserOptOut } from "@/lib/adOptOut";
import { clearPendingIntuitIdentity, readPendingIntuitIdentity } from "@/lib/intuitSignIn";

export const runtime = "nodejs";

const LinkSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

/**
 * POST /api/auth/intuit/link { email, password }
 *
 * Links the Intuit identity waiting in the pending cookie to an existing
 * JobProfitAI login, after that login's password is entered. Intuit
 * requires this: an Intuit identity may only be attached to an account the
 * person has just proven is theirs. Same lockout as the login form.
 */
export async function POST(req: NextRequest) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  const pending = await readPendingIntuitIdentity();
  if (!pending) {
    return NextResponse.json({ error: "That took too long. Choose Sign in with Intuit again." }, { status: 410 });
  }
  const parsed = LinkSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Enter your email and password." }, { status: 400 });

  const email = parsed.data.email.trim();
  const ip = clientIp(req.headers);
  // Written as a failed attempt before the password is checked, so
  // requests sent at once can't make more guesses than the limit.
  const attempt = await startLoginAttempt(email, ip);
  if (attempt.locked) {
    return NextResponse.json(
      { error: `Too many sign-in attempts. Wait ${WINDOW_MINUTES} minutes and try again, or reset your password.` },
      { status: 429 }
    );
  }
  // Exactly the address typed, ignoring case (findLoginByEmail), never a wildcard match.
  const user = await findLoginByEmail(email);
  const valid = user ? await verifyPassword(parsed.data.password, user.passwordHash) : false;
  await finishLoginAttempt(attempt.attemptId, valid);
  if (!user || !valid) return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 });

  if (user.intuitSub && user.intuitSub !== pending.sub) {
    return NextResponse.json(
      { error: "This JobProfitAI login is already linked to a different Intuit account. Sign in with that one, or with your password." },
      { status: 409 }
    );
  }
  try {
    await prisma.user.update({ where: { id: user.id }, data: { intuitSub: pending.sub } });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      return NextResponse.json({ error: "That Intuit account is already linked to another JobProfitAI login." }, { status: 409 });
    }
    throw err;
  }
  await clearPendingIntuitIdentity();
  await createSession(user.id);
  // Opt-outs go both ways, as on the login form: this browser's onto the
  // account before anything can be reported (connecting QuickBooks comes
  // next), and the account's onto this browser.
  await noteBrowserOptOut(user.id, req.headers).catch(() => {});
  await carryAdOptOutToBrowser(user);
  // Tell the owner, so a link they didn't make doesn't go unnoticed.
  await sendEmail({ to: user.email, ...intuitLinkedEmail() }).catch(() => {});
  return NextResponse.json({ ok: true, connect: pending.connect });
}
