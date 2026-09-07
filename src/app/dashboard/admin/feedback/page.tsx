import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/format";
import { AdminSection } from "@/components/dashboard/AdminTable";

export const dynamic = "force-dynamic";

/**
 * Trial-extension survey responses.
 *
 * This is the whole point of the extension offer: honest answers about what's
 * working and what isn't, from people who used the product for two weeks and
 * hadn't yet decided to pay. Worth reading in full rather than counting.
 */
export default async function AdminFeedbackPage() {
  const [responses, productFeedback] = await Promise.all([
    prisma.trialFeedback.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { user: { select: { email: true } } },
    }),
    prisma.feedback.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
  ]);

  return (
    <div className="space-y-6">
      <AdminSection
        title="Trial feedback survey"
        description="Submitted in exchange for the one-time 14-day trial extension. Never a testimonial request."
      >
        {responses.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-500">No responses yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {responses.map((r) => (
              <li key={r.id} className="px-5 py-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold text-navy">{r.user?.email ?? "unknown"}</p>
                  <p className="text-xs text-gray-500">
                    {formatDate(r.createdAt)} &middot; +{r.daysGranted}d &rarr;{" "}
                    {formatDate(r.newTrialEndsAt)}
                  </p>
                </div>
                <dl className="mt-3 space-y-3 text-sm">
                  {[
                    ["Most valuable", r.mostValuable],
                    ["Confusing or difficult", r.confusing],
                    ["Wish it showed", r.wishItShowed],
                    ["Would make it worth paying for", r.worthPayingFor],
                    ["Anything else", r.anythingElse],
                  ].map(([label, value]) =>
                    value ? (
                      <div key={label as string}>
                        <dt className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                          {label}
                        </dt>
                        <dd className="mt-0.5 whitespace-pre-wrap leading-relaxed text-gray-700">
                          {value}
                        </dd>
                      </div>
                    ) : null
                  )}
                </dl>
              </li>
            ))}
          </ul>
        )}
      </AdminSection>

      <AdminSection
        title="In-app product feedback"
        description="Submitted from the feedback button inside the app."
      >
        {productFeedback.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-500">No feedback yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {productFeedback.map((f) => (
              <li key={f.id} className="px-5 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold text-navy">
                    {f.category}, {f.userEmail}
                  </p>
                  <p className="text-xs text-gray-500">
                    {formatDate(f.createdAt)} &middot; {f.page} &middot; {f.plan}
                  </p>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                  {f.message}
                </p>
              </li>
            ))}
          </ul>
        )}
      </AdminSection>
    </div>
  );
}
