import { redirect } from "next/navigation";
import Link from "next/link";
import { getAccount, getActiveConnection } from "@/lib/account";
import CompanySwitcher from "@/components/dashboard/CompanySwitcher";
import { isAdminUser } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";
import LogoutButton from "@/components/LogoutButton";
import FeedbackModal from "@/components/dashboard/FeedbackModal";
import TrialBanner from "@/components/dashboard/TrialBanner";
import { Logo } from "@/components/marketing/Logo";
import ResendVerificationButton from "@/components/dashboard/ResendVerificationButton";

/**
 * Shared nav across every /dashboard/* page. Only links to pages that
 * actually exist ship here. Intelligence is always linked, even for
 * accounts without the entitlement - the page itself shows an upgrade
 * message rather than 404ing, per the "not a dead page" requirement.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const account = await getAccount();
  if (!account) redirect("/login");

  const [isAdmin, partner, user, { connection: activeCompany, companies }] = await Promise.all([
    isAdminUser(account.userId),
    prisma.partner.findUnique({
      where: { userId: account.userId },
      select: { status: true },
    }),
    prisma.user.findUnique({
      where: { id: account.userId },
      select: { email: true, emailVerifiedAt: true },
    }),
    getActiveConnection(account.ownerId),
  ]);

  return (
    <div className="min-h-screen bg-white">
      <nav className="border-b border-gray-200">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Link href="/dashboard" aria-label="JobProfitAI dashboard" className="inline-flex">
              <Logo width={176} priority />
            </Link>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <NavLink href="/dashboard">Dashboard</NavLink>
              <NavLink href="/dashboard/jobs">Jobs</NavLink>
              <NavLink href="/dashboard/wip">WIP</NavLink>
              <NavLink href="/dashboard/data-health">Data Health</NavLink>
              <NavLink href="/dashboard/intelligence">Intelligence</NavLink>
              {account.role === "owner" ? <NavLink href="/dashboard/referrals">Refer</NavLink> : null}
              {/* Only surfaced once someone is actually in the partner
                  program - it's irrelevant clutter for a contractor. */}
              {partner ? <NavLink href="/dashboard/partner">Partner</NavLink> : null}
              <NavLink href="/dashboard/billing">Billing</NavLink>
              <NavLink href="/dashboard/settings">Settings</NavLink>
              {isAdmin ? <NavLink href="/dashboard/admin">Admin</NavLink> : null}
            </div>
          </div>
          <div className="flex items-center gap-4">
            {companies.length > 1 && activeCompany ? (
              <CompanySwitcher
                companies={companies.map((c) => ({ id: c.id, name: c.companyName ?? "Unnamed company" }))}
                activeId={activeCompany.id}
              />
            ) : null}
            <FeedbackModal />
            <LogoutButton />
          </div>
        </div>
      </nav>

      {/* Trial countdown / billing status. Rendered server-side from the
          same entitlement source the access checks use, so what the banner
          says and what the app actually allows can't disagree. */}
      <TrialBanner userId={account.ownerId} />

      {/* Shown on every dashboard page until the address is confirmed, and
          it says the one consequence that matters to the customer. */}
      {user && !user.emailVerifiedAt ? (
        <div className="border-b border-amber-200 bg-amber-50">
          <p className="mx-auto max-w-6xl px-6 py-2.5 text-sm text-amber-900">
            {/* Doesn't claim a link was sent: accounts created before
                verification existed never received one. */}
            <strong className="font-semibold">Confirm your email address, {user.email}.</strong>{" "}
            Your Weekly Profit Brief isn&apos;t sent until you do.{" "}
            <ResendVerificationButton compact />
          </p>
        </div>
      ) : null}

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
