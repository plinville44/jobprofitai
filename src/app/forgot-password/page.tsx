"use client";

import { useState } from "react";
import Link from "next/link";
import { LogoLink } from "@/components/marketing/Logo";

/**
 * The success state here says "if an account exists" rather than "we sent
 * you an email", and it says so whether or not an account exists. That
 * matches what the API does, and the wording matters: a page that
 * confidently claims to have sent mail to an address with no account is both
 * a lie and a support ticket ("I never got it").
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col bg-jp-surface">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 py-12">
        <div className="mb-8 flex justify-center">
          <LogoLink width={220} priority />
        </div>

        <div className="rounded-xl border border-jp-line bg-white p-7 sm:p-8">
          {sent ? (
            <>
              <h1 className="text-xl font-bold text-jp-ink">Check your email</h1>
              <p className="mt-3 text-sm leading-relaxed text-jp-slate">
                If an account exists for <span className="font-medium">{email}</span>, a reset
                link is on its way. It works once and expires in an hour.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-jp-slate">
                Nothing after a few minutes? Check your spam folder, and confirm you used the
                address you signed up with.
              </p>
              <Link
                href="/login"
                className="mt-6 inline-block text-sm font-medium text-jp-blue hover:underline"
              >
                Back to log in
              </Link>
            </>
          ) : (
            <>
              <h1 className="text-xl font-bold text-jp-ink">Reset your password</h1>
              <p className="mt-2 text-sm leading-relaxed text-jp-slate">
                Enter the email address you signed up with and we&rsquo;ll send you a link to
                choose a new password.
              </p>

              <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-jp-ink">
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-jp-line px-3 py-2"
                  />
                </div>

                {error && <p className="text-sm text-red-700">{error}</p>}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-lg bg-jp-blue px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {loading ? "Sending..." : "Send reset link"}
                </button>
              </form>

              <p className="mt-6 text-center text-sm text-jp-slate">
                Remembered it?{" "}
                <Link href="/login" className="font-medium text-jp-blue hover:underline">
                  Log in
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
