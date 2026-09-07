import Link from "next/link";
import { getEntitlements } from "@/lib/entitlements";
import { getTrialState } from "@/lib/trial";
import { formatDate } from "@/lib/format";

/**
 * Persistent trial / billing status strip across the top of the app.
 *
 * Shows what's true and what to do about it, and nothing more. There is
 * deliberately no ticking countdown clock, no "only 4 hours left!", and no
 * colour that escalates by the hour - a business tool that manufactures
 * urgency about its own billing is a business tool people stop trusting
 * about everything else. Days remaining and a date are enough.
 */
export default async function TrialBanner({ userId }: { userId: string }) {
  const [entitlements, trial] = await Promise.all([
    getEntitlements(userId),
    getTrialState(userId),
  ]);

  // Paid and healthy - no banner at all.
  if (entitlements.access === "active" && !entitlements.cancelAtPeriodEnd) return null;

  if (entitlements.paymentIssue) {
    return (
      <Strip tone="warning">
        <span>
          Your last payment didn&rsquo;t go through. Your account is still active while we retry
. Updating your card avoids any interruption.
        </span>
        <BannerLink href="/dashboard/billing">Update payment method</BannerLink>
      </Strip>
    );
  }

  if (entitlements.access === "trial_expired" || entitlements.access === "canceled") {
    return (
      <Strip tone="critical">
        <span>
          {entitlements.access === "trial_expired"
            ? "Your free trial has ended. Choose a plan to turn your profit intelligence back on."
            : "Your subscription is inactive. Choose a plan to restore access."}
        </span>
        <BannerLink href="/dashboard/billing">Choose Your Plan</BannerLink>
      </Strip>
    );
  }

  if (entitlements.cancelAtPeriodEnd && entitlements.currentPeriodEnd) {
    return (
      <Strip tone="warning">
        <span>
          Your subscription is set to cancel on {formatDate(entitlements.currentPeriodEnd)}. You keep
          full access until then.
        </span>
        <BannerLink href="/dashboard/billing">Manage billing</BannerLink>
      </Strip>
    );
  }

  if (trial.onTrial) {
    const urgent = trial.daysRemaining <= 3;
    return (
      <Strip tone={urgent ? "warning" : "info"}>
        <span>
          <strong>
            {trial.daysRemaining} {trial.daysRemaining === 1 ? "day" : "days"} remaining
          </strong>{" "}
          in your free trial. Full access through {formatDate(trial.trialEndsAt)}.
        </span>
        {trial.extensionOffered ? (
          <BannerLink href="/dashboard/billing/feedback">Get 14 More Days Free</BannerLink>
        ) : (
          <BannerLink href="/dashboard/billing">
            {urgent ? "Choose Your Plan" : "View plans"}
          </BannerLink>
        )}
      </Strip>
    );
  }

  return null;
}

function Strip({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "info" | "warning" | "critical";
}) {
  const tones = {
    info: "border-blue-200 bg-blue-50 text-blue-900",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    critical: "border-red-200 bg-red-50 text-red-900",
  } as const;

  return (
    <div className={`border-b ${tones[tone]}`}>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-2.5 text-sm">
        {children}
      </div>
    </div>
  );
}

function BannerLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="shrink-0 rounded-md bg-white/70 px-3 py-1.5 text-sm font-semibold underline-offset-2 hover:underline"
    >
      {children}
    </Link>
  );
}
