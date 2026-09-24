import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LogoLink } from "@/components/marketing/Logo";
import { prisma } from "@/lib/prisma";
import { readPendingIntuitIdentity } from "@/lib/intuitSignIn";
import IntuitLinkForm from "./IntuitLinkForm";

export const metadata: Metadata = { title: "Finish signing in with Intuit", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Someone signed in with Intuit and we don't know their Intuit account yet.
 * They either link it to their existing JobProfitAI login (password
 * required, per Intuit's rules) or create a new account.
 */
export default async function IntuitLinkPage() {
  const pending = await readPendingIntuitIdentity();
  if (!pending) redirect("/login?notice=intuit_session");

  const existing = pending.email
    ? await prisma.user.findFirst({
        where: { email: { equals: pending.email, mode: "insensitive" } },
        select: { id: true },
      })
    : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8 flex justify-center">
        <LogoLink width={200} priority />
      </div>
      <h1 className="text-2xl font-bold text-navy">You&apos;re signed in with Intuit</h1>
      <p className="mt-3 text-sm text-gray-600">
        {pending.email ? (
          <>
            Your Intuit account ({pending.email}) isn&apos;t linked to JobProfitAI yet.
          </>
        ) : (
          <>Your Intuit account isn&apos;t linked to JobProfitAI yet.</>
        )}{" "}
        {existing
          ? "There's already a JobProfitAI login for this address. Enter its password once to link them; after that, Sign in with Intuit takes you straight in."
          : "Create your JobProfitAI account, or link a login you already have."}
      </p>
      {pending.connect && (
        <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-navy">
          Your QuickBooks company isn&apos;t connected yet. Once you&apos;re in, choose Connect to QuickBooks on the
          dashboard.
        </p>
      )}
      <IntuitLinkForm email={pending.email ?? ""} canCreate={!existing && Boolean(pending.email)} />
    </main>
  );
}
