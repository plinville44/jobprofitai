import Link from "next/link";
import { Logo } from "@/components/marketing/Logo";
import { COMPANY_LEGAL_NAME, COMPANY_MAILING_ADDRESS } from "@/lib/company";

/**
 * Chrome for the ad landing pages (/lp/*). Deliberately not the marketing
 * layout: no site navigation, so a visitor who clicked an ad has one thing
 * to do (start the trial) instead of wandering off to other pages. The logo
 * isn't a link for the same reason. The footer keeps what every page must
 * have: the legal pages, the company and address, and the trademark notice.
 */
export default function LandingLayout({ children }: { children: React.ReactNode }) {
  const year = new Date().getFullYear();
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="sticky top-0 z-40 border-b border-jp-line bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-3.5 sm:px-6">
          <Logo width={180} priority />
          <Link
            href="/signup"
            className="inline-flex items-center rounded-lg bg-jp-blue px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-jp-navy"
          >
            Start Free Trial
          </Link>
        </div>
      </header>

      <main id="main" className="flex-1">
        {children}
      </main>

      <footer className="border-t border-jp-line bg-white">
        <div className="mx-auto w-full max-w-6xl px-5 py-10 sm:px-6">
          <nav aria-label="Legal" className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Link href="/privacy" className="text-jp-slate hover:text-jp-ink">
              Privacy Policy
            </Link>
            <Link href="/terms" className="text-jp-slate hover:text-jp-ink">
              Terms of Service
            </Link>
            <Link href="/security" className="text-jp-slate hover:text-jp-ink">
              Security
            </Link>
            <Link href="/contact" className="text-jp-slate hover:text-jp-ink">
              Contact
            </Link>
            <Link href="/login" className="text-jp-slate hover:text-jp-ink">
              Log In
            </Link>
          </nav>
          <p className="mt-6 text-xs leading-relaxed text-jp-muted">
            &copy; {year} {COMPANY_LEGAL_NAME}. JobProfitAI is a product of {COMPANY_LEGAL_NAME}, {COMPANY_MAILING_ADDRESS}.
          </p>
          <p className="mt-2 text-xs leading-relaxed text-jp-muted">
            QuickBooks and QuickBooks Online are trademarks of Intuit Inc., registered in the United States and
            other countries. JobProfitAI is an independent product and is not affiliated with, endorsed by, or
            sponsored by Intuit Inc. Use of the QuickBooks name is for identification purposes only.
          </p>
        </div>
      </footer>
    </div>
  );
}
