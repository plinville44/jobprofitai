import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { prisma } from "./prisma";

const SESSION_COOKIE = "jmai_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function getSecret() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_SECRET is not set. Generate one with `openssl rand -base64 32` and add it to .env"
    );
  }
  return new TextEncoder().encode(secret);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/**
 * A bcrypt hash at hashPassword's cost (12) of a random value that was
 * thrown away, so no password matches it. Checked against when an address
 * has no login, so "no such account" takes as long as "wrong password".
 * Without it the login and Intuit link forms answered about 200 ms sooner
 * for an unknown address, which told anyone timing them which addresses
 * have accounts (audit Oct 27, B7). Keep its cost in step with hashPassword.
 */
const NO_LOGIN_HASH = "$2a$12$aFR.NrCxHC9sLTs8CWOpLOqRnn34IDwd0ACe6fbuKAskSULA0jBES";

/**
 * Whether `password` matches `hash`. Pass null for an address with no login:
 * the answer is false, after the same work as a real check.
 */
export async function verifyPassword(
  password: string,
  hash: string | null
): Promise<boolean> {
  if (hash == null) {
    await bcrypt.compare(password, NO_LOGIN_HASH);
    return false;
  }
  return bcrypt.compare(password, hash);
}

/**
 * Signs a session for `userId` and sets the cookie.
 *
 * The token carries the account's sessionVersion. Bumping that column
 * (password reset, "Sign out of all devices") ends every session issued
 * before it, which a stateless token cannot otherwise do.
 */
export async function createSession(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { sessionVersion: true } });
  const token = await new SignJWT({ userId, sv: user?.sessionVersion ?? 0 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecret());

  // Next.js 16: cookies(), headers() and draftMode() are async.
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

  return token;
}

/**
 * The signed-in user, or null.
 *
 * Checks the token's signature and expiry, then that the account still
 * exists and the token's session version is current. That one indexed
 * lookup per request is what lets a password reset actually sign out a
 * stolen session, and a deleted account stop working immediately.
 */
export async function getSession(): Promise<{ userId: string } | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  let userId: string;
  let sv: number;
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (typeof payload.userId !== "string") return null;
    userId = payload.userId;
    // Tokens issued before versions existed carry none; they belong to version 0.
    sv = typeof payload.sv === "number" ? payload.sv : 0;
  } catch {
    // Expired or tampered token - treat as logged out rather than throwing,
    // so a stale cookie doesn't 500 every page load.
    return null;
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { sessionVersion: true } });
  if (!user || user.sessionVersion !== sv) return null;
  return { userId };
}

export async function clearSession() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

/** Ends every session for this account, everywhere. */
export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
}
