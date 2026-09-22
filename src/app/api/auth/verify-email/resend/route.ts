import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  createEmailVerification,
  MAX_VERIFICATIONS_PER_HOUR,
  VERIFY_TOKEN_TTL_HOURS,
} from "@/lib/emailVerification";
import { sendEmailVerification } from "@/lib/email/lifecycle";

export const runtime = "nodejs";

/**
 * POST /api/auth/verify-email/resend
 *
 * Signed-in only, and only ever to the account's own address: there is no
 * "send to this address" parameter, so this cannot be used to make us email
 * anyone else.
 */
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  try {
    const created = await createEmailVerification(session.userId);

    if (!created.ok) {
      if (created.reason === "already_verified") {
        return NextResponse.json({ ok: true, alreadyVerified: true });
      }
      if (created.reason === "rate_limited") {
        return NextResponse.json(
          {
            error: `That's ${MAX_VERIFICATIONS_PER_HOUR} links in the last hour. Use the most recent one, or try again later.`,
          },
          { status: 429 }
        );
      }
      return NextResponse.json({ error: "Account not found." }, { status: 404 });
    }

    const sent = await sendEmailVerification({
      ...created.verification,
      expiryHours: VERIFY_TOKEN_TTL_HOURS,
    });
    if (!sent.ok && !sent.skipped) {
      console.error(`verify-email resend failed for user ${session.userId}: ${sent.error}`);
      return NextResponse.json(
        { error: "We couldn't send the email just now. Try again in a few minutes." },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true, email: created.verification.email });
  } catch (err) {
    console.error("verify-email resend failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json({ error: "Something went wrong. Try again in a minute." }, { status: 500 });
  }
}
