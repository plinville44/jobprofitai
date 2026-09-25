import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { connectionForAccount, getAccount } from "@/lib/account";
import { getJobTypes } from "@/lib/jobTypesServer";
import { selectableJobTypes } from "@/lib/jobTypes";

/**
 * POST /api/jobs/import
 *   { connectionId, rows: [{ job, estimatedCost?, contractValue?, jobType?, percentComplete? }] }
 *
 * Bulk-sets the fields QuickBooks has no place for, from a spreadsheet the
 * browser has already parsed (see JobBudgetTools). Typing an estimated cost
 * into every job one page at a time was the setup step most likely to stop
 * a trial; this is the same edit for a whole list at once.
 *
 * Rows match a job by its QuickBooks name (case and spacing ignored). A
 * blank cell leaves that field alone; only a value changes anything.
 * Returns which rows matched and which didn't, so nothing is silently lost.
 */
const MAX_ROWS = 2000;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export async function POST(req: NextRequest) {
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const connection = await connectionForAccount(account, body?.connectionId);
    if (!connection) return NextResponse.json({ error: "Company not found" }, { status: 404 });

    const rows: any[] = Array.isArray(body?.rows) ? body.rows : [];
    if (rows.length === 0) return NextResponse.json({ error: "The file has no rows to import." }, { status: 400 });
    if (rows.length > MAX_ROWS) return NextResponse.json({ error: `Import up to ${MAX_ROWS} rows at a time.` }, { status: 400 });

    const jobs = await prisma.job.findMany({ where: { connectionId: connection.id, missingSince: null }, select: { id: true, name: true, estimatedCost: true, category: true } });
    // The company's own job types, by name or key. Hidden ones are known so
    // a job can keep the one it has (the template exports it), but can't be
    // given one newly.
    const allTypes = await getJobTypes(connection.id);
    const offered = selectableJobTypes(allTypes);
    const TYPE_BY_LABEL = new Map<string, string>();
    for (const o of allTypes) {
      TYPE_BY_LABEL.set(o.value.toLowerCase(), o.value);
      TYPE_BY_LABEL.set(o.label.toLowerCase(), o.value);
    }
    const hidden = new Set(allTypes.filter((t) => t.hidden).map((t) => t.value));
    const byName = new Map<string, string[]>();
    for (const j of jobs) byName.set(norm(j.name), [...(byName.get(norm(j.name)) ?? []), j.id]);

    const unmatched: string[] = [];
    const problems: string[] = [];
    let updated = 0;

    for (const [i, r] of rows.entries()) {
      const name = typeof r?.job === "string" ? r.job : "";
      if (!name.trim()) continue;
      const ids = byName.get(norm(name));
      if (!ids) {
        unmatched.push(name);
        continue;
      }
      if (ids.length > 1) {
        problems.push(`Row ${i + 2}: "${name}" matches ${ids.length} jobs with the same name; set it on the job page instead.`);
        continue;
      }
      const data: Record<string, unknown> = {};
      const money = (v: unknown, label: string) => {
        if (v == null || v === "") return undefined;
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) {
          problems.push(`Row ${i + 2}: ${label} "${v}" isn't a positive amount.`);
          return undefined;
        }
        return Math.round(n * 100) / 100;
      };
      const est = money(r.estimatedCost, "estimated cost");
      if (est !== undefined) {
        data.estimatedCost = est;
        // A changed figure is the contractor's own; the same figure keeps its source.
        const prior = jobs.find((j) => j.id === ids[0])?.estimatedCost;
        if (prior == null || Number(prior) !== est) data.estimatedCostSource = "manual";
      }
      const cv = money(r.contractValue, "contract value");
      if (cv !== undefined) data.manualContractValue = cv;
      if (r.percentComplete != null && r.percentComplete !== "") {
        const p = Number(String(r.percentComplete).replace("%", ""));
        if (Number.isFinite(p) && p >= 0 && p <= 100) data.percentCompleteOverride = p;
        else problems.push(`Row ${i + 2}: percent complete "${r.percentComplete}" isn't between 0 and 100.`);
      }
      if (typeof r.jobType === "string" && r.jobType.trim()) {
        const t = TYPE_BY_LABEL.get(r.jobType.trim().toLowerCase());
        const current = jobs.find((j) => j.id === ids[0])?.category ?? null;
        if (t && (!hidden.has(t) || t === current)) {
          if (t !== current) data.category = t;
        } else problems.push(`Row ${i + 2}: job type "${r.jobType}" isn't one of: ${offered.map((o) => o.label).join(", ")}.`);
      }
      if (Object.keys(data).length === 0) continue;
      await prisma.job.update({ where: { id: ids[0] }, data });
      updated++;
    }

    return NextResponse.json({ ok: true, updated, unmatched: unmatched.slice(0, 50), unmatchedCount: unmatched.length, problems: problems.slice(0, 50) });
  } catch (err) {
    console.error("jobs/import failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json({ error: "Couldn't import that file. Please try again." }, { status: 500 });
  }
}
