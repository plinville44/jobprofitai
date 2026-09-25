import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAccount } from "@/lib/account";
import { extendTrialWithFeedback, getTrialState } from "@/lib/trial";
import { sendTrialExtended } from "@/lib/email/lifecycle";

/**
 * POST /api/trial/feedback
 *
 * The 5-minute survey that earns exactly one +14 day trial extension.
 *
 * Nothing about eligibility is trusted from the client: the route re-derives
 * it from server-side state, and the database's unique constraint on
 * TrialFeedback.userId is the final backstop, so even a scripted flood of
 * concurrent submissions can only ever produce one extension.
 *
 * Note what this endpoint does NOT ask for: a testimonial, a review, or
 * permission to quote anyone. Those are a separate, later, entirely optional
 * request - trading trial time for public praise would make any testimonial
 * we collected worthless anyway.
 */
export const runtime = "nodejs";

const FeedbackSchema = z.object({
  mostValuable: z.string().trim().min(1, "Please answer this question.").max(2000),
  confusing: z.string().trim().min(1, "Please answer this question.").max(2000),
  wishItShowed: z.string().trim().min(1, "Please answer this question.").max(2000),
  worthPayingFor: z.string().trim().min(1, "Please answer this question.").max(2000),
  anythingElse: z.string().trim().max(2000).optional(),
});

export async function GET() {
  // Lets the survey page render the right state (eligible / already used /
  // too early) from the server rather than guessing in the browser.
  const account = await getAccount();
  if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const state = await getTrialState(account.ownerId);
  return NextResponse.json({
    eligible: state.extensionOffered,
    reason: state.extensionBlockedReason,
    alreadyClaimed: state.extensionClaimed,
    daysRemaining: state.daysRemaining,
    wouldEndAt: state.extensionWouldEndAt,
  });
}

export async function POST(req: NextRequest) {
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    // The trial belongs to the account owner, so only they can extend it.
    if (account.role !== "owner") {
      return NextResponse.json({ error: "Only the account owner can extend the trial." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const parsed = FeedbackSchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return NextResponse.json(
        { error: first?.message ?? "Please complete every question." },
        { status: 400 }
      );
    }

    const result = await extendTrialWithFeedback(account.ownerId, parsed.data);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    // Confirmation email is best-effort: the extension is already committed
    // and must not be rolled back because an email provider had a bad minute.
    try {
      await sendTrialExtended(account.ownerId, result.newTrialEndsAt);
    } catch (emailErr) {
      console.error(
        "trial/feedback: extension email failed (extension still applied):",
        emailErr instanceof Error ? emailErr.message : "Unknown error"
      );
    }

    return NextResponse.json({
      ok: true,
      newTrialEndsAt: result.newTrialEndsAt,
      daysGranted: result.daysGranted,
    });
  } catch (err) {
    console.error(
      "trial/feedback failed:",
      err instanceof Error ? err.message : "Unknown error"
    );
    return NextResponse.json(
      { error: "We couldn't save your feedback. Please try again." },
      { status: 500 }
    );
  }
}
