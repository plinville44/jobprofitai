import { prisma } from "@/lib/prisma";
import { computeTrialState } from "@/lib/trial";
import { formatDate } from "@/lib/format";
import { AdminSection, AdminTable, Pill, Td } from "@/components/dashboard/AdminTable";

export const dynamic = "force-dynamic";

export default async function AdminTrialsPage() {
  const now = new Date();

  const subscriptions = await prisma.subscription.findMany({
    orderBy: { createdAt: "desc" },
    take: 300,
    include: { user: { select: { email: true, name: true } } },
  });

  const feedbackUserIds = new Set(
    (await prisma.trialFeedback.findMany({ select: { userId: true } })).map((f) => f.userId)
  );

  return (
    <AdminSection
      title="Trial accounts"
      description="Every account's trial state, activation and conversion. Ordered newest first."
    >
      <AdminTable
        headers={[
          "Account",
          "Status",
          "Trial ends",
          "Day",
          "QuickBooks",
          "First analysis",
          "Activated",
          "Extended",
          "Feedback",
        ]}
        empty={subscriptions.length === 0}
        minWidth={980}
      >
        {subscriptions.map((sub) => {
          const state = computeTrialState(sub, now);
          const user = sub.user;

          return (
            <tr key={sub.id}>
              <Td className="whitespace-nowrap font-medium text-navy">
                {user?.email ?? ", "}
                {user?.name ? (
                  <span className="block text-xs font-normal text-gray-500">{user.name}</span>
                ) : null}
              </Td>
              <Td>
                {sub.status === "active" ? (
                  <Pill tone="good">Paying &middot; {sub.plan === "profit_intelligence_pro" ? "Pro" : "$149"}</Pill>
                ) : state.onTrial ? (
                  <Pill tone="info">On trial</Pill>
                ) : sub.status === "past_due" || sub.status === "unpaid" ? (
                  <Pill tone="warn">{sub.status}</Pill>
                ) : sub.status === "canceled" ? (
                  <Pill tone="bad">Canceled</Pill>
                ) : (
                  <Pill>Trial ended</Pill>
                )}
              </Td>
              <Td className="whitespace-nowrap">
                {formatDate(sub.trialEndsAt)}
                {state.onTrial ? (
                  <span className="block text-xs text-gray-500">
                    {state.daysRemaining}d left
                  </span>
                ) : null}
              </Td>
              <Td>{state.dayNumber}</Td>
              <Td>
                {sub.quickbooksConnectedAt ? (
                  <Pill tone="good">Connected</Pill>
                ) : (
                  <Pill tone="bad">Not connected</Pill>
                )}
              </Td>
              <Td className="whitespace-nowrap">
                {sub.firstAnalysisAt ? formatDate(sub.firstAnalysisAt) : ", "}
              </Td>
              <Td>
                {sub.activatedAt ? <Pill tone="good">Yes</Pill> : <Pill>No</Pill>}
              </Td>
              <Td className="whitespace-nowrap">
                {sub.trialExtendedAt ? formatDate(sub.trialExtendedAt) : ", "}
              </Td>
              <Td>{feedbackUserIds.has(sub.userId) ? <Pill tone="good">Yes</Pill> : ", "}</Td>
            </tr>
          );
        })}
      </AdminTable>
    </AdminSection>
  );
}
