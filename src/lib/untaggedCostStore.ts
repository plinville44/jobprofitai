import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptToken } from "@/lib/crypto";
import { UNTAGGED_WINDOW_DAYS, type UntaggedCostRow, type UntaggedCostView } from "@/lib/untaggedCosts";

/**
 * Database side of the list of job costs not on any job (see
 * src/lib/untaggedCosts.ts). Writes happen once per sync, in bulk, inside one
 * transaction each, so Data Health never shows a list that is half replaced.
 */

const CREATE_CHUNK = 1000;
const DELETE_CHUNK = 500;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const creates = (rows: UntaggedCostRow[]) =>
  chunks(rows, CREATE_CHUNK).map((data) => prisma.untaggedCost.createMany({ data, skipDuplicates: true }));

/**
 * A full sync: the company's rows become exactly what this sync found.
 * `unreadTypes` are source types QuickBooks failed to send this time; their
 * stored rows are kept rather than wiped for "not being returned", the same
 * rule cost rows follow.
 */
export async function replaceUntaggedCosts(connectionId: string, rows: UntaggedCostRow[], unreadTypes: string[] = []): Promise<number> {
  const unread = new Set(unreadTypes);
  const keep = rows.filter((r) => !unread.has(r.qboSourceType));
  await prisma.$transaction([
    prisma.untaggedCost.deleteMany({
      where: { connectionId, ...(unread.size > 0 ? { qboSourceType: { notIn: [...unread] } } : {}) },
    }),
    ...creates(keep),
  ]);
  return keep.length;
}

/**
 * An incremental sync: every transaction it re-read (`touched`, source type
 * to QuickBooks ids, deleted ones included) has its rows replaced with what
 * this sync found for it. That drops lines now on a job, lines changed to
 * overhead, and whole transactions that were deleted or voided. Nothing else
 * is touched.
 */
export async function replaceUntaggedCostsForTxns(
  connectionId: string,
  rows: UntaggedCostRow[],
  touched: Map<string, Set<string>>
): Promise<number> {
  const deletes: Prisma.PrismaPromise<unknown>[] = [];
  for (const [qboSourceType, ids] of touched) {
    for (const part of chunks([...ids], DELETE_CHUNK)) {
      deletes.push(prisma.untaggedCost.deleteMany({ where: { connectionId, qboSourceType, qboSourceId: { in: part } } }));
    }
  }
  // Only rows of transactions this sync re-read; anything else would be
  // inserted over a row nobody removed.
  const keep = rows.filter((r) => touched.get(r.qboSourceType)?.has(r.qboSourceId) ?? false);
  if (deletes.length === 0 && keep.length === 0) return 0;
  await prisma.$transaction([...deletes, ...creates(keep)]);
  return keep.length;
}

const VIEW_SELECT = {
  id: true,
  qboSourceType: true,
  qboSourceId: true,
  kind: true,
  txnDate: true,
  docNumber: true,
  payee: true,
  accountName: true,
  memo: true,
  amount: true,
} as const;

/**
 * The company's untagged job costs from the last 12 months, biggest first.
 * Rows stay stored until a sync replaces them, so the 12 months are applied
 * here too: a cost that has aged out drops off even before the next full sync.
 */
export async function loadUntaggedCosts(
  connectionId: string,
  now: Date,
  take?: number
): Promise<{ rows: UntaggedCostView[]; total: number }> {
  const where = { connectionId, txnDate: { gte: new Date(now.getTime() - UNTAGGED_WINDOW_DAYS * 86_400_000) } };
  const [rows, total] = await Promise.all([
    prisma.untaggedCost.findMany({
      where,
      orderBy: [{ amount: "desc" }, { txnDate: "desc" }, { id: "asc" }],
      ...(take != null ? { take } : {}),
      select: VIEW_SELECT,
    }),
    prisma.untaggedCost.count({ where }),
  ]);
  return { rows: rows.map((r) => ({ ...r, amount: Number(r.amount) })), total };
}

/**
 * The QuickBooks company id for links into QuickBooks, or null if it can't
 * be read (the page then shows no links rather than failing).
 */
export function connectionRealmId(connection: { realmId: string }): string | null {
  try {
    return decryptToken(connection.realmId) || null;
  } catch {
    return null;
  }
}
