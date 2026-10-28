import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { completePasswordReset, inspectPasswordReset } from "@/lib/passwordReset";
import { sendPasswordChanged } from "@/lib/email/lifecycle";
import { createSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { refuseCrossSite } from "@/lib/sameOrigin";
import { carryAdOptOutToBrowser, noteBrowserOptOut } from "@/lib/adOptOut";
import { clearFailedLogins } from "@/lib/loginThrottle";

export const runtime = "nodejs";

const ResetSchema = z.object({
  token: z.string().min(10).max(500),
  // Matches the signup route's rule. A reset is not the place to impose a
  // stricter policy than the one the account was created under, or a
  // customer can find themselves unable to set the password they already
  // have written down.
  password: z.string().min(8).max(200),
});

const INVALID_MESSAGE =
  "This reset link is no longer valid. Request a new one and use the most recent email.";

/**
 * GET /api/auth/reset-password?token=...
 *
 * Checks a link without consuming it, so the page can say "this link has
 * expired" before the customer types a new password rather than after.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const result = await inspectPasswordReset(token);

  if (!result.ok) {
    return NextResponse.json({ valid: false, reason: result.reason }, { status: 200 });
  }
  // Deliberately does not return the email address. The person holding this
  // link has not proven anything yet, and echoing back whose account it
  // belongs to would turn a guessed token into an information leak.
  return NextResponse.json({ valid: true });
}

/**
 * POST /api/auth/reset-password  { token, password }
 *
 * On success the customer is signed in, in this browser only: the reset
 * moved the account's session version on, so every other session has
 * ended, and the new one is issued under the new version. Signing in here
 * (rather than sending them back to the login form) is what makes the reset
 * email always a way in: someone typing wrong passwords for this address can
 * keep the login form locked (loginThrottle.ts), but can't stop the email.
 * It starts a session, so it gets the same cross-site guard as login.
 */
export async function POST(req: NextRequest) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  try {
    const body = await req.json().catch(() => ({}));
    const parsed = ResetSchema.safeParse(body);
    if (!parsed.success) {
      const passwordIssue = (code: string) =>
        parsed.error.issues.some((i) => i.path[0] === "password" && i.code === code);
      // A pasted password over the limit used to be told the link was wrong
      // (audit Oct 27, Z2).
      return NextResponse.json(
        {
          error: passwordIssue("too_small")
            ? "Choose a password of at least 8 characters."
            : passwordIssue("too_big")
              ? "Passwords can be at most 200 characters."
              : "That reset link doesn't look right. Request a new one.",
        },
        { status: 400 }
      );
    }

    const result = await completePasswordReset(parsed.data.token, parsed.data.password);

    if (!result.ok) {
      // One message for invalid, expired and already-used. The customer's
      // next action is the same in all three cases, and distinguishing them
      // tells anyone testing tokens which guesses were closest.
      return NextResponse.json({ error: INVALID_MESSAGE }, { status: 400 });
    }

    // The reset proved the mailbox is theirs, so wrong passwords typed by
    // anyone before it no longer lock the address (loginThrottle.ts).
    await clearFailedLogins(result.email);

    // Best effort, and never allowed to fail the reset: the password has
    // already changed by this point, so throwing here would tell the
    // customer it failed when it did not.
    try {
      await sendPasswordChanged({
        userId: result.userId,
        email: result.email,
        changedAt: new Date(),
      });
    } catch (err) {
      console.error(
        `password changed notification failed for user ${result.userId}:`,
        err instanceof Error ? err.message : "Unknown error"
      );
    }

    // A fresh session under the new version, the same way the login route
    // signs someone in, opt-outs included.
    await createSession(result.userId);
    await noteBrowserOptOut(result.userId, req.headers).catch(() => {});
    const user = await prisma.user.findUnique({ where: { id: result.userId }, select: { adOptOutAt: true } });
    if (user) await carryAdOptOutToBrowser(user);

    return NextResponse.json({ ok: true, signedIn: true });
  } catch (err) {
    console.error(
      "reset-password failed:",
      err instanceof Error ? err.message : "Unknown error"
    );
    return NextResponse.json(
      { error: "We couldn't reset your password. Please request a new link." },
      { status: 500 }
    );
  }
}
