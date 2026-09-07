import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { isAdminUser } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";
import LogoutButton from "@/components/LogoutButton";
import FeedbackModal from "@/components/dashboard/FeedbackModal";
import TrialBanner from "@/components/dashboard/TrialBanner";
import { Logo } from "@/components/marketing/Logo";

/**
 * Shared nav across every /dashboard/* page. Only links to pages that
 * actually exist ship here. Intelligence is always linked, even for
 * accounts without the entitlement - the page itself shows an upgrade
 * message rather than 404ing, per the "not a dead page" requirement.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const [isAdmin, partner] = await Promise.all([
    isAdminUser(session.userId),
    prisma.partner.findUnique({
      where: { userId: session.userId },
      select: { status: true },
    }),
  ]);

  return (
    <div className="min-h-screen bg-white">
      <nav className="border-b border-gray-200">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Link href="/dashboard" aria-label="JobProfitAI dashboard" className="inline-flex">
              <Logo width={150} priority />
            </Link>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <NavLink href="/dashboard">Dashboard</NavLink>
              <NavLink href="/dashboard/jobs">Jobs</NavLink>
              <NavLink href="/dashboard/data-health">Data Health</NavLink>
              <NavLink href="/dashboard/intelligence">Intelligence</NavLink>
              <NavLink href="/dashboard/referrals">Refer</NavLink>
              {/* Only surfaced once someone is actually in the partner
                  program - it's irrelevant clutter for a contractor. */}
              {partner ? <NavLink href="/dashboard/partner">Partner</NavLink> : null}
              <NavLink href="/dashboard/billing">Billing</NavLink>
              <NavLink href="/dashboard/settings">Settings</NavLink>
              {isAdmin ? <NavLink href="/dashboard/admin">Admin</NavLink> : null}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <FeedbackModal />
            <LogoutButton />
          </div>
        </div>
      </nav>

      {/* Trial countdown / billing status. Rendered server-side from the
          same entitlement source the access checks use, so what the banner
          says and what the app actually allows can't disagree. */}
      <TrialBanner userId={session.userId} />

      <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-sm font-medium text-gray-600 hover:text-navy">
      {children}
    </Link>
  );
}
