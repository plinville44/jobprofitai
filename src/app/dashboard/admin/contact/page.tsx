import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/format";
import { AdminSection, Pill } from "@/components/dashboard/AdminTable";

export const dynamic = "force-dynamic";

/**
 * Contact form submissions.
 *
 * Every one of these was also emailed to CONTACT_TO_EMAIL. This view exists
 * because email delivery can fail - and when it does, the row's emailError is
 * the only place the lead still exists. Anything flagged "not delivered"
 * needs following up by hand.
 */
export default async function AdminContactPage() {
  const submissions = await prisma.contactSubmission.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const undelivered = submissions.filter((s) => !s.emailDeliveredAt).length;

  return (
    <div className="space-y-4">
      {undelivered > 0 ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-4">
          <p className="text-sm text-amber-900">
            <strong>{undelivered} submission(s) were stored but not emailed.</strong> They&rsquo;re
            safe here, but nobody was notified. Follow these up directly.
          </p>
        </div>
      ) : null}

      <AdminSection
        title="Contact submissions"
        description="Also emailed to the support inbox. Stored so a delivery failure never loses a lead."
      >
        {submissions.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-500">No submissions yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {submissions.map((s) => (
              <li key={s.id} className="px-5 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold text-navy">
                    {s.name}
                    {s.company ? `, ${s.company}` : ""}
                  </p>
                  <div className="flex items-center gap-2">
                    <Pill tone="info">{s.reason}</Pill>
                    {s.emailDeliveredAt ? (
                      <Pill tone="good">emailed</Pill>
                    ) : (
                      <Pill tone="bad">not delivered</Pill>
                    )}
                    <span className="text-xs text-gray-500">{formatDate(s.createdAt)}</span>
                  </div>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  <a href={`mailto:${s.email}`} className="font-medium text-brand hover:underline">
                    {s.email}
                  </a>
                  {s.phone ? ` · ${s.phone}` : ""}
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                  {s.message}
                </p>
                {s.emailError ? (
                  <p className="mt-2 rounded bg-red-50 px-3 py-2 text-xs text-red-700">
                    Delivery error: {s.emailError}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </AdminSection>
    </div>
  );
}
