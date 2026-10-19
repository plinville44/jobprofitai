import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { QuickBooksConnection } from "@prisma/client";
import { prisma } from "./prisma";
import { getSession } from "./auth";
import { getEntitlements } from "./entitlements";
import { REMOVED_ROLE } from "./teamRemoval";

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
 *
 * A "client" is a view-only login a bookkeeping firm (the owner, on the
 * Firm plan) gives a contractor it keeps books for. It is scoped to ONE
 * company, `connectionId`, and can change nothing: every company lookup
 * below applies that scope, and every route that changes anything refuses a
 * client (refuseClient). A client never sees the firm's other clients.
 */
export interface AccountContext {
  /** The signed-in person. */
  userId: string;
  /** The account being worked in: the signed-in person, or the owner who invited them. */
  ownerId: string;
  role: "owner" | "member" | "client";
  /** Client logins only: the one company they may see. Null for owners and members. */
  connectionId: string | null;
}

export async function getAccount(): Promise<AccountContext | null> {
  const session = await getSession();
  if (!session) return null;
  return accountFor(session.userId);
}

export async function accountFor(userId: string): Promise<AccountContext> {
  const membership = await prisma.teamMember.findUnique({
    where: { memberUserId: userId },
    select: { ownerUserId: true, acceptedAt: true, role: true, connectionId: true },
  });
  // A removed login's marker row (REMOVED_ROLE, never accepted) grants nothing.
  if (membership?.acceptedAt && membership.role !== REMOVED_ROLE && membership.ownerUserId !== userId) {
    if (membership.role === "client") {
      // A client login with no company (its company row was removed), or on
      // an account no longer on a plan with client logins, sees nothing at
      // all: an empty-string scope matches no connection.
      const allowed = (await getEntitlements(membership.ownerUserId)).has("client_logins");
      return {
        userId,
        ownerId: membership.ownerUserId,
        role: "client",
        connectionId: allowed ? membership.connectionId ?? "" : "",
      };
    }
    // A plan covers so many team logins. Past that (a trial that invited ten
    // people, then chose a plan with three) the logins who joined last are
    // paused: they get an empty account of their own, like a removed login,
    // and the dashboard says why (pausedTeamLoginFor).
    if (!(await pausedTeamLogins(membership.ownerUserId)).paused.has(userId)) {
      return { userId, ownerId: membership.ownerUserId, role: "member", connectionId: null };
    }
  }
  return { userId, ownerId: userId, role: "owner", connectionId: null };
}

export interface TeamLoginForLimit {
  memberUserId: string | null;
  acceptedAt: Date | null;
  id: string;
}

/**
 * The team logins past a plan's limit: the plan covers the ones accepted
 * first, the same rule as companies (planLimits.ts). Pure, for tests.
 */
export function pausedTeamLoginIds(members: TeamLoginForLimit[], maxTeamMembers: number): Set<string> {
  const sorted = members
    .filter((m) => m.memberUserId && m.acceptedAt)
    .sort((a, b) => a.acceptedAt!.getTime() - b.acceptedAt!.getTime() || a.id.localeCompare(b.id));
  return new Set(sorted.slice(Math.max(0, maxTeamMembers)).map((m) => m.memberUserId!));
}

/** An account's paused team logins (by login id), and how many its plan covers. Client logins aside. */
async function pausedTeamLogins(ownerId: string): Promise<{ paused: Set<string>; maxTeamMembers: number }> {
  const [entitlements, members] = await Promise.all([
    getEntitlements(ownerId),
    prisma.teamMember.findMany({
      where: { ownerUserId: ownerId, acceptedAt: { not: null }, role: { notIn: ["client", REMOVED_ROLE] } },
      select: { id: true, memberUserId: true, acceptedAt: true },
    }),
  ]);
  const maxTeamMembers = entitlements.limits.maxTeamMembers;
  return { paused: pausedTeamLoginIds(members, maxTeamMembers), maxTeamMembers };
}

/**
 * For a team login paused because the account's plan has fewer logins than
 * its team: whose account it is and how many logins the plan covers, so the
 * dashboard can say so plainly. Null otherwise.
 */
export async function pausedTeamLoginFor(
  userId: string
): Promise<{ ownerName: string | null; ownerEmail: string | null; maxTeamMembers: number } | null> {
  const membership = await prisma.teamMember.findUnique({
    where: { memberUserId: userId },
    select: { ownerUserId: true, acceptedAt: true, role: true },
  });
  if (!membership?.acceptedAt || membership.role === "client" || membership.role === REMOVED_ROLE) return null;
  if (membership.ownerUserId === userId) return null;
  const { paused, maxTeamMembers } = await pausedTeamLogins(membership.ownerUserId);
  if (!paused.has(userId)) return null;
  const owner = await prisma.user.findUnique({ where: { id: membership.ownerUserId }, select: { name: true, email: true } });
  return { ownerName: owner?.name ?? null, ownerEmail: owner?.email ?? null, maxTeamMembers };
}

/**
 * The response every route that changes something returns to a client
 * login, or null for owners and members. Call it right after getAccount().
 */
export function refuseClient(account: AccountContext): NextResponse | null {
  if (account.role !== "client") return null;
  return NextResponse.json(
    { error: "This is a view-only login. Ask your bookkeeper to make changes." },
    { status: 403 }
  );
}

/** Whether this login may see a given company. */
export function canSeeConnection(account: AccountContext, connection: { id: string; userId: string }): boolean {
  if (connection.userId !== account.ownerId) return false;
  return account.connectionId == null || account.connectionId === connection.id;
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

/** Every connected (not disconnected) company this login may see, oldest first. */
export async function listCompanies(account: AccountContext): Promise<QuickBooksConnection[]> {
  return prisma.quickBooksConnection.findMany({
    where: {
      userId: account.ownerId,
      disconnectedAt: null,
      ...(account.connectionId != null ? { id: account.connectionId } : {}),
    },
    orderBy: { connectedAt: "asc" },
  });
}

/**
 * The company the dashboard shows: the one chosen in the switcher if this
 * login may still see it, otherwise the most recently connected.
 */
export async function getActiveConnection(account: AccountContext): Promise<{
  connection: QuickBooksConnection | null;
  companies: QuickBooksConnection[];
}> {
  const companies = await listCompanies(account);
  if (companies.length === 0) return { connection: null, companies };
  const cookieStore = await cookies();
  const chosen = cookieStore.get(ACTIVE_COMPANY_COOKIE)?.value;
  const connection = companies.find((c) => c.id === chosen) ?? companies[companies.length - 1];
  return { connection, companies };
}

/**
 * A connection by id, only if this login may see it. The single check
 * every API route uses before touching a company's data.
 */
export async function connectionForAccount(
  account: AccountContext,
  connectionId: unknown,
  opts: { includeDisconnected?: boolean } = {}
): Promise<QuickBooksConnection | null> {
  if (typeof connectionId !== "string" || connectionId.length === 0) return null;
  const connection = await prisma.quickBooksConnection.findUnique({ where: { id: connectionId } });
  if (!connection || !canSeeConnection(account, connection)) return null;
  if (connection.disconnectedAt && !opts.includeDisconnected) return null;
  return connection;
}
