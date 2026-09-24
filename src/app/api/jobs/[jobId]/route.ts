import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccount } from "@/lib/account";
import { JOB_TYPE_OPTIONS } from "@/lib/jobTypes";

// The fields a contractor sets in JobProfitAI because QuickBooks has no
// place for them (or its API doesn't expose it): job type, estimated cost,
// contract value, percent complete and completed/active. The engine
// (src/lib/profitability.ts) reads them from our own database only; this
// route and the bulk/import routes are the only writers.
//
// Every field is optional and nullable: leaving one unset just means the
// feature that needs it says what's missing instead of guessing.
const KNOWN_CATEGORIES = new Set(JOB_TYPE_OPTIONS.map((o) => o.value).filter(Boolean));

/** A positive dollar amount, null to clear, or an error message. */
function money(value: unknown, label: string): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value === null || value === "") return { ok: true, value: null };
  const n = Number(typeof value === "string" ? value.replace(/[$,\s]/g, "") : value);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: `${label} must be more than $0. Leave it blank if there isn't one.` };
  }
  if (n > 1_000_000_000) return { ok: false, error: `${label} looks too large.` };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

export async function PATCH(
  req: NextRequest,
  // Next.js 16: route segment params arrive as a Promise.
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: { connection: true },
    });
    // Same rule as bulk edits: the job's company must belong to this account
    // and still be connected.
    if (!job || job.connection.userId !== account.ownerId || job.connection.disconnectedAt) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const data: {
      category?: string | null;
      estimatedCost?: number | null;
      manualContractValue?: number | null;
      percentCompleteOverride?: number | null;
      statusOverride?: string | null;
    } = {};

    if ("category" in body) {
      if (body.category === null || body.category === "") {
        data.category = null;
      } else if (typeof body.category === "string" && KNOWN_CATEGORIES.has(body.category)) {
        data.category = body.category;
      } else {
        return NextResponse.json({ error: "Invalid job type" }, { status: 400 });
      }
    }

    if ("estimatedCost" in body) {
      // Zero is refused: the engine treats <= 0 as no estimate, and saying
      // so at entry is clearer than silently ignoring it.
      const r = money(body.estimatedCost, "Estimated cost");
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      data.estimatedCost = r.value;
    }

    if ("manualContractValue" in body) {
      const r = money(body.manualContractValue, "Contract value");
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      data.manualContractValue = r.value;
    }

    if ("percentCompleteOverride" in body) {
      const v = body.percentCompleteOverride;
      if (v === null || v === "") {
        data.percentCompleteOverride = null;
      } else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          return NextResponse.json({ error: "Percent complete must be between 0 and 100." }, { status: 400 });
        }
        data.percentCompleteOverride = Math.round(n * 100) / 100;
      }
    }

    // Job status is manual for the same reason as the fields above:
    // QuickBooks Projects carry a status its API does not expose.
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
      manualContractValue: updated.manualContractValue != null ? Number(updated.manualContractValue) : null,
      percentCompleteOverride: updated.percentCompleteOverride != null ? Number(updated.percentCompleteOverride) : null,
      statusOverride: updated.statusOverride,
    });
  } catch (err) {
    console.error("jobs/[jobId] PATCH failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json({ error: "Couldn't save job details. Please try again." }, { status: 500 });
  }
}
