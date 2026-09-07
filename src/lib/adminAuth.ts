import { prisma } from "./prisma";
import { getSession } from "./auth";
import { isAdminEmail } from "./entitlements";

/**
 * Admin authorization for both API routes and server-rendered admin pages.
 *
 * Every admin surface calls this. There is no client-side admin check
 * anywhere - an admin page that merely hid its contents in the browser would
 * still have fetched and sent every customer's data to a non-admin first.
 */
export interface AdminSession {
  userId: string;
  email: string;
}

/** Returns the admin session, or null if the caller isn't an admin. */
export async function getAdminSession(): Promise<AdminSession | null> {
  const session = await getSession();
  if (!session) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true },
  });
  if (!user || !isAdminEmail(user.email)) return null;

  return { userId: user.id, email: user.email };
}
