import { prisma } from "@/lib/prisma";
import { listCompanies, type AccountContext } from "@/lib/account";
import { CLIENT_LOGINS_PER_COMPANY } from "@/lib/plans";
import { getEntitlements } from "@/lib/entitlements";
import { listTeam } from "@/lib/team";
import TeamManager from "./TeamManager";

/**
 * Team logins. The owner sees the list and can invite or remove people; a
 * team member sees whose account they are in.
 */
export default async function TeamSection({
  account,
  activeConnectionId = null,
}: {
  account: AccountContext;
  /** The company on screen: the client login form starts on it. */
  activeConnectionId?: string | null;
}) {
  if (account.role !== "owner") {
    const owner = await prisma.user.findUnique({
      where: { id: account.ownerId },
      select: { name: true, email: true },
    });
    return (
      <section className="mt-10 rounded-xl border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-navy">Team</h2>
        <p className="mt-1 text-sm text-gray-600">
          You&apos;re a team member on {owner?.name ? `${owner.name}'s` : "this"} account
          {owner?.email ? ` (${owner.email})` : ""}. The owner manages billing and who has access.
        </p>
      </section>
    );
  }

  const [rows, entitlements, companies] = await Promise.all([
    listTeam(account.ownerId),
    getEntitlements(account.ownerId),
    listCompanies(account),
  ]);
  const members = rows.filter((r) => r.role !== "client");
  const clients = rows.filter((r) => r.role === "client");
  const companyName = new Map(companies.map((c) => [c.id, c.companyName ?? "Unnamed company"]));
  const view = (r: (typeof rows)[number]) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    status: r.status,
    invitedAt: r.invitedAt.toISOString(),
    connectionId: r.connectionId,
    companyName: r.connectionId ? companyName.get(r.connectionId) ?? null : null,
  });
  const canClient = entitlements.has("client_logins");
  return (
    <>
      <section className="mt-10 rounded-xl border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-navy">Team</h2>
        <p className="mt-1 text-sm text-gray-600">
          Give your office manager, project managers or bookkeeper their own login. They see the same companies and
          reports you do. Billing, this team list and deleting the account stay with you. Your plan includes{" "}
          {entitlements.limits.maxTeamMembers} team logins.
        </p>
        <TeamManager rows={members.map(view)} canInvite={entitlements.active} />
      </section>

      {canClient || clients.length > 0 ? (
        <section className="mt-6 rounded-xl border border-gray-200 p-6" id="client-logins">
          <h2 className="text-sm font-semibold text-navy">Client logins</h2>
          <p className="mt-1 text-sm text-gray-600">
            Give each contractor you keep books for a view-only login to their own company. They see its dashboard,
            jobs, opportunities, Estimate Check, Money Owed, Data Health and the WIP report. They don&apos;t see your
            other clients, your settings or billing, and they can&apos;t change anything. Up to{" "}
            {CLIENT_LOGINS_PER_COMPANY} per company, on top of your team logins.
          </p>
          {/* The list always shows, so a login can be removed even when no
              company is connected. */}
          <TeamManager
            // A fresh form when the company on screen changes, so it never
            // keeps pointing at the company that was showing before.
            key={activeConnectionId ?? "none"}
            rows={clients.map(view)}
            canInvite={entitlements.active && canClient && companies.length > 0}
            companies={companies.map((c) => ({ id: c.id, name: c.companyName ?? "Unnamed company" }))}
            activeCompanyId={activeConnectionId}
          />
          {companies.length === 0 ? (
            <p className="mt-4 text-sm text-gray-500">Connect a client&apos;s QuickBooks company to invite them.</p>
          ) : null}
          {!canClient ? (
            <p className="mt-3 text-xs text-gray-500">
              Client logins are part of the Firm plan. Existing ones can&apos;t see anything until the account is on it.
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
