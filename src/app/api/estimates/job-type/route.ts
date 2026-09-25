import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccount } from "@/lib/account";
import { refuseCrossSite } from "@/lib/sameOrigin";
import { getJobTypes, isAssignableJobType } from "@/lib/jobTypesServer";

/**
 * POST /api/estimates/job-type  { estimateId, jobType }
 *
 * Sets the job type the Estimate Check compares a pending estimate against,
 * for an estimate that isn't on a job with a type yet. Stored on the
 * estimate row only; QuickBooks is never written to.
 */
export async function POST(req: NextRequest) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const estimateId = typeof body?.estimateId === "string" ? body.estimateId : null;
    const jobType = body?.jobType === null || body?.jobType === "" ? null : typeof body?.jobType === "string" ? body.jobType : undefined;
    if (!estimateId || jobType === undefined) return NextResponse.json({ error: "Missing estimateId or jobType." }, { status: 400 });

    const estimate = await prisma.jobEstimate.findFirst({
      where: { id: estimateId, connection: { userId: account.ownerId, disconnectedAt: null } },
      select: { id: true, connectionId: true },
    });
    if (!estimate) return NextResponse.json({ error: "Estimate not found." }, { status: 404 });
    if (jobType !== null && !isAssignableJobType(await getJobTypes(estimate.connectionId), jobType)) {
      return NextResponse.json({ error: "That job type isn't one of yours." }, { status: 400 });
    }
    await prisma.jobEstimate.update({ where: { id: estimate.id }, data: { jobType } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("estimates/job-type failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json({ error: "Couldn't save that. Please try again." }, { status: 500 });
  }
}
