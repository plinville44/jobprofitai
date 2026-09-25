import { NextResponse } from "next/server";
import { refuseCrossSite } from "@/lib/sameOrigin";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/auth";
import { clearPendingIntuitIdentity, provisionIntuitUser, readPendingIntuitIdentity } from "@/lib/intuitSignIn";
import { sendTrialWelcome } from "@/lib/email/lifecycle";

export const runtime = "nodejs";

/**
 * POST /api/auth/intuit/create
 *
 * Creates a JobProfitAI account (with its free trial) for the Intuit
 * identity waiting in the pending cookie. Only when no login already uses
 * that email address; an existing one has to be linked with its password.
 */
export async function POST(req: Request) {
  // No body is sent, so only the origin is checked.
  const refused = refuseCrossSite(req, { requireJson: false });
  if (refused) return refused;
  const pending = await readPendingIntuitIdentity();
  if (!pending || !pending.email) {
    return NextResponse.json({ error: "That took too long. Choose Sign in with Intuit again." }, { status: 410 });
  }
  const existing = await prisma.user.findFirst({
    where: { email: { equals: pending.email, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: `There's already a JobProfitAI login for ${pending.email}. Enter its password to link it instead.` },
      { status: 409 }
    );
  }

  let userId: string;
  try {
    const user = await provisionIntuitUser({ sub: pending.sub, email: pending.email, name: pending.name });
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
  return NextResponse.json({ ok: true });
}
