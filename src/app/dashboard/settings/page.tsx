import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { decryptToken } from "@/lib/crypto";
import { StatusDot } from "@/components/dashboard/Badges";
import { formatDateTime } from "@/lib/format";
import SettingsForm from "./SettingsForm";
import ConnectionActions from "./ConnectionActions";
import DeleteAccountForm from "./DeleteAccountForm";
import { needsReconnect } from "@/lib/quickbooks";

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

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const connection = await prisma.quickBooksConnection.findFirst({
    where: { userId: session.userId, disconnectedAt: null },
    orderBy: { connectedAt: "desc" },
  });

  return (
    <main>
      <h1 className="text-2xl font-bold text-navy">Settings</h1>

      {!connection ? (
        <div className="mt-8 rounded-xl border border-gray-200 p-8 text-center">
          <p className="text-gray-600">Connect your QuickBooks Online company to configure settings.</p>
          <a
            href="/api/quickbooks/connect"
            className="mt-4 inline-block rounded-lg bg-brand px-5 py-2.5 font-semibold text-white hover:bg-blue-700"
          >
            Connect to QuickBooks
          </a>
        </div>
      ) : (
        <>
          <section className="mt-6 rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-navy">QuickBooks Connection</h2>
            <p className="mt-2 text-lg font-semibold text-navy">
              {connection.companyName ?? decryptToken(connection.realmId)}
            </p>
            <div className="mt-3 flex items-center gap-2 text-sm text-gray-600">
              <StatusDot status={connection.lastSyncStatus ? SYNC_STATUS_DOT[connection.lastSyncStatus] ?? "unmeasured" : "unmeasured"} />
              <span>
                {connection.lastSyncStatus ? SYNC_STATUS_LABEL[connection.lastSyncStatus] ?? connection.lastSyncStatus : "Not synced yet"}
                {connection.lastSyncAttemptAt ? ` · ${formatDateTime(connection.lastSyncAttemptAt, connection.emailTimezone)}` : ""}
              </span>
            </div>
            {connection.lastSyncStatus === "error" && connection.lastSyncError && (
              <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{connection.lastSyncError}</p>
            )}
            {needsReconnect(connection.lastSyncError) ? (
              <a
                href={`/api/quickbooks/connect?reconnect=${connection.id}`}
                className="mt-3 inline-block rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
              >
                Reconnect QuickBooks
              </a>
            ) : null}
            <p className="mt-1 text-xs text-gray-400">
              Last successful sync:{" "}
              {connection.lastSyncedAt ? formatDateTime(connection.lastSyncedAt, connection.emailTimezone) : "never"}
            </p>
            <ConnectionActions connectionId={connection.id} />
          </section>

          <div className="mt-8">
            <SettingsForm
              connectionId={connection.id}
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
              }}
            />
          </div>
        </>
      )}

      {/* Outside the connection branch: an account with nothing connected
          can still be deleted. */}
      <section className="mt-10 rounded-xl border border-red-100 p-6">
        <h2 className="text-sm font-semibold text-navy">Delete account</h2>
        <p className="mt-1 text-sm text-gray-600">
          Permanently remove your JobProfitAI account and all of its data.
        </p>
        <div className="mt-4">
          <DeleteAccountForm />
        </div>
      </section>
    </main>
  );
}
