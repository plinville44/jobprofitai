import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import LogoutButton from "@/components/LogoutButton";

/**
 * Shared nav across every /dashboard/* page. Only links to pages that
 * actually exist ship here - Data Health, Intelligence, and Settings get
 * added to this nav as their own phases land (see the 4-week-launch-plan
 * project doc), rather than linking to pages that would 404 today.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="min-h-screen bg-white">
      <nav className="border-b border-gray-200">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="text-lg font-bold text-navy">
              JobProfitAI
            </Link>
            <div className="flex items-center gap-4">
              <Link href="/dashboard" className="text-sm font-medium text-gray-600 hover:text-navy">
                Dashboard
              </Link>
              <Link href="/dashboard/jobs" className="text-sm font-medium text-gray-600 hover:text-navy">
                Jobs
              </Link>
            </div>
          </div>
          <LogoutButton />
        </div>
      </nav>
      <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>
    </div>
  );
}
