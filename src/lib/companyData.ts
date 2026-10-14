import type { QuickBooksConnection } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { needsReconnect, revokeToken } from "@/lib/quickbooks";
import { decryptToken } from "@/lib/crypto";
import { revokeAllSessions } from "@/lib/auth";
import { removeClientLoginsForCompany } from "@/lib/teamRemoval";
import { syncFirmQuantity } from "@/lib/stripe/firmQuantity";
import { getEntitlements } from "@/lib/entitlements";
import {
  DAY_MS,
  DELETION_REMINDER_DAYS_BEFORE,
  DISCONNECTED_RETENTION_DAYS,
  EARLIEST_RULES_START,
  REVOKED_GRANT_GRACE_DAYS,
  accessEndedAt,
  deletionDueAt,
  lapsedLongEnough,
} from "@/lib/dataRetention";

export * from "@/lib/dataRetention";

/** Disconnecting, deleting and purging companies. The rules and numbers are in src/lib/dataRetention.ts. */

const RULES_START_KEY = "retention_rules_start";

/**
 * The day the retention rules started in production: recorded by the first
 * lifecycle run that calls this, and read back on every run after, so the
 * clocks for anything disconnected or lapsed before launch count from launch
 * day. Never earlier than RETENTION_RULES_START.
 */
export async function retentionRulesStart(now = new Date()): Promise<Date> {
  const row = await prisma.appMilestone.upsert({
    where: { key: RULES_START_KEY },
    create: { key: RULES_START_KEY, at: now },
    update: {},
  });
  return row.at.getTime() < EARLIEST_RULES_START.getTime() ? EARLIEST_RULES_START : row.at;
}

/**
 * The same date for pages that only display deletion dates. Before the
 * first lifecycle run it isn't recorded yet, so the rules count from now.
 */
export async function currentRetentionRulesStart(now = new Date()): Promise<Date> {
  const row = await prisma.appMilestone.findUnique({ where: { key: RULES_START_KEY } });
  const at = row?.at ?? now;
  return at.getTime() < EARLIEST_RULES_START.getTime() ? EARLIEST_RULES_START : at;
}

async function revokeQuietly(connection: Pick<QuickBooksConnection, "refreshToken">): Promise<void> {
  try {
    await revokeToken(decryptToken(connection.refreshToken));
  } catch (err) {
    // An already-invalid token must not block the disconnect or the delete.
    console.error("companyData: token revoke failed:", err instanceof Error ? err.message : "Unknown error");
  }
}

async function removeClientAccess(ownerId: string, connectionId: string): Promise<void> {
  const signOut = await removeClientLoginsForCompany(ownerId, connectionId);
  for (const userId of signOut) await revokeAllSessions(userId).catch(() => {});
}

/**
 * Disconnects a company: revokes the QuickBooks grant with Intuit, marks it
 * disconnected (which stops all processing and starts the deletion clock),
 * and removes its client logins. Used by the lapsed-account job; the
 * Settings button has its own route with the same steps.
 */
export async function disconnectCompany(connection: QuickBooksConnection, now = new Date()): Promise<void> {
  await revokeQuietly(connection);
  await prisma.quickBooksConnection.update({ where: { id: connection.id }, data: { disconnectedAt: now } });
  await removeClientAccess(connection.userId, connection.id);
  await syncFirmQuantity(connection.userId);
}

/** The company's ID hash, without the "moved:" prefix a set-aside row carries. */
function baseRealmHash(realmIdHash: string): string {
  return realmIdHash.startsWith("moved:") ? realmIdHash.split(":")[1] ?? realmIdHash : realmIdHash;
}

/**
 * Keeps the one-free-trial record for a company whose rows are about to go.
 * The trial check also looks for earlier connections by other accounts, so
 * without this a company only ever connected by paying accounts could start
 * a fresh trial elsewhere once its data was deleted. The account that first
 * connected it may still come back to it.
 */
async function keepTrialRecord(connection: QuickBooksConnection): Promise<void> {
  await prisma.realmTrial
    .upsert({
      where: { realmIdHash: baseRealmHash(connection.realmIdHash) },
      create: { realmIdHash: baseRealmHash(connection.realmIdHash), firstUserId: connection.userId, firstConnectedAt: connection.connectedAt },
      update: {},
    })
    .catch(() => {});
}

/**
 * Permanently deletes one company's data: the connection row and, through
 * the schema's cascades, its jobs, costs, time, invoices, estimates, briefs,
 * alerts, insights, month-end WIP snapshots, job types, settings and client
 * logins. A live grant is revoked with Intuit first, while the token still
 * exists. The one-free-trial record (a keyed hash of the company ID, no link
 * to the row) is kept, as the Privacy Policy says.
 */
export async function deleteCompanyData(connection: QuickBooksConnection): Promise<void> {
  if (!connection.disconnectedAt) await revokeQuietly(connection);
  await removeClientAccess(connection.userId, connection.id);
  await keepTrialRecord(connection);
  await prisma.quickBooksConnection.delete({ where: { id: connection.id } });
  await syncFirmQuantity(connection.userId);
}

/**
 * Companies whose deletion date (deletionDueAt) has come: delete them. The
 * delete is conditional on the row still being disconnected, so a company
 * reconnected while this runs is never deleted. Client logins were removed
 * at the disconnect, and the grant was revoked or refused then.
 */
export async function purgeDisconnectedCompanies(now = new Date(), rulesStart: Date, limit = 100): Promise<number> {
  const cutoff = new Date(now.getTime() - DISCONNECTED_RETENTION_DAYS * DAY_MS);
  const candidates = await prisma.quickBooksConnection.findMany({
    where: { disconnectedAt: { not: null, lte: cutoff } },
    orderBy: { disconnectedAt: "asc" },
    take: limit * 4,
  });
  let deleted = 0;
  for (const c of candidates) {
    if (deleted >= limit) break;
    if (deletionDueAt(c.disconnectedAt!, rulesStart).getTime() > now.getTime()) continue;
    await keepTrialRecord(c);
    const gone = await prisma.quickBooksConnection.deleteMany({ where: { id: c.id, disconnectedAt: { not: null, lte: cutoff } } });
    if (gone.count === 0) continue;
    deleted += 1;
    await syncFirmQuantity(c.userId);
  }
  return deleted;
}

/** Disconnected companies whose data is deleted within DELETION_REMINDER_DAYS_BEFORE days. */
export async function companiesDueForDeletionReminder(now = new Date(), rulesStart: Date): Promise<QuickBooksConnection[]> {
  const soon = now.getTime() + DELETION_REMINDER_DAYS_BEFORE * DAY_MS;
  // Every company disconnected before the rules began shares one deletion
  // date, so the window is read in full rather than capped.
  const rows: QuickBooksConnection[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.quickBooksConnection.findMany({
      where: { disconnectedAt: { not: null } },
      orderBy: { id: "asc" },
      take: 500,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    rows.push(...page);
    if (page.length < 500) break;
    cursor = page[page.length - 1].id;
  }
  return rows.filter((c) => {
    const due = deletionDueAt(c.disconnectedAt!, rulesStart).getTime();
    return due > now.getTime() && due <= soon;
  });
}

/**
 * Companies QuickBooks has stopped letting us read (the owner disconnected
 * the app from their Intuit account while signed out of JobProfitAI, or the
 * grant otherwise ended) and that haven't been reconnected for
 * REVOKED_GRANT_GRACE_DAYS: treat them as disconnected, which starts the
 * deletion clock. Nothing can be synced from them in the meantime.
 */
export async function disconnectRevokedGrants(now = new Date()): Promise<QuickBooksConnection[]> {
  const stale = new Date(now.getTime() - REVOKED_GRANT_GRACE_DAYS * DAY_MS);
  const candidates = await prisma.quickBooksConnection.findMany({
    where: {
      disconnectedAt: null,
      lastSyncStatus: "error",
      OR: [{ lastSyncedAt: { lt: stale } }, { lastSyncedAt: null, connectedAt: { lt: stale } }],
    },
    take: 500,
  });
  const done: QuickBooksConnection[] = [];
  for (const c of candidates.filter((x) => needsReconnect(x.lastSyncError))) {
    const marked = await prisma.quickBooksConnection.updateMany({ where: { id: c.id, disconnectedAt: null }, data: { disconnectedAt: now } });
    if (marked.count === 0) continue;
    await removeClientAccess(c.userId, c.id);
    await syncFirmQuantity(c.userId);
    done.push({ ...c, disconnectedAt: now });
  }
  return done;
}

/**
 * Accounts with no live trial or plan for LAPSED_DISCONNECT_DAYS: disconnect
 * their companies. Only accounts without a live subscription are read, so
 * paying customers never crowd lapsed ones out of the batch, and each owner
 * is handled whole so one email covers every company they lose. Returns what
 * was disconnected so the caller can email the owner. Complimentary
 * accounts are never touched.
 */
export async function disconnectLapsedCompanies(now = new Date(), rulesStart: Date, ownerLimit = 100): Promise<QuickBooksConnection[]> {
  const candidates = await prisma.quickBooksConnection.findMany({
    where: {
      disconnectedAt: null,
      user: {
        OR: [
          { subscription: { is: null } },
          { subscription: { status: { notIn: ["active", "past_due", "trialing"] } } },
          { subscription: { status: "trialing", trialEndsAt: { lt: now } } },
        ],
      },
    },
    include: { user: { select: { createdAt: true, subscription: true } } },
    orderBy: { connectedAt: "asc" },
    take: 2000,
  });
  const byOwner = new Map<string, typeof candidates>();
  for (const c of candidates) byOwner.set(c.userId, [...(byOwner.get(c.userId) ?? []), c]);

  const done: QuickBooksConnection[] = [];
  let owners = 0;
  for (const [ownerId, companies] of byOwner) {
    if (owners >= ownerLimit) break;
    const first = companies[0];
    const ended = accessEndedAt(first.user.subscription, first.user.createdAt, now);
    if (!lapsedLongEnough(ended, now, rulesStart)) continue;
    if ((await getEntitlements(ownerId, now)).access === "complimentary") continue;
    owners += 1;
    for (const c of companies) {
      const { user, ...connection } = c;
      void user;
      await disconnectCompany(connection, now);
      done.push({ ...connection, disconnectedAt: now });
    }
  }
  return done;
}
