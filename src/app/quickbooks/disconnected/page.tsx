import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LogoLink } from "@/components/marketing/Logo";
import { TRADEMARK_NOTICE } from "@/components/marketing/trademark";
import { getAccount, listCompanies } from "@/lib/account";
import { hashRealmId, legacyHashRealmId } from "@/lib/crypto";
import { probeConnection } from "@/lib/quickbooksSync";
import { DISCONNECTED_RETENTION_DAYS } from "@/lib/dataRetention";

export const metadata: Metadata = {
  title: "Disconnected from QuickBooks",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

const PROBE_TIMEOUT_MS = 8_000;

/**
 * The Disconnect URL in Intuit's app settings: where someone lands after
 * disconnecting JobProfitAI from inside QuickBooks (the Apps tab, or the
 * App Store's My Apps).
 *
 * Intuit has already revoked our access by then. If they're signed in
 * here, each of their companies (or just the one named by ?realmId=) is
 * checked with Intuit, and any Intuit reports as revoked is marked
 * disconnected now. The check only records what Intuit says, so visiting
 * this page can't disconnect anything that still works.
 *
 * Then straight into the app (Intuit's review, Nov 13, 2026: "redirect the
 * user directly into your application ... and the Connect to QuickBooks
 * button should be made visible inside your app"): the dashboard, which
 * says what was disconnected and shows Connect to QuickBooks
 * (?qbo_disconnected=1). Only if every company checked is still connected
 * (an old link, say) does it open the dashboard without that notice.
 *
 * The page is OpenID-enabled (Intuit's requirement 4.4): someone who isn't
 * signed in here goes through Intuit's sign-in first, which asks for nothing
 * if they're signed in to Intuit, and comes back signed in
 * (/api/auth/intuit?intent=disconnected). The way back carries sso=1, so a
 * sign-in that didn't take shows the signed-out version below instead of
 * going round again.
 */
export default async function DisconnectedPage(props: { searchParams: Promise<{ realmId?: string; sso?: string }> }) {
  const { realmId, sso } = await props.searchParams;
  const account = await getAccount();
  if (!account && sso !== "1") {
    const query = new URLSearchParams({ intent: "disconnected" });
    if (realmId && /^\d{1,32}$/.test(realmId)) query.set("realmId", realmId);
    redirect(`/api/auth/intuit?${query.toString()}`);
  }

  if (account) {
    const companies = await listCompanies(account);
    const hashes = realmId && /^\d{1,32}$/.test(realmId) ? [hashRealmId(realmId), legacyHashRealmId(realmId)] : null;
    const targets = (hashes ? companies.filter((c) => hashes.includes(c.realmIdHash)) : companies).slice(0, 5);
    const states = await Promise.all(
      targets.map((c) =>
        Promise.race([
          probeConnection(c.id).catch(() => "unknown" as const),
          new Promise<"unknown">((resolve) => setTimeout(() => resolve("unknown"), PROBE_TIMEOUT_MS)),
        ])
      )
    );
    const allStillConnected = states.length > 0 && states.every((s) => s === "ok");
    redirect(allStillConnected ? "/dashboard" : "/dashboard?qbo_disconnected=1");
  }

  // Signed out: Intuit's sign-in didn't bring them back signed in (sso=1),
  // for example an Intuit account not linked to any JobProfitAI login.

  return (
    <main className="flex min-h-screen flex-col bg-jp-surface">
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-5 py-12">
        <div className="mb-8 flex justify-center">
          <LogoLink width={220} priority />
        </div>
        <div className="rounded-xl border border-jp-line bg-white p-7 sm:p-8">
          <h1 className="text-xl font-bold text-navy">JobProfitAI is disconnected from QuickBooks</h1>
          <p className="mt-3 text-sm text-jp-slate">
            JobProfitAI can no longer read from that QuickBooks company. Syncing, its Weekly Profit Brief and all use
            of its data have stopped. Everything already in JobProfitAI (your jobs, estimates and reports) is kept for{" "}
            {DISCONNECTED_RETENTION_DAYS} days and comes back as it was if you reconnect in that time. After that it&apos;s
            deleted.
          </p>

          <h2 className="mt-6 text-sm font-semibold text-navy">To reconnect</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-jp-slate">
            <li>Sign in to JobProfitAI.</li>
            <li>On the dashboard or in Settings, choose Connect to QuickBooks.</li>
            <li>Sign in to Intuit and pick the company.</li>
          </ol>
          {/* Sign in with Intuit is on the login page only (Intuit's
              review, Nov 13, 2026). */}
          <div className="mt-5">
            <Link
              href="/login"
              className="inline-block rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
            >
              Log in to JobProfitAI
            </Link>
          </div>
          <p className="mt-6 text-xs text-jp-muted">
            Questions? Email{" "}
            <a href="mailto:support@jobprofitai.com" className="underline">
              support@jobprofitai.com
            </a>
            .
          </p>
        </div>
        <p className="mt-3 text-center text-xs text-jp-muted">{TRADEMARK_NOTICE}</p>
      </div>
    </main>
  );
}
