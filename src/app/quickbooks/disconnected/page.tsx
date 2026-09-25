import type { Metadata } from "next";
import Link from "next/link";
import { LogoLink } from "@/components/marketing/Logo";
import { getAccount, listCompanies } from "@/lib/account";
import { hashRealmId, legacyHashRealmId } from "@/lib/crypto";
import { probeConnection } from "@/lib/quickbooksSync";
import { ConnectToQuickBooksButton, SignInWithIntuitButton } from "@/components/IntuitButtons";

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
 * disconnected now, so the dashboard shows the Connect button straight
 * away instead of at the next sync. The check only records what Intuit
 * says, so visiting this page can't disconnect anything that still works.
 */
export default async function DisconnectedPage(props: { searchParams: Promise<{ realmId?: string }> }) {
  const { realmId } = await props.searchParams;
  const account = await getAccount();

  let disconnected: string[] = [];
  let stillConnected = 0;
  if (account) {
    const companies = await listCompanies(account.ownerId);
    const hashes = realmId && /^\d{1,32}$/.test(realmId) ? [hashRealmId(realmId), legacyHashRealmId(realmId)] : null;
    const targets = (hashes ? companies.filter((c) => hashes.includes(c.realmIdHash)) : companies).slice(0, 5);
    const results = await Promise.all(
      targets.map(async (c) => ({
        name: c.companyName ?? "Your QuickBooks company",
        state: await Promise.race([
          probeConnection(c.id).catch(() => "unknown" as const),
          new Promise<"unknown">((resolve) => setTimeout(() => resolve("unknown"), PROBE_TIMEOUT_MS)),
        ]),
      }))
    );
    disconnected = results.filter((r) => r.state === "revoked").map((r) => r.name);
    stillConnected = companies.length - disconnected.length;
  }

  return (
    <main className="flex min-h-screen flex-col bg-jp-surface">
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-5 py-12">
        <div className="mb-8 flex justify-center">
          <LogoLink width={220} priority />
        </div>
        <div className="rounded-xl border border-jp-line bg-white p-7 sm:p-8">
          <h1 className="text-xl font-bold text-navy">JobProfitAI is disconnected from QuickBooks</h1>
          {disconnected.length > 0 && (
            <p className="mt-3 text-sm text-jp-slate">
              Disconnected: <strong>{disconnected.join(", ")}</strong>.
            </p>
          )}
          <p className="mt-3 text-sm text-jp-slate">
            JobProfitAI can no longer read from that QuickBooks company. Syncing and its Weekly Profit Brief have
            stopped. Everything already in JobProfitAI (your jobs, estimates and reports) is kept, and comes back as it
            was if you reconnect.
          </p>

          <h2 className="mt-6 text-sm font-semibold text-navy">To reconnect</h2>
          {account ? (
            <>
              <p className="mt-2 text-sm text-jp-slate">
                Choose Connect to QuickBooks, sign in to Intuit and pick the company.
              </p>
              <div className="mt-4">
                <ConnectToQuickBooksButton />
              </div>
              <p className="mt-6 text-sm">
                <Link href="/dashboard" className="font-medium text-brand hover:underline">
                  {stillConnected > 0 ? "Go to your dashboard" : "Go to JobProfitAI"}
                </Link>
              </p>
            </>
          ) : (
            <>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-jp-slate">
                <li>Sign in to JobProfitAI.</li>
                <li>On the dashboard or in Settings, choose Connect to QuickBooks.</li>
                <li>Sign in to Intuit and pick the company.</li>
              </ol>
              <div className="mt-5 flex flex-wrap items-center gap-4">
                <SignInWithIntuitButton />
                <Link href="/login" className="text-sm font-medium text-brand hover:underline">
                  Log in with your password
                </Link>
              </div>
            </>
          )}
          <p className="mt-6 text-xs text-jp-muted">
            Questions? Email{" "}
            <a href="mailto:support@jobprofitai.com" className="underline">
              support@jobprofitai.com
            </a>
            .
          </p>
        </div>
      </div>
    </main>
  );
}
