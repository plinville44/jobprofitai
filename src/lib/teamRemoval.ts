import { createHash, randomBytes } from "crypto";
import { prisma } from "./prisma";

/**
 * Taking a team member's or client's access away.
 *
 * Removing a login also takes the address off every company's Weekly Profit
 * Brief and alert list, so someone who left (a project manager, or a client
 * who moved to another bookkeeper) stops getting the figures by email too.
 *
 * An accepted login's row is kept with role REMOVED_ROLE and no access at all,
 * only so that person's next sign-in can say plainly that their access was
 * removed, rather than "your subscription is inactive". A pending invitation
 * is simply deleted.
 *
 * Kept apart from src/lib/team.ts so the QuickBooks connect code can use it
 * without loading the sign-in code.
 */

/**
 * The role of a login the owner removed (or whose company was disconnected,
 * for a client). It grants nothing: accountFor treats the person as signed in
 * to no account, and the row is hidden from the team list.
 */
export const REMOVED_ROLE = "removed";

/** A recipient list without the given addresses (compared ignoring case and spaces). Pure, for tests. */
export function withoutAddresses(list: string[], addresses: Iterable<string>): string[] {
  const drop = new Set(Array.from(addresses, (a) => a.trim().toLowerCase()).filter(Boolean));
  return list.filter((r) => !drop.has(r.trim().toLowerCase()));
}

/**
 * Takes addresses off the Weekly Profit Brief list of every company on the
 * account, disconnected ones included so a reconnect doesn't bring them
 * back. Alerts go to the same list. A list left empty turns the brief off,
 * the same as the unsubscribe link does. Returns how many companies changed.
 */
export async function removeFromRecipientLists(ownerId: string, addresses: string[]): Promise<number> {
  const companies = await prisma.quickBooksConnection.findMany({
    where: { userId: ownerId },
    select: { id: true, emailRecipients: true },
  });
  let changed = 0;
  for (const c of companies) {
    const list = c.emailRecipients ?? [];
    const remaining = withoutAddresses(list, addresses);
    if (remaining.length === list.length) continue;
    await prisma.quickBooksConnection.update({
      where: { id: c.id },
      data: { emailRecipients: remaining, ...(remaining.length === 0 ? { emailEnabled: false } : {}) },
    });
    changed++;
  }
  return changed;
}

export type RemoveResult =
  | { ok: true; /** The login to sign out everywhere, when one had accepted. */ memberUserId: string | null }
  | { ok: false; error: string; status: number };

/**
 * Removes a team member or client login, or cancels an invitation, and takes
 * the address off every company's email lists. The caller signs the person
 * out (revokeAllSessions) with the returned memberUserId.
 */
export async function removeTeamLogin(ownerId: string, id: unknown, now = new Date()): Promise<RemoveResult> {
  const row = typeof id === "string" && id ? await prisma.teamMember.findUnique({ where: { id } }) : null;
  if (!row || row.ownerUserId !== ownerId || row.role === REMOVED_ROLE) {
    return { ok: false, error: "Team member not found.", status: 404 };
  }

  const addresses = [row.email];
  if (row.memberUserId) {
    const member = await prisma.user.findUnique({ where: { id: row.memberUserId }, select: { email: true } });
    if (member?.email) addresses.push(member.email);
  }

  const accepted = Boolean(row.acceptedAt && row.memberUserId);
  if (accepted) {
    // Kept as a marker with no access (see REMOVED_ROLE). A fresh random
    // token hash means no old invitation link can match it.
    await prisma.teamMember.update({
      where: { id: row.id },
      data: {
        role: REMOVED_ROLE,
        acceptedAt: null,
        connectionId: null,
        expiresAt: now,
        tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
      },
    });
  } else {
    await prisma.teamMember.delete({ where: { id: row.id } });
  }
  await removeFromRecipientLists(ownerId, addresses);
  return { ok: true, memberUserId: accepted ? row.memberUserId : null };
}

/**
 * Every client login for one company loses access, and pending client
 * invitations for it are cancelled. Used when the company is disconnected,
 * and again if it is ever reconnected (it can be disconnected from inside
 * QuickBooks too), so a reconnect never quietly gives old client logins
 * their access back. Returns the logins to sign out.
 */
export async function removeClientLoginsForCompany(ownerId: string, connectionId: string, now = new Date()): Promise<string[]> {
  const rows = await prisma.teamMember.findMany({
    where: { ownerUserId: ownerId, role: "client", connectionId },
    select: { id: true },
  });
  const signOut: string[] = [];
  for (const r of rows) {
    const result = await removeTeamLogin(ownerId, r.id, now);
    if (result.ok && result.memberUserId) signOut.push(result.memberUserId);
  }
  return signOut;
}

/**
 * For a login whose access to an account was removed and that has no
 * account of its own: whose account it was, so the dashboard can say so
 * plainly. Null otherwise.
 */
export async function removedAccessFor(userId: string): Promise<{ ownerName: string | null; ownerEmail: string | null } | null> {
  const row = await prisma.teamMember.findUnique({ where: { memberUserId: userId } });
  if (!row || row.role !== REMOVED_ROLE) return null;
  const [connections, subscription] = await Promise.all([
    prisma.quickBooksConnection.count({ where: { userId, disconnectedAt: null } }),
    prisma.subscription.findUnique({ where: { userId }, select: { stripeSubscriptionId: true } }),
  ]);
  // A login that has since connected its own company or paid for its own
  // plan is using its own account now.
  if (connections > 0 || subscription?.stripeSubscriptionId) return null;
  const owner = await prisma.user.findUnique({ where: { id: row.ownerUserId }, select: { name: true, email: true } });
  return { ownerName: owner?.name ?? null, ownerEmail: owner?.email ?? null };
}
