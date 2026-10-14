import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LogoLink } from "@/components/marketing/Logo";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasAcceptedCurrentTerms, safeReturnPath } from "@/lib/termsAcceptance";
import { LEGAL_LAST_UPDATED } from "@/lib/legalVersion";
import AcceptTermsForm from "./AcceptTermsForm";

export const metadata: Metadata = { title: "Terms of Service", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Asked once of a login with no record of agreeing to the current Terms of
 * Service and Privacy Policy: an App Store signup (no form to tick), an
 * account from before the agreement box, or everyone after a material
 * change (ACCEPTANCE_VERSION in src/lib/legalVersion.ts). The app's layouts
 * send them here; agreeing records it and goes back.
 */
export default async function AcceptTermsPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const next = safeReturnPath((await searchParams).next);
  if (await hasAcceptedCurrentTerms(session.userId)) redirect(next);
  const earlier = await prisma.termsAcceptance.count({ where: { userId: session.userId } });

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8 flex justify-center">
        <LogoLink width={200} priority />
      </div>
      <h1 className="text-2xl font-bold text-navy">
        {earlier > 0 ? "We've updated our Terms and Privacy Policy" : "One step before you start"}
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-gray-600">
        {earlier > 0
          ? `Our Terms of Service and Privacy Policy changed on ${LEGAL_LAST_UPDATED}. Please read them and agree to keep using JobProfitAI.`
          : "Please read and agree to our Terms of Service and Privacy Policy to use JobProfitAI."}
      </p>
      <AcceptTermsForm next={next} />
    </main>
  );
}
