import type { Metadata } from "next";
import Link from "next/link";
import { LogoLink } from "@/components/marketing/Logo";
import { getSession } from "@/lib/auth";
import { verifyEmailToken, type VerifyOutcome } from "@/lib/emailVerification";
import { sendTrialWelcome } from "@/lib/email/lifecycle";
import ResendVerificationButton from "@/components/dashboard/ResendVerificationButton";

export const metadata: Metadata = {
  title: "Confirm your email",
  // The URL carries a live token. Kept out of indexes for the same reason
  // as /reset-password.
  robots: { index: false, follow: false },
};

// Verifies on load, so it must never be prerendered or cached.
export const dynamic = "force-dynamic";

/**
 * GET /verify-email?token=...
 *
 * Verifies on page load rather than asking for a button press. The usual
 * worry with that is mail scanners pre-fetching the link and spending the
 * token; verifyEmailToken reports a spent link on a verified account as a
 * success, so the customer's own click still lands on "You're confirmed".
 */
export default async function VerifyEmailPage(props: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await props.searchParams;
  const [result, session] = await Promise.all([
    verifyEmailToken(token ?? ""),
    getSession(),
  ]);

  // The welcome email used to go at signup. It now follows the first
  // successful verification, once, guarded by its own dedupe key.
  if (result.ok && result.firstTime) {
    try {
      await sendTrialWelcome(result.userId);
    } catch (err) {
      console.error("verify-email: welcome failed:", err instanceof Error ? err.message : "Unknown error");
    }
  }

  return (
    <main className="flex min-h-screen flex-col bg-jp-surface">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 py-12">
        <div className="mb-8 flex justify-center">
          <LogoLink width={220} priority />
        </div>
        <div className="rounded-xl border border-jp-line bg-white p-7 sm:p-8">
          <Outcome result={result} signedIn={Boolean(session)} />
        </div>
      </div>
    </main>
  );
}

function Outcome({ result, signedIn }: { result: VerifyOutcome; signedIn: boolean }) {
  const next = signedIn ? { href: "/dashboard", label: "Go to your dashboard" } : { href: "/login", label: "Log in" };

  if (result.ok) {
    return (
      <>
        <h1 className="text-xl font-bold text-jp-ink">Your email is confirmed</h1>
        <p className="mt-3 text-sm leading-relaxed text-jp-slate">
          {result.email} is verified. Your Weekly Profit Brief will be sent there on the day and
          time you choose in Settings.
        </p>
        <Link
          href={next.href}
          className="mt-6 inline-block rounded-lg bg-jp-blue px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          {next.label}
        </Link>
      </>
    );
  }

  const copy: Record<Extract<VerifyOutcome, { ok: false }>["reason"], { title: string; body: string }> = {
    expired: {
      title: "This link has expired",
      body: "Confirmation links last 48 hours. You can send yourself a new one.",
    },
    used: {
      title: "This link has already been used",
      body: "Each confirmation link works once. You can send yourself a new one.",
    },
    email_changed: {
      title: "This link is for a different address",
      body: "The email on your account has changed since this link was sent. Send a new link to the current address.",
    },
    invalid: {
      title: "We couldn't read this link",
      body: "It may have been cut off by your email app. Try clicking it again from the email, or send yourself a new one.",
    },
  };
  const { title, body } = copy[result.reason];

  return (
    <>
      <h1 className="text-xl font-bold text-jp-ink">{title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-jp-slate">{body}</p>
      <div className="mt-6">
        {signedIn ? (
          <ResendVerificationButton />
        ) : (
          <p className="text-sm text-jp-slate">
            <Link href="/login" className="font-medium text-jp-blue hover:underline">
              Log in
            </Link>{" "}
            and use the banner at the top of your dashboard to send a new link.
          </p>
        )}
      </div>
    </>
  );
}
