import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import DashboardActions from "./DashboardActions";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { qbo_connected?: string; qbo_error?: string };
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const connections = await prisma.quickBooksConnection.findMany({
    where: { userId: session.userId, disconnectedAt: null },
    orderBy: { connectedAt: "desc" },
  });

  const latestDigest = connections[0]
    ? await prisma.weeklyDigest.findFirst({
        where: { connectionId: connections[0].id },
        orderBy: { weekStarting: "desc" },
      })
    : null;

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-bold text-navy">Dashboard</h1>

      {searchParams.qbo_connected && (
        <p className="mt-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800">
          QuickBooks connected. Click &quot;Sync now&quot; below to pull your job data.
        </p>
      )}
      {searchParams.qbo_error && (
        <p className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
          QuickBooks connection failed ({searchParams.qbo_error}). Try again below.
        </p>
      )}

      {connections.length === 0 ? (
        <div className="mt-8 rounded-xl border border-gray-200 p-8 text-center">
          <p className="text-gray-600">
            Connect your QuickBooks Online company to get your first digest.
          </p>
          <a
            href="/api/quickbooks/connect"
            className="mt-4 inline-block rounded-lg bg-brand px-5 py-2.5 font-semibold text-white hover:bg-blue-700"
          >
            Connect to QuickBooks
          </a>
        </div>
      ) : (
        <div className="mt-8">
          <div className="rounded-xl border border-gray-200 p-6">
            <p className="text-sm text-gray-500">Connected company</p>
            <p className="text-lg font-semibold text-navy">
              {connections[0].companyName ?? connections[0].realmId}
            </p>
            <p className="mt-1 text-xs text-gray-400">
              Cost tracking mode: {connections[0].costTrackingMode} · Last synced:{" "}
              {connections[0].lastSyncedAt?.toLocaleString() ?? "never"}
            </p>
            <DashboardActions connectionId={connections[0].id} />
          </div>

          {latestDigest && (
            <div className="mt-6 rounded-xl border border-gray-200 p-6">
              <p className="text-sm text-gray-500">
                Digest for week of {latestDigest.weekStarting.toLocaleDateString()}
              </p>
              <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-navy">
                {latestDigest.narrative}
              </pre>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
