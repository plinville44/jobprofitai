"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LogoLink } from "@/components/marketing/Logo";
import { SignInWithIntuitButton } from "@/components/IntuitButtons";

const INTUIT_VERIFY_EMAIL_URL = "https://accounts.intuit.com/app/account-manager/security";

/**
 * Messages for ?notice= on the way back from Intuit or an expired link.
 * `link` is shown after the text.
 */
const NOTICES: Record<string, { text: string; link?: { href: string; label: string } }> = {
  intuit_unverified: {
    text: "Your Intuit account's email address isn't verified yet, so we can't sign you in with it. Verify it with Intuit, then try again.",
    link: { href: INTUIT_VERIFY_EMAIL_URL, label: "Verify your email with Intuit" },
  },
  intuit_failed: { text: "Signing in with Intuit didn't work that time. Please try again, or log in with your password." },
  intuit_session: { text: "That sign-in took too long or started in another browser. Please try again." },
  invalid_state: { text: "That link has expired. Please try again." },
  qbo_session: { text: "Log in again to finish connecting QuickBooks, then choose Connect to QuickBooks." },
};

/**
 * Where to go after logging in: a same-site path from ?next= (an
 * invitation link, say), or the dashboard. Anything that isn't a plain
 * path on this site is ignored, so the parameter can't be used to bounce
 * someone to another website after they sign in.
 */
function safeNext(): string {
  if (typeof window === "undefined") return "/dashboard";
  const next = new URLSearchParams(window.location.search).get("next");
  if (!next || !next.startsWith("/")) return "/dashboard";
  // Resolved the way the browser will resolve it (which drops tabs and
  // newlines, so "/\t/evil.com" becomes "//evil.com"), then kept only if
  // it is still on this site.
  try {
    const url = new URL(next, window.location.origin);
    const path = url.pathname + url.search + url.hash;
    // A path that still starts with "//" (from "/.//evil.com", say) would be
    // read as another site by the router.
    return url.origin === window.location.origin && !path.startsWith("//") ? path : "/dashboard";
  } catch {
    return "/dashboard";
  }
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<(typeof NOTICES)[string] | null>(null);

  useEffect(() => {
    const key = new URLSearchParams(window.location.search).get("notice");
    if (key && NOTICES[key]) setNotice(NOTICES[key]);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Login failed");
      }
      router.push(safeNext());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    // The logo is the way back to the marketing site. Without it this page
    // was a dead end: someone who clicked Log In from the homepage, then
    // wanted to read the pricing page again, had no route back except the
    // browser's back button or retyping the address.
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="mb-8 flex justify-center">
        <LogoLink width={200} priority />
      </div>

      <h1 className="text-2xl font-bold text-navy">Log in</h1>

      {notice && (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {notice.text}
          {notice.link && (
            <>
              {" "}
              <a href={notice.link.href} target="_blank" rel="noopener noreferrer" className="font-medium underline">
                {notice.link.label}
              </a>
            </>
          )}
        </div>
      )}

      <div className="mt-8 flex justify-center">
        <SignInWithIntuitButton />
      </div>
      <div className="mt-6 flex items-center gap-3 text-xs uppercase tracking-wide text-gray-400">
        <span className="h-px flex-1 bg-gray-200" />
        or with your password
        <span className="h-px flex-1 bg-gray-200" />
      </div>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-navy">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
          />
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <label className="block text-sm font-medium text-navy">Password</label>
            {/* Next to the field, not buried in the footer. Someone reaches
                for this at the exact moment their password fails, and the
                login error deliberately doesn't say which half was wrong, so
                the recovery route has to be visible without hunting. */}
            <Link href="/forgot-password" className="text-sm font-medium text-brand hover:underline">
              Forgot password?
            </Link>
          </div>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
          />
        </div>
        {error && <p className="text-sm text-red-700">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-brand px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Logging in..." : "Log in"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-gray-600">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-medium text-brand">
          Start a free trial
        </Link>
      </p>

      <p className="mt-3 text-center text-sm text-gray-500">
        <Link href="/" className="hover:underline">
          Back to jobprofitai.com
        </Link>
      </p>
    </main>
  );
}
