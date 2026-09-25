import { cookies } from "next/headers";
import type { QuickBooksConnection } from "@prisma/client";
import { prisma } from "./prisma";
import { getSession } from "./auth";

/**
 * Who is signed in, and whose account they are working in.
 *
 * An account belongs to its owner. The owner can invite team members (see
 * TeamMember in the schema); a member signs in with their own login and
 * works in the owner's account, under the owner's plan, on the owner's
 * QuickBooks companies. Every data query and ownership check uses
 * `ownerId`; things that are personal (the partner program, referral codes,
 * the member's own password) use `userId`. Billing, team management and
 * deleting the account are owner-only (`role === "owner"`).
 */
export interface AccountContext {
  /** The signed-in person. */
  userId: string;
  /** The account being worked in: the signed-in person, or the owner who invited them. */
  ownerId: string;
  role: "owner" | "member";
}

export async function getAccount(): Promise<AccountContext | null> {
  const session = await getSession();
  if (!session) return null;
  return accountFor(session.userId);
}

export async function accountFor(userId: string): Promise<AccountContext> {
  const membership = await prisma.teamMember.findUnique({
    where: { memberUserId: userId },
    select: { ownerUserId: true, acceptedAt: true },
  });
  if (membership?.acceptedAt && membership.ownerUserId !== userId) {
    return { userId, ownerId: membership.ownerUserId, role: "member" };
  }
  return { userId, ownerId: userId, role: "owner" };
}

// ---------------------------------------------------------------------------
// Which QuickBooks company is on screen
// ---------------------------------------------------------------------------

/**
 * The company picked in the dashboard's company switcher. A plain
 * preference cookie (the connection id), not an authorization: every read
 * still checks the connection belongs to the account.
 */
export const ACTIVE_COMPANY_COOKIE = "jpai_company";

/** Every connected (not disconnected) company on the account, oldest first. */
export async function listCompanies(ownerId: string): Promise<QuickBooksConnection[]> {
  return prisma.quickBooksConnection.findMany({
    where: { userId: ownerId, disconnectedAt: null },
    orderBy: { connectedAt: "asc" },
  });
}

/**
 * The company the dashboard shows: the one chosen in the switcher if it
 * still belongs to the account, otherwise the most recently connected.
 */
export async function getActiveConnection(ownerId: string): Promise<{
  connection: QuickBooksConnection | null;
  companies: QuickBooksConnection[];
}> {
  const companies = await listCompanies(ownerId);
  if (companies.length === 0) return { connection: null, companies };
  const cookieStore = await cookies();
  const chosen = cookieStore.get(ACTIVE_COMPANY_COOKIE)?.value;
  const connection = companies.find((c) => c.id === chosen) ?? companies[companies.length - 1];
  return { connection, companies };
}

/**
 * A connection by id, only if it belongs to the account. The single check
 * every API route uses before touching a company's data.
 */
export async function connectionForAccount(
  account: AccountContext,
  connectionId: unknown,
  opts: { includeDisconnected?: boolean } = {}
): Promise<QuickBooksConnection | null> {
  if (typeof connectionId !== "string" || connectionId.length === 0) return null;
  const connection = await prisma.quickBooksConnection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.userId !== account.ownerId) return null;
  if (connection.disconnectedAt && !opts.includeDisconnected) return null;
  return connection;
}
