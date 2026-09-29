"use client";

import { usePathname } from "next/navigation";

/**
 * The company on screen, named above each page's heading for accounts with
 * more than one company, so Jobs, Money Owed and the rest say whose figures
 * they are. Left off pages that cover the whole account rather than one
 * company.
 */
const ACCOUNT_PAGES = ["/dashboard/portfolio", "/dashboard/billing", "/dashboard/referrals", "/dashboard/partner", "/dashboard/admin"];

export default function ActiveCompanyLabel({ name }: { name: string }) {
  const pathname = usePathname() ?? "";
  if (ACCOUNT_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;
  return (
    <p className="mb-2 text-sm font-medium text-gray-500">
      <span className="sr-only">Company: </span>
      {name}
    </p>
  );
}
