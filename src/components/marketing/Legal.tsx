import type { ReactNode } from "react";
import { COMPANY_LEGAL_NAME, COMPANY_MAILING_ADDRESS_LINES } from "@/lib/company";

/**
 * Shared layout for the Terms of Service and Privacy Policy. The site has no
 * Tailwind typography plugin, so headings, paragraphs and lists are styled
 * explicitly here rather than relying on `prose`.
 */
export function LegalPage({
  title,
  updated,
  intro,
  children,
}: {
  title: string;
  updated: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight text-jp-ink sm:text-4xl">{title}</h1>
      <p className="mt-2 text-sm text-jp-muted">Last updated: {updated}</p>
      {intro ? <div className="mt-8 space-y-4 text-[15px] leading-relaxed text-jp-slate">{intro}</div> : null}
      <div className="mt-6">{children}</div>
    </main>
  );
}

export function LegalSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-jp-line pt-8 mt-8 first:mt-0">
      <h2 className="text-xl font-semibold text-jp-ink">{title}</h2>
      <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-jp-slate">{children}</div>
    </section>
  );
}

export function LegalSub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="font-semibold text-jp-ink">{title}</h3>
      {children}
    </div>
  );
}

export function LegalList({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-2 pl-6 marker:text-jp-muted">{children}</ul>;
}

/** For the all-caps warranty and liability paragraphs, which must be conspicuous. */
export function Conspicuous({ children }: { children: ReactNode }) {
  return <p className="font-semibold uppercase tracking-wide text-jp-ink text-[13px] leading-relaxed">{children}</p>;
}

export function SupportEmail() {
  return (
    <a href="mailto:support@jobprofitai.com" className="font-medium text-jp-blue hover:underline">
      support@jobprofitai.com
    </a>
  );
}

/** Shown on both legal pages. Change it whenever either document changes. */
export const LEGAL_LAST_UPDATED = "September 22, 2026";

/** The postal address, formatted for the Contact section of each legal page. */
export function MailingAddress() {
  return (
    <address className="not-italic">
      <span className="block">{COMPANY_LEGAL_NAME}</span>
      {COMPANY_MAILING_ADDRESS_LINES.map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      ))}
    </address>
  );
}
