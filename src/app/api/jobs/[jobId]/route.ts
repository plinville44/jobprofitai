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

export async function PATCH(req: NextRequest, { params }: { params: { jobId: string } }) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const job = await prisma.job.findUnique({
      where: { id: params.jobId },
      include: { connection: true },
    });
    if (!job || job.connection.userId !== session.userId) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const body = await req.json();
    const data: { category?: string | null; estimatedCost?: number | null } = {};

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
        if (!Number.isFinite(n) || n < 0) {
          return NextResponse.json({ error: "Estimated cost must be a positive number" }, { status: 400 });
        }
        data.estimatedCost = n;
      }
    }

    const updated = await prisma.job.update({ where: { id: job.id }, data });
    return NextResponse.json({
      ok: true,
      category: updated.category,
      estimatedCost: updated.estimatedCost != null ? Number(updated.estimatedCost) : null,
    });
  } catch (err) {
    console.error("jobs/[jobId] PATCH failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't save job details." },
      { status: 500 }
    );
  }
}
