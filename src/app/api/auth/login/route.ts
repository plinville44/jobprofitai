import { NextRequest, NextResponse } from "next/server";
import { refuseCrossSite } from "@/lib/sameOrigin";
import { z } from "zod";
import { verifyPassword, createSession } from "@/lib/auth";
import { carryAdOptOutToBrowser, noteBrowserOptOut } from "@/lib/adOptOut";
import { clientIp, findLoginByEmail, finishLoginAttempt, startLoginAttempt, WINDOW_MINUTES } from "@/lib/loginThrottle";

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
  // The attempt is written as a failure before the check (loginThrottle.ts),
  // so requests sent at once can't make more guesses than the limit.
  const attempt = await startLoginAttempt(email, ip);
  if (attempt.locked) {
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

  // Only the login whose address is exactly the one typed, ignoring case
  // (findLoginByEmail): a wildcard match would be checked against another
  // address's attempts, past the limit.
  const user = await findLoginByEmail(email);

  // Already counted as a failed attempt; nothing more to record.
  if (!user) return genericError;

  const valid = await verifyPassword(password, user.passwordHash);
  await finishLoginAttempt(attempt.attemptId, valid);
  if (!valid) return genericError;

  await createSession(user.id);
  // Opt-outs go both ways: this browser's onto the account, the account's onto this browser.
  await noteBrowserOptOut(user.id, req.headers).catch(() => {});
  await carryAdOptOutToBrowser(user);
  return NextResponse.json({ id: user.id, email: user.email });
}
