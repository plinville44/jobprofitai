/**
 * One definition of whether a job is finished, shared by every surface.
 *
 * Two fields decide it:
 *
 *   `status`         mirrors the QuickBooks customer's Active flag, written
 *                    by the sync.
 *   `statusOverride` is the contractor's own call, set in JobProfitAI, and
 *                    it wins.
 *
 * The override exists because QuickBooks Projects carry a status ("In
 * progress" / "Completed") that its v3 API does not expose. Confirmed
 * against a real company by dumping every field the Customer endpoint
 * returns: marking a project Completed changes nothing an integration can
 * see. The only synced signal is Active, which flips when a customer is
 * made *inactive*, which is a different act with different side effects
 * (QuickBooks renames the customer to "Name (deleted)").
 *
 * So for a contractor using Projects the normal way, no job would ever reach
 * "closed" here, and Profit Intelligence - which only ever compares finished
 * work - would stay silent no matter how many jobs they completed.
 *
 * This lives in its own module rather than in profitability.ts because
 * entitlements.ts needs the query fragments too, and profitability.ts
 * already imports from entitlements.ts.
 */

import type { Prisma } from "@prisma/client";

/** The status the app should act on. */
export function effectiveJobStatus(job: { status: string; statusOverride?: string | null }): string {
  return job.statusOverride === "open" || job.statusOverride === "closed"
    ? job.statusOverride
    : job.status;
}

/**
 * Prisma `where` fragments matching the same rule in the database, for the
 * places that filter jobs by status in a query rather than in memory.
 *
 * Written as an explicit OR rather than anything cleverer because Prisma
 * cannot express "coalesce these two columns" in a filter, and a query that
 * quietly disagreed with effectiveJobStatus above would be the worst kind of
 * bug: two parts of the app with different ideas of which jobs are done.
 *
 * Typed as Prisma.JobWhereInput rather than left to inference, and NOT
 * marked `as const`. A const assertion makes the OR array readonly, which
 * JobWhereInput rejects, and that error is confusing out of proportion to
 * its cause: once a where clause fails to type-check, Prisma's inference
 * gives up and the query's result type silently loses the relations named
 * in `include`, so the real complaint surfaces as "Property 'invoices' does
 * not exist" a hundred lines away.
 */
export const CLOSED_JOB_WHERE: Prisma.JobWhereInput = {
  OR: [{ statusOverride: "closed" }, { statusOverride: null, status: "closed" }],
};

export const OPEN_JOB_WHERE: Prisma.JobWhereInput = {
  OR: [{ statusOverride: "open" }, { statusOverride: null, status: "open" }],
};
