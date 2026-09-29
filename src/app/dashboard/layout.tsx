import { Fragment } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getAccount, getActiveConnection } from "@/lib/account";
import CompanySwitcher from "@/components/dashboard/CompanySwitcher";
import ActiveCompanyLabel from "@/components/dashboard/ActiveCompanyLabel";
import { getEntitlements, isAdminUser } from "@/lib/entitlements";
import { isOverPlanLimit } from "@/lib/planLimits";
import { syncProblemFor } from "@/lib/syncProblem";
import { removedAccessFor } from "@/lib/teamRemoval";
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

  const client = account.role === "client";
  const [isAdmin, partner, user, { connection: activeCompany, companies }, firm, entitlements, removed] = await Promise.all([
    isAdminUser(account.userId),
    prisma.partner.findUnique({
      where: { userId: account.userId },
      select: { status: true },
    }),
    prisma.user.findUnique({
      where: { id: account.userId },
      select: { email: true, emailVerifiedAt: true },
    }),
    getActiveConnection(account),
    client ? prisma.user.findUnique({ where: { id: account.ownerId }, select: { name: true, email: true } }) : null,
    getEntitlements(account.ownerId),
    // Someone whose team or client login was removed is the owner of their
    // own account now (accountFor), empty until they choose a plan. Every
    // page works as usual, Billing and deleting the login included, with a
    // plain line saying their access to the other account was removed.
    account.role === "owner" ? removedAccessFor(account.userId) : null,
  ]);

  // Whether the company on screen is being kept up to date. Only for a live
  // account: an inactive one sees the choose-a-plan screen instead.
  const syncProblem =
    activeCompany && entitlements.active
      ? syncProblemFor(activeCompany, { paused: await isOverPlanLimit(activeCompany), role: account.role })
      : null;
  const activeName = activeCompany?.companyName ?? "Unnamed company";

  return (
    <div className="min-h-screen bg-white">
      <nav className="border-b border-gray-200">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Link href="/dashboard" aria-label="JobProfitAI dashboard" className="inline-flex">
              <Logo width={176} priority />
            </Link>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {!client && companies.length > 1 ? <NavLink href="/dashboard/portfolio">Portfolio</NavLink> : null}
              <NavLink href="/dashboard">Dashboard</NavLink>
              <NavLink href="/dashboard/opportunities">Opportunities</NavLink>
              <NavLink href="/dashboard/estimates">Estimate Check</NavLink>
              <NavLink href="/dashboard/money-owed">Money Owed</NavLink>
              <NavLink href="/dashboard/jobs">Jobs</NavLink>
              <NavLink href="/dashboard/wip">WIP</NavLink>
              <NavLink href="/dashboard/data-health">Data Health</NavLink>
              {account.role === "owner" ? <NavLink href="/dashboard/referrals">Refer</NavLink> : null}
              {/* Only surfaced once someone is actually in the partner
                  program - it's irrelevant clutter for a contractor. */}
              {partner && !client ? <NavLink href="/dashboard/partner">Partner</NavLink> : null}
              {client ? null : <NavLink href="/dashboard/billing">Billing</NavLink>}
              <NavLink href="/dashboard/settings">Settings</NavLink>
              {isAdmin ? <NavLink href="/dashboard/admin">Admin</NavLink> : null}
            </div>
          </div>
          <div className="flex items-center gap-4">
            {companies.length > 1 && activeCompany ? (
              <CompanySwitcher
                key={activeCompany.id}
                companies={companies.map((c) => ({ id: c.id, name: c.companyName ?? "Unnamed company" }))}
                activeId={activeCompany.id}
              />
            ) : null}
            <FeedbackModal />
            <LogoutButton />
          </div>
        </div>
      </nav>

      {removed ? <RemovedAccessNotice ownerName={removed.ownerName} ownerEmail={removed.ownerEmail} /> : null}

      {/* Trial countdown / billing status. Rendered server-side from the
          same entitlement source the access checks use, so what the banner
          says and what the app actually allows can't disagree. */}
      {client ? (
        <div className="border-b border-blue-100 bg-blue-50">
          <p className="mx-auto max-w-6xl px-6 py-2.5 text-sm text-navy">
            View-only access to <strong>{activeCompany?.companyName ?? "your company"}</strong>, set up by{" "}
            {firm?.name ?? firm?.email ?? "your bookkeeper"}. They manage the QuickBooks connection and settings.
          </p>
        </div>
      ) : (
        <TrialBanner userId={account.ownerId} />
      )}

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

      {syncProblem ? (
        <div className={`border-b ${syncProblem.tone === "critical" ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"}`}>
          <p
            className={`mx-auto max-w-6xl px-6 py-2.5 text-sm ${syncProblem.tone === "critical" ? "text-red-900" : "text-amber-900"}`}
          >
            {syncProblem.message}
            {syncProblem.link ? (
              <>
                {" "}
                <Link href={syncProblem.link.href} className="font-semibold underline">
                  {syncProblem.link.label}
                </Link>
              </>
            ) : null}
          </p>
        </div>
      ) : null}

      <div className="mx-auto max-w-6xl px-6 py-8">
        {!client && companies.length > 1 && activeCompany ? <ActiveCompanyLabel name={activeName} /> : null}
        {/* Keyed by the company on screen: switching company starts every
            page fresh, so nothing a page was showing for one company (the
            first-sync progress, a sync result, a half-filled form) carries
            over to the next. */}
        <Fragment key={activeCompany?.id ?? "none"}>{children}</Fragment>
      </div>
    </div>
  );
}

/**
 * Shown to a login whose access to someone else's account was removed, until
 * it connects a company or pays for a plan of its own. It never names or
 * shows anything from that account beyond who owned it.
 */
function RemovedAccessNotice({ ownerName, ownerEmail }: { ownerName: string | null; ownerEmail: string | null }) {
  const who = ownerName ?? ownerEmail;
  return (
    <div className="border-b border-amber-200 bg-amber-50">
      <p className="mx-auto max-w-6xl px-6 py-2.5 text-sm text-amber-900">
        <strong className="font-semibold">
          Your access to the JobProfitAI account you were invited to{who ? ` by ${who}` : ""} was removed.
        </strong>{" "}
        This login now has its own account, which is empty. To use JobProfitAI for your own company, choose a plan on
        the{" "}
        <Link href="/dashboard/billing" className="font-semibold underline">
          Billing page
        </Link>
        . To close this login, delete it in{" "}
        <Link href="/dashboard/settings" className="font-semibold underline">
          Settings
        </Link>
        . If you think it&apos;s a mistake, ask the account owner to invite you again.
      </p>
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
