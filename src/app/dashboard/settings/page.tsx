import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getAccount, getActiveConnection } from "@/lib/account";
import { canConnectAnotherCompany, getEntitlements } from "@/lib/entitlements";
import { connectNeedsOwner, OWNER_ONLY_CONNECT_MESSAGE, OWNER_ONLY_CONNECT_NOTICE } from "@/lib/connectCompany";
import { StatusDot } from "@/components/dashboard/Badges";
import { formatDateTime } from "@/lib/format";
import SettingsForm from "./SettingsForm";
import ConnectionActions from "./ConnectionActions";
import DeleteAccountForm from "./DeleteAccountForm";
import CategoryMappingForm from "./CategoryMappingForm";
import SignOutEverywhereButton from "./SignOutEverywhereButton";
import UnlinkIntuitButton from "./UnlinkIntuitButton";
import SwitchCompanyButton from "./SwitchCompanyButton";
import TeamSection from "./TeamSection";
import JobTypesManager from "./JobTypesManager";
import { getJobTypes } from "@/lib/jobTypesServer";
import { needsReconnect } from "@/lib/quickbooks";
import { ConnectToQuickBooksButton } from "@/components/IntuitButtons";

const SYNC_STATUS_DOT: Record<string, "good" | "warning" | "critical" | "unmeasured"> = {
  success: "good",
  in_progress: "warning",
  error: "critical",
};

const SYNC_STATUS_LABEL: Record<string, string> = {
  success: "Last sync succeeded",
  in_progress: "Sync in progress",
  error: "Last sync failed",
};

export default async function SettingsPage(props: {
  // Next.js 16: searchParams arrives as a Promise.
  searchParams: Promise<{ notice?: string }>;
}) {
  const { notice } = await props.searchParams;
  const account = await getAccount();
  if (!account) redirect("/login");
  const isOwner = account.role === "owner";
  // A client's view-only login has no company settings, only its own login.
  if (account.role === "client") {
    const self = await prisma.user.findUnique({ where: { id: account.userId }, select: { intuitSub: true } });
    return (
      <main>
        <h1 className="text-2xl font-bold text-navy">Settings</h1>
        <p className="mt-2 text-sm text-gray-600">
          This is a view-only login. Your bookkeeper manages the QuickBooks connection and the company&apos;s settings.
        </p>
        {personalSections(false, Boolean(self?.intuitSub))}
      </main>
    );
  }

  // The company picked in the company switcher (see src/lib/account.ts).
  // Settings below the companies list apply to that company only.
  const { connection, companies } = await getActiveConnection(account);
  const [permission, entitlements] = await Promise.all([
    canConnectAnotherCompany(account.ownerId),
    getEntitlements(account.ownerId),
  ]);
  // On a paid Firm plan each company is billed, so only the owner adds one.
  const ownerOnlyConnect = !isOwner && connectNeedsOwner(entitlements);
  const firmBilled = connectNeedsOwner(entitlements);
  // Client logins (active or invited) per company, for the disconnect warning.
  const clientLogins = new Map<string, number>();
  if (isOwner && companies.length > 0) {
    const now = new Date();
    const rows = await prisma.teamMember.findMany({
      where: { ownerUserId: account.ownerId, role: "client", connectionId: { in: companies.map((c) => c.id) } },
      select: { connectionId: true, acceptedAt: true, expiresAt: true },
    });
    for (const r of rows) {
      if (!r.connectionId || (!r.acceptedAt && r.expiresAt.getTime() <= now.getTime())) continue;
      clientLogins.set(r.connectionId, (clientLogins.get(r.connectionId) ?? 0) + 1);
    }
  }
  const me = await prisma.user.findUnique({ where: { id: account.userId }, select: { intuitSub: true } });
  const marginTargets = connection
    ? await prisma.marginTarget.findMany({ where: { connectionId: connection.id } })
    : [];
  const jobTypes = connection ? await getJobTypes(connection.id) : [];
  const jobTypeCounts = new Map(
    connection
      ? (
          await prisma.job.groupBy({
            by: ["category"],
            where: { connectionId: connection.id, missingSince: null, category: { not: null } },
            _count: { _all: true },
          })
        ).map((g) => [g.category as string, g._count._all])
      : []
  );

  return (
    <main>
      <h1 className="text-2xl font-bold text-navy">Settings</h1>

      {notice === OWNER_ONLY_CONNECT_NOTICE ? (
        <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">{OWNER_ONLY_CONNECT_MESSAGE}</p>
      ) : null}

      {!connection ? (
        <div className="mt-8 rounded-xl border border-gray-200 p-8 text-center">
          {ownerOnlyConnect ? (
            <p className="text-gray-600">
              No QuickBooks company is connected. On the Firm plan the account owner connects companies.
            </p>
          ) : (
            <>
              <p className="text-gray-600">Connect your QuickBooks Online company to configure settings.</p>
              <div className="mt-4 flex justify-center">
                <ConnectToQuickBooksButton />
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          <section className="mt-6 rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-navy">
              QuickBooks {companies.length > 1 ? "companies" : "company"}
            </h2>
            <ul className="mt-3 divide-y divide-gray-100">
              {companies.map((c) => {
                const active = c.id === connection.id;
                return (
                  <li key={c.id} className="py-4 first:pt-1 last:pb-1">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-lg font-semibold text-navy">
                          {c.companyName ?? "QuickBooks company"}
                          {active && companies.length > 1 && (
                            <span className="ml-2 rounded-full bg-blue-50 px-2 py-0.5 align-middle text-xs font-medium text-brand">
                              Showing now
                            </span>
                          )}
                        </p>
                        <div className="mt-2 flex items-center gap-2 text-sm text-gray-600">
                          <StatusDot
                            status={c.lastSyncStatus ? SYNC_STATUS_DOT[c.lastSyncStatus] ?? "unmeasured" : "unmeasured"}
                          />
                          <span>
                            {c.lastSyncStatus ? SYNC_STATUS_LABEL[c.lastSyncStatus] ?? c.lastSyncStatus : "Not synced yet"}
                            {c.lastSyncAttemptAt ? ` · ${formatDateTime(c.lastSyncAttemptAt, c.emailTimezone)}` : ""}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-gray-400">
                          Last successful sync: {c.lastSyncedAt ? formatDateTime(c.lastSyncedAt, c.emailTimezone) : "never"}
                        </p>
                      </div>
                      {!active && <SwitchCompanyButton connectionId={c.id} />}
                    </div>
                    {c.lastSyncStatus === "error" && c.lastSyncError && (
                      <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{c.lastSyncError}</p>
                    )}
                    {needsReconnect(c.lastSyncError) && (
                      <div className="mt-3">
                        <ConnectToQuickBooksButton href={`/api/quickbooks/connect?reconnect=${c.id}`} />
                      </div>
                    )}
                    {isOwner && (
                      <ConnectionActions
                        connectionId={c.id}
                        companyName={c.companyName ?? "this company"}
                        clientLogins={clientLogins.get(c.id) ?? 0}
                        firmBilled={firmBilled}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="mt-4 border-t border-gray-100 pt-4 text-sm">
              {ownerOnlyConnect ? (
                <p className="text-gray-500">
                  On the Firm plan the monthly bill follows how many companies are connected, so the account owner
                  connects new ones.
                </p>
              ) : permission.allowed ? (
                <div>
                  <p className="mb-2 font-medium text-navy">Add another company</p>
                  <ConnectToQuickBooksButton />
                </div>
              ) : (
                <p className="text-gray-500">{permission.reason}</p>
              )}
            </div>
          </section>

          <p className="mt-8 text-xs text-gray-500">
            The settings below are for{" "}
            <span className="font-medium text-gray-700">{connection.companyName ?? "this company"}</span>
            {companies.length > 1 ? ". Each company has its own." : "."}
          </p>

          <div className="mt-3">
            <SettingsForm
              key={connection.id}
              connectionId={connection.id}
              jobTypes={jobTypes
                .filter((t) => !t.hidden || marginTargets.some((m) => m.category === t.value))
                .map((t) => ({ value: t.value, label: t.hidden ? `${t.label} (hidden)` : t.label }))}
              initial={{
                targetMarginPct: connection.targetMarginPct == null ? null : Number(connection.targetMarginPct),
                overheadEnabled: connection.overheadEnabled,
                overheadMethod: connection.overheadMethod as "pct_of_revenue" | "pct_of_direct_cost" | null,
                overheadValuePct: connection.overheadValue == null ? null : Number(connection.overheadValue) * 100,
                emailEnabled: connection.emailEnabled,
                emailRecipients: connection.emailRecipients,
                emailDay: connection.emailDay,
                emailHour: connection.emailHour,
                emailTimezone: connection.emailTimezone,
                jobSource: connection.jobSource === "customers" || connection.jobSource === "classes" ? connection.jobSource : "projects",
                laborFromTimeEntries: connection.laborFromTimeEntries,
                laborBurdenPct: connection.laborBurdenPct == null ? null : Number(connection.laborBurdenPct),
                alertsEnabled: connection.alertsEnabled,
                marginTargets: Object.fromEntries(marginTargets.map((t) => [t.category, Number(t.targetPct)])),
              }}
            />
          </div>

          <section id="job-types" className="mt-8 rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-navy">Job types</h2>
            <p className="mt-1 text-sm text-gray-600">
              Job type is how JobProfitAI compares like with like: your kitchen remodels against each other, not
              against a roof. Rename the built-in types, hide the ones you don&apos;t do, and add your own. Renaming never
              changes which jobs have a type.
            </p>
            <div className="mt-4">
              <JobTypesManager
                key={connection.id}
                connectionId={connection.id}
                types={jobTypes.map((t) => ({ ...t, jobs: jobTypeCounts.get(t.value) ?? 0 }))}
              />
            </div>
          </section>

          <section id="cost-categories" className="mt-8 rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-navy">Cost categories</h2>
            <p className="mt-1 text-sm text-gray-600">
              Costs are sorted into Labor, Materials, Subcontractors and so on from the QuickBooks account or product
              each one was posted to, and the lines on your estimates are sorted by their product or service the same
              way. If one lands in the wrong place, change it here; it applies to everything already synced.
            </p>
            <div className="mt-4">
              <CategoryMappingForm key={connection.id} connectionId={connection.id} />
            </div>
          </section>
        </>
      )}

      <TeamSection account={account} activeConnectionId={connection?.id ?? null} />

      {personalSections(isOwner, Boolean(me?.intuitSub))}
    </main>
  );
}

/** The signed-in person's own login: security, Intuit sign-in, deleting it. Every role sees these. */
function personalSections(isOwner: boolean, intuitLinked: boolean) {
  return (
    <>
      <section className="mt-10 rounded-xl border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-navy">Sign-in security</h2>
        <p className="mt-1 text-sm text-gray-600">
          Lost a phone, or signed in on a computer you no longer use? This signs your login out everywhere. You will
          need to sign in again here too.
        </p>
        <div className="mt-4">
          <SignOutEverywhereButton />
        </div>
        <div className="mt-6 border-t border-gray-100 pt-4">
          <h3 className="text-sm font-medium text-navy">Sign in with Intuit</h3>
          {intuitLinked ? (
            <>
              <p className="mt-1 text-sm text-gray-600">
                On. An Intuit account is linked to your login and can sign in without your password. Resetting your
                password turns this off too.
              </p>
              <div className="mt-3">
                <UnlinkIntuitButton />
              </div>
            </>
          ) : (
            <p className="mt-1 text-sm text-gray-600">
              Off. To turn it on, log out and choose Sign in with Intuit on the login page; you&apos;ll be asked for
              your password once to link it.
            </p>
          )}
        </div>
      </section>

      {/* Outside the connection branch: an account with nothing connected
          can still be deleted. */}
      <section className="mt-10 rounded-xl border border-red-100 p-6">
        <h2 className="text-sm font-semibold text-navy">{isOwner ? "Delete account" : "Delete your login"}</h2>
        <p className="mt-1 text-sm text-gray-600">
          {isOwner
            ? "Permanently remove your JobProfitAI account and all of its data, including every connected company and every team member's access."
            : "Permanently remove your own login. The account you were invited to, and its data, are not affected."}{" "}
          It asks for your password. If you only ever signed in with Intuit, set one first with Forgot password on the
          login page.
        </p>
        <div className="mt-4">
          <DeleteAccountForm />
        </div>
      </section>
    </>
  );
}
