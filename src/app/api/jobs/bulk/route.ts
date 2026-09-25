import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccount } from "@/lib/account";
import { getJobTypes, isAssignableJobType } from "@/lib/jobTypesServer";

/**
 * PATCH /api/jobs/bulk  { jobIds: string[], statusOverride?, category? }
 *
 * The same two manual fields as PATCH /api/jobs/[jobId], applied to many jobs
 * at once. It exists because marking jobs complete is now a per-job chore
 * that QuickBooks cannot do for the customer (its API exposes no project
 * status), and a contractor coming back from a busy month with a dozen
 * finished jobs should not have to open a dozen pages.
 *
 * Job types are validated against each company's own list (built-in types
 * plus its additions, minus hidden ones), the same list the dropdown shows.
 */

const MAX_JOBS_PER_REQUEST = 500;

export async function PATCH(req: NextRequest) {
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const jobIds: unknown = body?.jobIds;

    if (!Array.isArray(jobIds) || jobIds.length === 0 || !jobIds.every((id) => typeof id === "string")) {
      return NextResponse.json({ error: "Select at least one job." }, { status: 400 });
    }
    if (jobIds.length > MAX_JOBS_PER_REQUEST) {
      return NextResponse.json(
        { error: `That's more than ${MAX_JOBS_PER_REQUEST} jobs at once. Narrow the filter and try again.` },
        { status: 400 }
      );
    }

    const data: { statusOverride?: string | null; category?: string | null } = {};

    if ("statusOverride" in body) {
      if (body.statusOverride === null || body.statusOverride === "") {
        data.statusOverride = null;
      } else if (body.statusOverride === "open" || body.statusOverride === "closed") {
        data.statusOverride = body.statusOverride;
      } else {
        return NextResponse.json({ error: "Invalid job status" }, { status: 400 });
      }
    }

    if ("category" in body) {
      if (body.category === null || body.category === "") {
        data.category = null;
      } else if (typeof body.category === "string" && body.category.length <= 60) {
        // Every company the selected jobs belong to must offer this type.
        const connections = await prisma.job.findMany({
          where: { id: { in: jobIds }, connection: { userId: account.ownerId, disconnectedAt: null } },
          select: { connectionId: true },
          distinct: ["connectionId"],
        });
        for (const c of connections) {
          if (!isAssignableJobType(await getJobTypes(c.connectionId), body.category)) {
            return NextResponse.json({ error: "Invalid job type" }, { status: 400 });
          }
        }
        data.category = body.category;
      } else {
        return NextResponse.json({ error: "Invalid job type" }, { status: 400 });
      }
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
    }

    // Ownership is enforced in the WHERE clause, not by checking first and
    // updating after. updateMany can only touch rows that already satisfy
    // the filter, so a request naming another customer's job ids updates
    // nothing rather than updating them - the one place in this app where a
    // mistake would let one contractor edit another's financial records.
    const result = await prisma.job.updateMany({
      where: {
        id: { in: jobIds },
        connection: { userId: account.ownerId, disconnectedAt: null },
      },
      data,
    });

    // Reported back so the UI can say "12 of 14 updated" rather than claiming
    // success for rows that were silently filtered out.
    return NextResponse.json({ ok: true, updated: result.count, requested: jobIds.length });
  } catch (err) {
    console.error("jobs/bulk PATCH failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't update those jobs." },
      { status: 500 }
    );
  }
}
