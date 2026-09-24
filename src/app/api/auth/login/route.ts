import { NextRequest, NextResponse } from "next/server";
import { refuseCrossSite } from "@/lib/sameOrigin";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyPassword, createSession } from "@/lib/auth";
import { clientIp, isLockedOut, recordLoginAttempt, WINDOW_MINUTES } from "@/lib/loginThrottle";

export const runtime = "nodejs";

const LoginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  const body = await req.json().catch(() => ({}));
  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input." }, { status: 400 });
  }
  const { password } = parsed.data;
  const email = parsed.data.email.trim();
  const ip = clientIp(req.headers);

  // Checked before the password, and answered the same way whether or not
  // the address has an account, so the lockout can't be used to find out.
  if (await isLockedOut(email, ip)) {
    return NextResponse.json(
      {
        error: `Too many sign-in attempts. Wait ${WINDOW_MINUTES} minutes and try again, or reset your password.`,
      },
      { status: 429 }
    );
  }

  // Deliberately identical error for "no such user" and "wrong password" -
  // don't leak which one it was.
  const genericError = NextResponse.json(
    { error: "Incorrect email or password." },
    { status: 401 }
  );

  // Exact match first (fast, indexed), then case-insensitive for accounts
  // created before signup started normalizing email casing.
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
    });
  }

  if (!user) {
    await recordLoginAttempt(email, ip, false);
    return genericError;
  }

  const valid = await verifyPassword(password, user.passwordHash);
  await recordLoginAttempt(email, ip, valid);
  if (!valid) return genericError;

  await createSession(user.id);
  return NextResponse.json({ id: user.id, email: user.email });
}
