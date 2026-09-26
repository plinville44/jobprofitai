import { prisma } from "./prisma";
import { resolveJobTypes, selectableJobTypes, type CompanyJobType } from "./jobTypes";

/**
 * A company's job types (built-in list plus its own additions, renames and
 * hides). Server-only; client components receive the result as a prop.
 */
export async function getJobTypes(connectionId: string): Promise<CompanyJobType[]> {
  const rows = await prisma.jobType.findMany({
    where: { connectionId },
    select: { key: true, label: true, hidden: true, sortOrder: true },
  });
  return resolveJobTypes(rows);
}

/**
 * Checks a job type a request wants to set. Hidden types are refused for new
 * assignments; `allowKeep` lets a job keep the hidden type it already has.
 */
export function isAssignableJobType(types: CompanyJobType[], value: string, allowKeep?: string | null): boolean {
  if (allowKeep != null && value === allowKeep) return types.some((t) => t.value === value);
  return selectableJobTypes(types).some((t) => t.value === value);
}
