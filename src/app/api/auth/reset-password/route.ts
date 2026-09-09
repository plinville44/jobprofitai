import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { completePasswordReset, inspectPasswordReset } from "@/lib/passwordReset";
import { sendPasswordChanged } from "@/lib/email/lifecycle";
import { clearSession } from "@/lib/auth";

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
 * On success the current browser's session cookie is cleared and the
 * customer logs in with the new password. Making them type it once
 * immediately is a deliberate small friction: it confirms the password
 * manager saved what they think it saved, at the one moment they still
 * remember what they typed.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const parsed = ResetSchema.safeParse(body);
    if (!parsed.success) {
      const tooShort = parsed.error.issues.some(
        (i) => i.path[0] === "password" && i.code === "too_small"
      );
      return NextResponse.json(
        {
          error: tooShort
            ? "Choose a password of at least 8 characters."
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

    await clearSession();

    return NextResponse.json({ ok: true });
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
