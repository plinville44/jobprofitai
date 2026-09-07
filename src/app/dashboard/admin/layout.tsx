import Link from "next/link";
import { notFound } from "next/navigation";
import { getAdminSession } from "@/lib/adminAuth";

/**
 * Admin area.
 *
 * Authorization happens HERE, in a server layout, before any child page
 * runs a query. It returns notFound() rather than a 403 for a non-admin -
 * there's no reason to confirm to a random signed-in user that an admin area
 * exists at this path.
 *
 * Admins are defined by the ADMIN_EMAILS environment variable. If it's
 * unset, nobody is an admin and this whole section is inaccessible, which is
 * the correct default for a fresh environment.
 */
const TABS = [
  { href: "/dashboard/admin", label: "Overview" },
  { href: "/dashboard/admin/trials", label: "Trials" },
  { href: "/dashboard/admin/referrals", label: "Referrals" },
  { href: "/dashboard/admin/partners", label: "Partners" },
  { href: "/dashboard/admin/feedback", label: "Feedback" },
  { href: "/dashboard/admin/contact", label: "Contact" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await getAdminSession();
  if (!admin) notFound();

  return (
    <div>
      <div className="mb-6 border-b border-gray-200 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold text-navy">Admin</h1>
          <p className="text-xs text-gray-500">Signed in as {admin.email}</p>
        </div>
        <nav aria-label="Admin sections" className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
          {TABS.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              className="text-sm font-medium text-gray-600 hover:text-navy"
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </div>
      {children}
    </div>
  );
}
