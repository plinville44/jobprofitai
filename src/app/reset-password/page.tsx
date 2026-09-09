import { Suspense } from "react";
import type { Metadata } from "next";
import { LogoLink } from "@/components/marketing/Logo";
import ResetPasswordForm from "./ResetPasswordForm";

export const metadata: Metadata = {
  title: "Reset your password",
  // A reset URL carries a live credential in its query string. Keeping it
  // out of search indexes is the least we can do; the token also expires in
  // an hour and burns on first use, which is the part that actually protects
  // the account.
  robots: { index: false, follow: false },
};

export default function ResetPasswordPage() {
  return (
    <main className="flex min-h-screen flex-col bg-jp-surface">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 py-12">
        <div className="mb-8 flex justify-center">
          <LogoLink width={220} priority />
        </div>

        {/* useSearchParams needs a Suspense boundary to prerender, same as
            the signup page's referral-code handling. */}
        <Suspense
          fallback={
            <div className="rounded-xl border border-jp-line bg-white p-7 sm:p-8">
              <p className="text-sm text-jp-slate">Checking your link...</p>
            </div>
          }
        >
          <ResetPasswordForm />
        </Suspense>
      </div>
    </main>
  );
}
