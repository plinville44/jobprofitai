import { prisma } from "@/lib/prisma";
import type { AccountContext } from "@/lib/account";
import { getEntitlements } from "@/lib/entitlements";
import { listTeam } from "@/lib/team";
import TeamManager from "./TeamManager";

/**
 * Team logins. The owner sees the list and can invite or remove people; a
 * team member sees whose account they are in.
 */
export default async function TeamSection({ account }: { account: AccountContext }) {
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

  const [rows, entitlements] = await Promise.all([listTeam(account.ownerId), getEntitlements(account.ownerId)]);
  return (
    <section className="mt-10 rounded-xl border border-gray-200 p-6">
      <h2 className="text-sm font-semibold text-navy">Team</h2>
      <p className="mt-1 text-sm text-gray-600">
        Give your office manager, project managers or bookkeeper their own login. They see the same companies and
        reports you do. Billing, this team list and deleting the account stay with you. Your plan includes{" "}
        {entitlements.limits.maxTeamMembers} team logins.
      </p>
      <TeamManager
        rows={rows.map((r) => ({
          id: r.id,
          email: r.email,
          name: r.name,
          status: r.status,
          invitedAt: r.invitedAt.toISOString(),
        }))}
        canInvite={entitlements.active}
      />
    </section>
  );
}
