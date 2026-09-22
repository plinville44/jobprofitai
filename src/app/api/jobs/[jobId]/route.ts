import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

// Job "type" (category) and "estimated cost" are intentionally manual-only
// fields - QuickBooks' public API doesn't reliably expose either a job-type
// taxonomy or internal cost budgets (see plan §2/§6), so the deterministic
// engine (src/lib/profitability.ts) only ever reads these from our own
// database, never from a sync. This route is the one place they get written.
//
// Both fields are optional and nullable end to end: leaving category unset
// just means that job never joins a cross-job benchmarking group, and
// leaving estimatedCost unset just means the no_estimate_on_file /
// low-confidence path applies to that job - same "no false precision"
// pattern as everywhere else, not a required field this route should force.
const KNOWN_CATEGORIES = [
  "roofing",
  "remodel",
  "new_construction",
  "painting",
  "plumbing",
  "electrical",
  "hvac",
  "general",
  "other",
];

export async function PATCH(
  req: NextRequest,
  // Next.js 16: route segment params arrive as a Promise.
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: { connection: true },
    });
    if (!job || job.connection.userId !== session.userId) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const body = await req.json();
    const data: {
      category?: string | null;
      estimatedCost?: number | null;
      statusOverride?: string | null;
    } = {};

    if ("category" in body) {
      if (body.category === null || body.category === "") {
        data.category = null;
      } else if (typeof body.category === "string" && KNOWN_CATEGORIES.includes(body.category)) {
        data.category = body.category;
      } else {
        return NextResponse.json({ error: "Invalid category" }, { status: 400 });
      }
    }

    if ("estimatedCost" in body) {
      if (body.estimatedCost === null || body.estimatedCost === "") {
        data.estimatedCost = null;
      } else {
        const n = Number(body.estimatedCost);
        // Zero is refused along with negatives. A $0 estimate was accepted
        // here and then read as "present" by Data Health and "missing" by the
        // forecast, and the job page printed "over the $0 estimate". The
        // engine treats <= 0 as no estimate anyway; saying so at entry is
        // clearer than silently ignoring it. To remove an estimate, clear it.
        if (!Number.isFinite(n) || n <= 0) {
          return NextResponse.json(
            { error: "Estimated cost must be more than $0. Leave it blank if there is no estimate." },
            { status: 400 }
          );
        }
        data.estimatedCost = n;
      }
    }

    // Job status is manual for the same reason the two fields above are.
    // QuickBooks Projects carry a status its API does not expose - marking a
    // project Completed there changes nothing we can see - so "is this job
    // finished" has to be answerable here or Profit Intelligence, which only
    // compares completed jobs, stays silent forever.
    if ("statusOverride" in body) {
      if (body.statusOverride === null || body.statusOverride === "") {
        data.statusOverride = null;
      } else if (body.statusOverride === "open" || body.statusOverride === "closed") {
        data.statusOverride = body.statusOverride;
      } else {
        return NextResponse.json({ error: "Invalid job status" }, { status: 400 });
      }
    }

    const updated = await prisma.job.update({ where: { id: job.id }, data });
    return NextResponse.json({
      ok: true,
      category: updated.category,
      estimatedCost: updated.estimatedCost != null ? Number(updated.estimatedCost) : null,
      statusOverride: updated.statusOverride,
    });
  } catch (err) {
    console.error("jobs/[jobId] PATCH failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't save job details." },
      { status: 500 }
    );
  }
}
