import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { connectionForAccount, getAccount } from "@/lib/account";
import { refuseCrossSite } from "@/lib/sameOrigin";
import { getJobTypes, isAssignableJobType } from "@/lib/jobTypesServer";

const MAX = 500;

/**
 * POST /api/jobs/accept-types  { connectionId, assignments: [{ jobId, category }] }
 *
 * Sets job types the contractor accepted from the suggestions, each job its
 * own type. Only jobs of this company, and only jobs still without a type,
 * so accepting an old suggestion can't overwrite a type set since.
 */
export async function POST(req: NextRequest) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const connection = await connectionForAccount(account, body?.connectionId);
    if (!connection) return NextResponse.json({ error: "Company not found" }, { status: 404 });
    const assignments: unknown = body?.assignments;
    if (!Array.isArray(assignments) || assignments.length === 0) {
      return NextResponse.json({ error: "Choose at least one job." }, { status: 400 });
    }
    if (assignments.length > MAX) {
      return NextResponse.json({ error: `Send at most ${MAX} jobs at a time.` }, { status: 400 });
    }
    const types = await getJobTypes(connection.id);
    let updated = 0;
    for (const a of assignments as { jobId?: unknown; category?: unknown }[]) {
      if (typeof a?.jobId !== "string" || typeof a.category !== "string" || !isAssignableJobType(types, a.category)) continue;
      const res = await prisma.job.updateMany({
        where: { id: a.jobId, connectionId: connection.id, category: null },
        data: { category: a.category, suggestedCategory: null, suggestionSource: null, suggestionReason: null, suggestedAt: null },
      });
      updated += res.count;
    }
    return NextResponse.json({ ok: true, updated });
  } catch (err) {
    console.error("jobs/accept-types failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json({ error: "Couldn't save that. Please try again." }, { status: 500 });
  }
}
