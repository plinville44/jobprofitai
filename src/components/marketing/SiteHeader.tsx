"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoLink } from "./Logo";

/**
 * Marketing site header.
 *
 * A client component only because of the mobile menu toggle. The nav links
 * themselves are ordinary <Link>s, so navigation works with JavaScript
 * disabled and the menu simply stays collapsed.
 */

const NAV = [
  { href: "/how-it-works", label: "How It Works" },
  { href: "/pricing", label: "Pricing" },
  { href: "/security", label: "Security" },
  { href: "/contact", label: "Contact" },
];

export default function SiteHeader() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-jp-line bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-3.5 sm:px-6">
        <LogoLink width={172} priority />

        <nav aria-label="Main" className="hidden items-center gap-7 lg:flex">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`text-sm font-medium transition-colors ${
                  active ? "text-jp-blue" : "text-jp-slate hover:text-jp-ink"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="hidden items-center gap-3 lg:flex">
          <Link
            href="/login"
            className="text-sm font-medium text-jp-slate transition-colors hover:text-jp-ink"
          >
            Log In
          </Link>
          <Link
            href="/signup"
            className="inline-flex items-center rounded-lg bg-jp-blue px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-jp-navy"
          >
            Start Free Trial
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? "Close menu" : "Open menu"}
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-jp-line text-jp-ink lg:hidden"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            {open ? (
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            ) : (
              <path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            )}
          </svg>
        </button>
      </div>

      {open ? (
        <div id="mobile-nav" className="border-t border-jp-line bg-white lg:hidden">
          <nav aria-label="Main" className="mx-auto w-full max-w-6xl px-5 py-4 sm:px-6">
            <ul className="space-y-1">
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className="block rounded-lg px-2 py-2.5 text-base font-medium text-jp-ink hover:bg-jp-surface"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-col gap-2 border-t border-jp-line pt-4">
              <Link
                href="/login"
                onClick={() => setOpen(false)}
                className="rounded-lg border border-jp-line px-4 py-3 text-center text-sm font-semibold text-jp-ink"
              >
                Log In
              </Link>
              <Link
                href="/signup"
                onClick={() => setOpen(false)}
                className="rounded-lg bg-jp-blue px-4 py-3 text-center text-sm font-semibold text-white"
              >
                Start Free Trial
              </Link>
            </div>
          </nav>
        </div>
      ) : null}
    </header>
  );
}
