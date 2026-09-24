import { NextRequest, NextResponse } from "next/server";
import { refuseCrossSite } from "@/lib/sameOrigin";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { createSession, getSession, hashPassword } from "@/lib/auth";
import { acceptInvite, findUsableInvite } from "@/lib/team";

export const runtime = "nodejs";

const NewLoginSchema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().trim().max(120).optional(),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

/**
 * POST /api/team/accept { token }                       signed in
 * POST /api/team/accept { token, name, password }       new login
 *
 * Signed in: joins the signed-in login to the team, if it has the invited
 * address. Not signed in: creates a login for the invited address (the
 * invitation link proves the mailbox) and joins it. If a login already
 * exists for that address, the person has to sign in first; the invitation
 * link alone is never enough to get into an existing login.
 */
export async function POST(req: NextRequest) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  const body = await req.json().catch(() => ({}));
  const session = await getSession();

  if (session) {
    const result = await acceptInvite(body?.token, session.userId);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true });
  }

  const parsed = NewLoginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  }
  const invite = await findUsableInvite(parsed.data.token);
  if (!invite) {
    return NextResponse.json(
      { error: "This invitation has expired or was already used. Ask for a new one." },
      { status: 410 }
    );
  }
  const existing = await prisma.user.findFirst({
    where: { email: { equals: invite.email, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: `There's already a login for ${invite.email}. Sign in with it, then open the invitation link again.` },
      { status: 409 }
    );
  }

  let userId: string;
  try {
    // No trial of its own: a team member works under the owner's plan.
    const user = await prisma.user.create({
      data: {
        email: invite.email,
        passwordHash: await hashPassword(parsed.data.password),
        name: parsed.data.name || null,
        emailVerifiedAt: new Date(),
      },
    });
    userId = user.id;
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      return NextResponse.json({ error: "There's already a login for that address. Sign in with it." }, { status: 409 });
    }
    throw err;
  }

  const result = await acceptInvite(parsed.data.token, userId);
  if (!result.ok) {
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  await createSession(userId);
  return NextResponse.json({ ok: true });
}
