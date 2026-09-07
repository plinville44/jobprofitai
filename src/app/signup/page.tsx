import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { LogoLink } from "@/components/marketing/Logo";
import SignupForm from "./SignupForm";

export const metadata: Metadata = {
  title: "Start your free trial",
  description:
    "Create a JobProfitAI account and start a 14-day free trial. No credit card required.",
  robots: { index: false, follow: true },
};

/**
 * The form is a separate client component because it reads search params
 * (`?ref=1`, `?partner=1`). Next.js requires a Suspense boundary around
 * useSearchParams, or the whole route is forced out of static rendering.
 */
export default function SignupPage() {
  return (
    <main className="flex min-h-screen flex-col bg-jp-surface">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 py-12">
        <div className="mb-8 flex justify-center">
          <LogoLink width={220} priority />
        </div>

        <div className="rounded-xl border border-jp-line bg-white p-7 sm:p-8">
          <Suspense
            fallback={
              <div className="space-y-4" aria-hidden="true">
                <div className="h-7 w-2/3 animate-pulse rounded bg-jp-surface-2" />
                <div className="h-4 w-1/2 animate-pulse rounded bg-jp-surface-2" />
                <div className="h-24 animate-pulse rounded bg-jp-surface-2" />
              </div>
            }
          >
            <SignupForm />
          </Suspense>
        </div>

        <p className="mt-6 text-center text-xs text-jp-muted">
          <Link href="/" className="hover:text-jp-blue">
            &larr; Back to jobprofitai.com
          </Link>
        </p>
      </div>
    </main>
  );
}
