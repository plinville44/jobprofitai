import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import LogoutButton from "@/components/LogoutButton";
import FeedbackModal from "@/components/dashboard/FeedbackModal";

/**
 * Shared nav across every /dashboard/* page. Only links to pages that
 * actually exist ship here. Intelligence is always linked, even for
 * accounts without the entitlement - the page itself shows an upgrade
 * message rather than 404ing, per the "not a dead page" requirement in the
 * plan (see src/app/dashboard/intelligence/page.tsx).
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
              <Link href="/dashboard/data-health" className="text-sm font-medium text-gray-600 hover:text-navy">
                Data Health
              </Link>
              <Link href="/dashboard/intelligence" className="text-sm font-medium text-gray-600 hover:text-navy">
                Intelligence
              </Link>
              <Link href="/dashboard/settings" className="text-sm font-medium text-gray-600 hover:text-navy">
                Settings
              </Link>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <FeedbackModal />
            <LogoutButton />
          </div>
        </div>
      </nav>
      <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>
    </div>
  );
}
