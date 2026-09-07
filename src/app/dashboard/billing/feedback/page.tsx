import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getTrialState } from "@/lib/trial";
import { TRIAL_EXTENSION_DAYS } from "@/lib/plans";
import TrialFeedbackForm from "./TrialFeedbackForm";

export const dynamic = "force-dynamic";

/**
 * The trial-extension feedback survey.
 *
 * Eligibility is resolved on the SERVER here, and again in the API route
 * that processes the submission, and finally by a unique database
 * constraint. Rendering the form is a convenience; it is not what decides
 * whether an extension is granted.
 */
export default async function TrialFeedbackPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const trial = await getTrialState(session.userId);

  if (!trial.extensionOffered) {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-bold text-navy">Trial extension</h1>
        <div className="mt-5 rounded-xl border border-gray-200 bg-white p-6">
          <p className="text-[15px] leading-relaxed text-gray-700">
            {trial.extensionClaimed
              ? "You've already used your one trial extension. Thanks again for the feedback."
              : (trial.extensionBlockedReason ??
                "The trial extension isn't available on this account.")}
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              href="/dashboard/billing"
              className="rounded-lg bg-navy px-5 py-2.5 text-sm font-semibold text-white hover:bg-gray-800"
            >
              View plans
            </Link>
            <Link
              href="/dashboard"
              className="rounded-lg border border-gray-300 px-5 py-2.5 text-sm font-semibold text-navy hover:border-brand hover:text-brand"
            >
              Back to dashboard
            </Link>
          </div>
        </div>

        <p className="mt-4 text-sm text-gray-500">
          Want to send feedback anyway? Use the feedback button in the top bar, or email{" "}
          <a href="mailto:support@jobprofitai.com" className="font-medium text-brand hover:underline">
            support@jobprofitai.com
          </a>
          . We read all of it.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold text-navy">Want another 14 days free?</h1>
      <p className="mt-2 text-[15px] leading-relaxed text-gray-600">
        Help us improve JobProfitAI. Complete this short 5-minute feedback survey and we&rsquo;ll
        extend your full-access trial another {TRIAL_EXTENSION_DAYS} days.
      </p>

      <div className="mt-5 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3.5">
        <p className="text-sm leading-relaxed text-gray-700">
          <strong className="text-navy">No testimonial required.</strong> This is not a review
          request and nothing you write here will be quoted publicly. We want honest answers,
          including the critical ones, which are the useful ones.
        </p>
      </div>

      <div className="mt-7 rounded-xl border border-gray-200 bg-white p-6 sm:p-7">
        <TrialFeedbackForm
          wouldEndAt={trial.extensionWouldEndAt ? trial.extensionWouldEndAt.toISOString() : null}
        />
      </div>
    </div>
  );
}
