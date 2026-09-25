import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { connectionForAccount, getAccount } from "@/lib/account";
import { OPEN_JOB_WHERE } from "@/lib/jobStatus";
import { labelForJobType } from "@/lib/jobTypes";
import { getJobTypes } from "@/lib/jobTypesServer";
import { toCsv } from "@/lib/csv";

/**
 * GET /api/jobs/template?connectionId=...&all=1
 *
 * A spreadsheet of the company's jobs (open ones, or all with all=1) with
 * the fields JobProfitAI can't get from QuickBooks, already filled in where
 * known. Fill in the blanks, save as CSV, import it back on the Jobs page.
 */
export async function GET(req: NextRequest) {
  const account = await getAccount();
  if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const connection = await connectionForAccount(account, req.nextUrl.searchParams.get("connectionId"));
  if (!connection) return NextResponse.json({ error: "Company not found" }, { status: 404 });
  const all = req.nextUrl.searchParams.get("all") === "1";

  const jobs = await prisma.job.findMany({
    where: { connectionId: connection.id, ...(all ? { missingSince: null } : OPEN_JOB_WHERE) },
    orderBy: { name: "asc" },
    select: { name: true, customerName: true, category: true, estimatedCost: true, manualContractValue: true, estimatedRevenue: true, percentCompleteOverride: true },
  });
  const jobTypes = await getJobTypes(connection.id);
  const rows = [
    ["Job", "Customer", "Job type", "Estimated cost", "Contract value", "Percent complete", "Contract value from QuickBooks (for reference)"],
    ...jobs.map((j) => [
      j.name,
      j.customerName ?? "",
      j.category ? labelForJobType(jobTypes, j.category) : "",
      j.estimatedCost != null ? Number(j.estimatedCost) : "",
      j.manualContractValue != null ? Number(j.manualContractValue) : "",
      j.percentCompleteOverride != null ? Number(j.percentCompleteOverride) : "",
      j.estimatedRevenue != null ? Number(j.estimatedRevenue) : "",
    ]),
  ];
  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="jobprofitai-job-budgets.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
