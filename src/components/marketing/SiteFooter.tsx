import Link from "next/link";
import { Logo } from "./Logo";

const PRODUCT_LINKS = [
  { href: "/how-it-works", label: "How It Works" },
  { href: "/pricing", label: "Pricing" },
  { href: "/security", label: "Security" },
  { href: "/partners", label: "Partner Program" },
];

const COMPANY_LINKS = [
  { href: "/contact", label: "Contact" },
  { href: "/login", label: "Log In" },
  { href: "/signup", label: "Start Free Trial" },
];

const LEGAL_LINKS = [
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms of Service" },
];

export default function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-jp-line bg-white">
      <div className="mx-auto w-full max-w-6xl px-5 py-14 sm:px-6">
        <div className="grid gap-10 md:grid-cols-[1.6fr_1fr_1fr_1fr]">
          <div>
            <Link href="/" aria-label="JobProfitAI home" className="inline-flex">
              <Logo width={200} />
            </Link>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-jp-slate">
              Profit intelligence for contractors running on QuickBooks Online. See which jobs make
              money, where margin is leaking, and what to do about it.
            </p>
            <a
              href="mailto:support@jobprofitai.com"
              className="mt-4 inline-block text-sm font-medium text-jp-blue hover:underline"
            >
              support@jobprofitai.com
            </a>
          </div>

          <FooterColumn title="Product" links={PRODUCT_LINKS} />
          <FooterColumn title="Company" links={COMPANY_LINKS} />
          <FooterColumn title="Legal" links={LEGAL_LINKS} />
        </div>

        <div className="mt-12 border-t border-jp-line pt-7">
          <p className="text-xs leading-relaxed text-jp-muted">
            &copy; {year} PWL Solutions LLC. All rights reserved. JobProfitAI is a product of PWL
            Solutions LLC.
          </p>
          <p className="mt-2 text-xs leading-relaxed text-jp-muted">
            QuickBooks and QuickBooks Online are trademarks of Intuit Inc., registered in the United
            States and other countries. JobProfitAI is an independent product and is not affiliated
            with, endorsed by, or sponsored by Intuit Inc. Use of the QuickBooks name is for
            identification purposes only.
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: { href: string; label: string }[];
}) {
  return (
    <div>
      <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-jp-ink">{title}</h2>
      <ul className="mt-4 space-y-2.5">
        {links.map((link) => (
          <li key={link.href}>
            <Link href={link.href} className="text-sm text-jp-slate transition-colors hover:text-jp-blue">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
