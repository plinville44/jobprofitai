import SiteHeader from "@/components/marketing/SiteHeader";
import SiteFooter from "@/components/marketing/SiteFooter";

/**
 * Shared chrome for every public marketing page.
 *
 * This is a route group - the "(marketing)" folder name doesn't appear in
 * any URL, so /pricing, /security and the rest keep the paths they'd have
 * anyway. Authenticated /dashboard routes have their own layout and are
 * unaffected by anything here.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      {/* Keyboard users land here first; the target is the <main> below. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-jp-ink focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
