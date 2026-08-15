import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";

const CATEGORIES = new Set(["Feature Request", "Report", "Integration", "Bug/Problem", "Other"]);

/**
 * POST /api/feedback  { category, message, page }
 *
 * userId/userEmail/connectionId/plan are always filled in server-side from
 * the session - never trusted from the client, so feedback can't be spoofed
 * as coming from someone else. The DB write happens first and always
 * succeeds even if the notification email fails (per spec: "do not rely on
 * email alone") - a missing RESEND_API_KEY or an unverified sending domain
 * should never cause a user's feedback to be lost.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const body = await req.json();
    const category = typeof body.category === "string" ? body.category : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const page = typeof body.page === "string" && body.page.trim() ? body.page.trim() : "unknown";

    if (!CATEGORIES.has(category)) {
      return NextResponse.json({ error: "Choose a valid feedback category." }, { status: 400 });
    }
    if (!message) {
      return NextResponse.json({ error: "Feedback message can't be empty." }, { status: 400 });
    }
    if (message.length > 5000) {
      return NextResponse.json({ error: "Feedback message is too long (5000 characters max)." }, { status: 400 });
    }

    const [user, connection, entitlements] = await Promise.all([
      prisma.user.findUnique({ where: { id: session.userId } }),
      prisma.quickBooksConnection.findFirst({
        where: { userId: session.userId, disconnectedAt: null },
        orderBy: { connectedAt: "desc" },
      }),
      getEntitlements(session.userId),
    ]);
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const feedback = await prisma.feedback.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        connectionId: connection?.id ?? null,
        plan: entitlements.plan,
        category,
        message,
        page,
      },
    });

    // Best-effort notification - logged, never allowed to fail the request.
    // Skips cleanly (no throw, no crash) when RESEND_API_KEY isn't set yet,
    // same as the weekly-email send path will need to (Phase 7).
    if (process.env.RESEND_API_KEY) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: process.env.FEEDBACK_FROM_EMAIL ?? "JobProfitAI Feedback <feedback@jobprofitai.com>",
          to: process.env.FEEDBACK_TO_EMAIL ?? "plinvill@gmail.com",
          subject: `[Feedback] ${category} from ${user.email}`,
          text: `Category: ${category}\nPlan: ${entitlements.plan}\nPage: ${page}\nUser: ${user.email}\n\n${message}`,
        });
      } catch (emailErr) {
        console.error(
          "feedback notification email failed (feedback row was still saved):",
          emailErr instanceof Error ? emailErr.message : "Unknown error"
        );
      }
    }

    return NextResponse.json({ ok: true, id: feedback.id });
  } catch (err) {
    console.error("feedback failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't submit feedback." },
      { status: 500 }
    );
  }
}
