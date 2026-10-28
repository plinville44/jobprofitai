import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { createPasswordReset, RESET_TOKEN_TTL_MINUTES } from "@/lib/passwordReset";
import { sendPasswordReset } from "@/lib/email/lifecycle";
import { findLoginByEmail } from "@/lib/loginThrottle";
import { safeErrorText, scrubText } from "@/lib/scrub";

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
 * Indistinguishable in time too. The lookup, the reset and the email all
 * run after the reply has gone (`after`; on Vercel that's waitUntil), so
 * the reply takes as long for an address with an account as for one
 * without. It used to wait for the reset and the send only for a real
 * account, which a stopwatch could tell apart (audit Oct 27, B7).
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

    const typed = parsed.data.email;
    after(() => sendResetIfAccountExists(typed));
    return uniformResponse;
  } catch (err) {
    // Even an unexpected failure returns the uniform response.
    console.error("forgot-password failed:", safeErrorText(err));
    return uniformResponse;
  }
}

/**
 * The part that depends on whether the address has an account, run after
 * the reply. Never throws: nobody is waiting for it, and an error here must
 * not surface anywhere the caller could see. Logs carry no address or token.
 */
async function sendResetIfAccountExists(typed: string): Promise<void> {
  try {
    // Only the login whose address is exactly the one typed, ignoring case
    // (findLoginByEmail). Its stored address is then what the reset looks up,
    // so a wildcard in what was typed can't pick a different account.
    const login = await findLoginByEmail(typed);
    const reset = login ? await createPasswordReset(login.email) : null;

    // Null means no such account, or too many recent requests. Both end here.
    if (!reset) return;

    const sent = await sendPasswordReset({
      userId: reset.userId,
      email: reset.email,
      token: reset.token,
      expiresAt: reset.expiresAt,
      expiryMinutes: RESET_TOKEN_TTL_MINUTES,
    });

    if (!sent.ok && !sent.skipped) {
      console.error(`password reset email failed for user ${reset.userId}: ${scrubText(sent.error)}`);
    }
  } catch (err) {
    console.error("forgot-password: the reset couldn't be made or sent:", safeErrorText(err));
  }
}
