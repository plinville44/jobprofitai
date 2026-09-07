import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyPassword, createSession } from "@/lib/auth";

export const runtime = "nodejs";

const LoginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input." }, { status: 400 });
  }
  const { password } = parsed.data;
  const email = parsed.data.email.trim();

  // Deliberately identical error for "no such user" and "wrong password" -
  // don't leak which one it was.
  const genericError = NextResponse.json(
    { error: "Incorrect email or password." },
    { status: 401 }
  );

  // Exact match first (fast, indexed). Falling back to a case-insensitive
  // lookup lets accounts created before signup started normalizing email
  // casing still log in with any capitalization - without rewriting anyone's
  // stored address, which would risk locking out a live customer.
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
    });
  }

  if (!user) return genericError;

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return genericError;

  await createSession(user.id);
  return NextResponse.json({ id: user.id, email: user.email });
}
