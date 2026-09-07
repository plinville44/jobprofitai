"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

const inputClass =
  "w-full rounded-lg border border-jp-line bg-white px-3.5 py-2.5 text-[15px] text-jp-ink shadow-sm outline-none transition-colors placeholder:text-jp-muted focus:border-jp-blue focus:ring-2 focus:ring-jp-blue/20";

export default function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // `ref=1` is set by the /r/[code] landing route. The code itself stays in
  // an httpOnly cookie and is never exposed to this component - all we do
  // here is acknowledge the referral so the visitor knows it registered.
  const referred = searchParams.get("ref") === "1";
  const partnerIntent = searchParams.get("partner") === "1";

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name: name.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The API returns either a plain string error or a Zod flatten() shape.
        const message =
          typeof data.error === "string"
            ? data.error
            : (data.error?.fieldErrors?.password?.[0] ??
              data.error?.fieldErrors?.email?.[0] ??
              data.error?.formErrors?.[0] ??
              "We couldn't create your account. Please try again.");
        throw new Error(message);
      }
      // Partner applicants go straight to the application form.
      router.push(partnerIntent ? "/dashboard/partner" : "/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setLoading(false);
    }
  }

  return (
    <>
      <h1 className="text-2xl font-bold tracking-tight text-jp-ink">
        {partnerIntent ? "Create your partner account" : "Start your 14-day free trial"}
      </h1>
      <p className="mt-2 text-[15px] text-jp-slate">
        {partnerIntent
          ? "Create an account first, then submit your firm's application on the next screen."
          : "Full access for 14 days. No credit card required."}
      </p>

      {referred ? (
        <p className="mt-4 rounded-lg border border-jp-green/30 bg-green-50/60 px-4 py-3 text-sm text-jp-ink">
          You were referred to JobProfitAI. Your 14-day free trial is ready to go.
        </p>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-7 space-y-4">
        <div>
          <label htmlFor="signup-name" className="mb-1.5 block text-sm font-medium text-jp-ink">
            Name <span className="font-normal text-jp-muted">(optional)</span>
          </label>
          <input
            id="signup-name"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="signup-email" className="mb-1.5 block text-sm font-medium text-jp-ink">
            Email
          </label>
          <input
            id="signup-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="signup-password" className="mb-1.5 block text-sm font-medium text-jp-ink">
            Password
          </label>
          <input
            id="signup-password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />
          <p className="mt-1.5 text-xs text-jp-muted">At least 8 characters.</p>
        </div>

        {error ? (
          <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-jp-blue px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-jp-navy disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Creating your account…" : "Create account"}
        </button>

        <p className="text-center text-xs leading-relaxed text-jp-muted">
          By creating an account you agree to our{" "}
          <Link href="/terms" className="font-medium text-jp-blue hover:underline">
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="font-medium text-jp-blue hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
      </form>

      <p className="mt-7 text-center text-sm text-jp-slate">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-jp-blue hover:underline">
          Log in
        </Link>
      </p>
    </>
  );
}
