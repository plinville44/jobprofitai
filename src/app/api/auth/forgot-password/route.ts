import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createPasswordReset, RESET_TOKEN_TTL_MINUTES } from "@/lib/passwordReset";
import { sendPasswordReset } from "@/lib/email/lifecycle";

export const runtime = "nodejs";

const ForgotSchema = z.object({
  email: z.string().email().max(320),
});

/**
 * POST /api/auth/forgot-password  { email }
 *
 * Always responds 200 with the same body, whatever happens.
 *
 * That is the whole design. An endpoint that says "no account with that
 * email" is an account-existence oracle: anyone can feed it a list of
 * addresses and learn which of them are JobProfitAI customers. For a product
 * whose customers are identifiable contractors, that is a genuine privacy
 * leak, and it is also the reconnaissance step before a credential-stuffing
 * run. So an unknown address, a rate-limited address and a successful send
 * are indistinguishable from outside.
 *
 * A malformed address is the one exception: that is a client bug, not a
 * probe, and returning 400 lets the form say "check the address" rather than
 * claiming to have sent mail to something that isn't an email address.
 */
export async function POST(req: NextRequest) {
  // Identical for every outcome. Built once so no future edit can
  // accidentally make one branch's wording differ from another's.
  const uniformResponse = NextResponse.json({
    ok: true,
    message:
      "If an account exists for that email address, a reset link is on its way. Check your inbox, and your spam folder.",
  });

  try {
    const body = await req.json().catch(() => ({}));
    const parsed = ForgotSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }

    const reset = await createPasswordReset(parsed.data.email);

    // Null means no such account, or too many recent requests. Both end here,
    // silently and successfully, from the caller's point of view.
    if (!reset) return uniformResponse;

    const sent = await sendPasswordReset({
      userId: reset.userId,
      email: reset.email,
      token: reset.token,
      expiresAt: reset.expiresAt,
      expiryMinutes: RESET_TOKEN_TTL_MINUTES,
    });

    if (!sent.ok && !sent.skipped) {
      // Logged, not surfaced. Telling the caller the send failed would leak
      // that the account exists just as loudly as a "no such user" would.
      console.error(`password reset email failed for user ${reset.userId}: ${sent.error}`);
    }

    return uniformResponse;
  } catch (err) {
    // Even an unexpected failure returns the uniform response. A 500 here
    // would be observably different for a real account versus an unknown
    // one, which is exactly the signal this endpoint exists to hide.
    console.error(
      "forgot-password failed:",
      err instanceof Error ? err.message : "Unknown error"
    );
    return uniformResponse;
  }
}
