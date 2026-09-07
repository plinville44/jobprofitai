import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Marketing design primitives.
 *
 * Everything on the public site is built from these so spacing, type scale
 * and colour stay consistent across pages. The look is deliberately
 * restrained - generous whitespace, strong type hierarchy, one accent colour
 * - because the product asks people to connect their accounting system, and
 * a page that looks like a financial tool earns that trust in a way a page
 * covered in gradients and glow effects does not.
 */

export function Section({
  children,
  className = "",
  tone = "white",
  id,
}: {
  children: ReactNode;
  className?: string;
  tone?: "white" | "surface" | "ink";
  id?: string;
}) {
  const tones = {
    white: "bg-white",
    surface: "bg-jp-surface",
    ink: "bg-jp-ink text-white",
  } as const;
  return (
    <section id={id} className={tones[tone]}>
      {/*
       * The caller's className goes on this inner container, not on the outer
       * <section>. Every override in the app is a padding tweak (!pb-8,
       * !pt-4, !pt-0) and the padding lives here - the <section> element has
       * none of its own. Putting them on the <section> silently did nothing,
       * so a hero and the block beneath it each kept their full py-24 and the
       * page showed roughly 190px of empty space between them.
       */}
      <div className={`mx-auto w-full max-w-6xl px-5 py-16 sm:px-6 sm:py-20 lg:py-24 ${className}`}>
        {children}
      </div>
    </section>
  );
}

export function Eyebrow({ children, light = false }: { children: ReactNode; light?: boolean }) {
  return (
    <p
      className={`mb-4 text-xs font-semibold uppercase tracking-[0.14em] ${
        light ? "text-jp-blue-bright" : "text-jp-blue"
      }`}
    >
      {children}
    </p>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  intro,
  align = "left",
  light = false,
}: {
  eyebrow?: string;
  title: ReactNode;
  intro?: ReactNode;
  align?: "left" | "center";
  light?: boolean;
}) {
  return (
    <div className={`${align === "center" ? "mx-auto max-w-3xl text-center" : "max-w-3xl"} mb-12`}>
      {eyebrow ? <Eyebrow light={light}>{eyebrow}</Eyebrow> : null}
      <h2
        className={`text-3xl font-bold leading-tight tracking-tight sm:text-4xl ${
          light ? "text-white" : "text-jp-ink"
        }`}
      >
        {title}
      </h2>
      {intro ? (
        <p className={`mt-5 text-lg leading-relaxed ${light ? "text-slate-300" : "text-jp-slate"}`}>
          {intro}
        </p>
      ) : null}
    </div>
  );
}

type ButtonProps = {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
  size?: "md" | "lg";
};

export function ButtonLink({
  href,
  children,
  variant = "primary",
  size = "md",
  className = "",
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center rounded-lg font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-jp-blue";
  const sizes = {
    md: "px-5 py-2.5 text-sm",
    lg: "px-7 py-3.5 text-base",
  } as const;
  const variants = {
    primary: "bg-jp-blue text-white hover:bg-jp-navy",
    secondary: "border border-jp-line bg-white text-jp-ink hover:border-jp-blue hover:text-jp-blue",
    ghost: "text-jp-ink hover:text-jp-blue",
  } as const;

  return (
    <Link href={href} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}>
      {children}
    </Link>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-jp-line bg-white p-6 shadow-[0_1px_2px_rgba(15,31,75,0.04)] ${className}`}
    >
      {children}
    </div>
  );
}

export function ValueCard({
  title,
  body,
  icon,
}: {
  title: string;
  body: string;
  icon?: ReactNode;
}) {
  return (
    <Card className="h-full">
      {icon ? <div className="mb-4 text-jp-blue">{icon}</div> : null}
      <h3 className="text-lg font-semibold text-jp-ink">{title}</h3>
      <p className="mt-2 text-[15px] leading-relaxed text-jp-slate">{body}</p>
    </Card>
  );
}

export function StepCard({
  number,
  title,
  body,
}: {
  number: number;
  title: string;
  body: string;
}) {
  return (
    <div className="relative">
      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-jp-blue text-base font-bold text-white">
        {number}
      </div>
      <h3 className="text-lg font-semibold text-jp-ink">{title}</h3>
      <p className="mt-2 text-[15px] leading-relaxed text-jp-slate">{body}</p>
    </div>
  );
}

/** Accessible always-open FAQ. Uses <details> so it works without JS. */
export function Faq({ items }: { items: { q: string; a: ReactNode }[] }) {
  return (
    <div className="divide-y divide-jp-line border-y border-jp-line">
      {items.map((item) => (
        <details key={item.q} className="group py-5">
          <summary className="flex cursor-pointer list-none items-start justify-between gap-4 text-left text-[17px] font-semibold text-jp-ink marker:content-none">
            <span>{item.q}</span>
            <span
              aria-hidden="true"
              className="mt-1 shrink-0 text-jp-muted transition-transform group-open:rotate-45"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M9 3.75v10.5M3.75 9h10.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </span>
          </summary>
          <div className="mt-3 max-w-3xl text-[15px] leading-relaxed text-jp-slate">{item.a}</div>
        </details>
      ))}
    </div>
  );
}

/** The check mark used in plan feature lists. */
export function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`h-5 w-5 shrink-0 text-jp-green ${className}`}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4.5 10.5l3.5 3.5 7.5-8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Final call-to-action band, repeated at the foot of every marketing page.
 */
export function FinalCta({
  title = "Stop wondering where your profit went.",
  body = "Connect QuickBooks and see which jobs are actually making you money.",
}: {
  title?: string;
  body?: string;
}) {
  return (
    <Section tone="ink">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-3xl font-bold leading-tight tracking-tight text-white sm:text-4xl">
          {title}
        </h2>
        <p className="mt-5 text-lg leading-relaxed text-slate-300">{body}</p>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <ButtonLink href="/signup" size="lg" className="w-full sm:w-auto">
            Start Your 14-Day Free Trial
          </ButtonLink>
          <ButtonLink
            href="/pricing"
            size="lg"
            variant="secondary"
            className="w-full border-white/25 bg-transparent text-white hover:border-white hover:text-white sm:w-auto"
          >
            See Pricing
          </ButtonLink>
        </div>
        <p className="mt-5 text-sm text-slate-400">14 days free. No credit card required.</p>
      </div>
    </Section>
  );
}
