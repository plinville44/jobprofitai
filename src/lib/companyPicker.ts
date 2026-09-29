/**
 * Company lists people pick from: the header's company switcher and the
 * client login form in Settings. A bookkeeper with 40 clients needs them in
 * name order, with a filter box, and a form that starts on the company on
 * screen, never on whichever was connected first. Pure, so the browser
 * components and the tests share it.
 */

export interface PickableCompany {
  id: string;
  name: string;
}

/** Past this many companies, the pickers show a filter box. */
export const COMPANY_FILTER_THRESHOLD = 10;

/** By name, ignoring case and accents; the id breaks ties so the order is stable. */
export function sortCompaniesByName<T extends PickableCompany>(companies: T[]): T[] {
  return [...companies].sort(
    (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || a.id.localeCompare(b.id)
  );
}

/**
 * The companies whose name contains the query (ignoring case). The one in
 * `keepId` always stays in the list, so a select never loses its current
 * value while someone types.
 */
export function filterCompanies<T extends PickableCompany>(companies: T[], query: string, keepId?: string | null): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return companies;
  return companies.filter((c) => c.id === keepId || c.name.toLowerCase().includes(q));
}

/** The company a client login invitation starts on: the one on screen when there is one. */
export function defaultInviteCompanyId(companies: PickableCompany[], activeId: string | null | undefined): string {
  if (activeId && companies.some((c) => c.id === activeId)) return activeId;
  return sortCompaniesByName(companies)[0]?.id ?? "";
}
