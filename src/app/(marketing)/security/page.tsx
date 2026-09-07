import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink, Card, Eyebrow, Section, SectionHeading } from "@/components/marketing/ui";

export const metadata: Metadata = {
  title: "Security",
  description:
    "How JobProfitAI protects your QuickBooks financial data: Intuit OAuth, encrypted tokens at rest, account isolation, Stripe-hosted payments, and what we do and don't store.",
  alternates: { canonical: "/security" },
  openGraph: {
    title: "JobProfitAI Security",
    description:
      "How we handle your QuickBooks connection, what we store, and what we haven't done yet.",
    url: "/security",
  },
};

function Item({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-jp-line py-7 first:border-t-0 first:pt-0">
      <h3 className="text-lg font-semibold text-jp-ink">{title}</h3>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-jp-slate">{children}</div>
    </div>
  );
}

export default function SecurityPage() {
  return (
    <>
      <Section className="!pb-8">
        <div className="mx-auto max-w-3xl">
          <Eyebrow>Security &amp; trust</Eyebrow>
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-jp-ink sm:text-5xl">
            You&rsquo;re connecting your financial data. Here&rsquo;s exactly how it&rsquo;s handled.
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-jp-slate">
            This page describes what JobProfitAI actually does, not a list of badges. It also
            says plainly what we have <em>not</em> done, because a security page that only lists
            good news isn&rsquo;t useful to anyone making a real decision.
          </p>
        </div>
      </Section>

      {/* ── Honest posture callout ──────────────────────────────────── */}
      <Section className="!pt-0 !pb-10">
        <Card className="mx-auto max-w-3xl border-jp-blue/25 bg-jp-surface-2/50">
          <h2 className="text-base font-semibold text-jp-ink">
            What we don&rsquo;t claim
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed text-jp-slate">
            JobProfitAI does <strong>not</strong> hold SOC 2, SOC 2 Type II, ISO 27001, HIPAA or PCI
            certification, and has not completed a third-party penetration test or security audit.
            We&rsquo;re a young product and we&rsquo;re not going to put badges on this page that we
            haven&rsquo;t earned. What follows is a factual description of the controls that are
            actually in place today.
          </p>
        </Card>
      </Section>

      {/* ── QuickBooks ──────────────────────────────────────────────── */}
      <Section tone="surface">
        <div className="mx-auto max-w-3xl">
          <SectionHeading
            eyebrow="QuickBooks connection"
            title="How the QuickBooks authorization works"
          />
          <div>
            <Item title="You authorize through Intuit, not through us">
              <p>
                Connecting uses Intuit&rsquo;s standard OAuth 2.0 flow. You&rsquo;re redirected to
                Intuit&rsquo;s own website to sign in and approve access. Your QuickBooks username
                and password are never entered into JobProfitAI, never transmitted to our servers,
                and never stored by us in any form.
              </p>
              <p>
                The authorization endpoints we use are read from Intuit&rsquo;s live OAuth discovery
                document rather than hardcoded, so we follow Intuit&rsquo;s current configuration.
              </p>
            </Item>

            <Item title="The connection request is protected against forgery">
              <p>
                Each connection attempt carries a short-lived, cryptographically signed state token
                tied to your logged-in session and valid for ten minutes. When Intuit redirects back,
                that signature is verified before anything is stored. A callback with a missing,
                expired or altered state token is rejected rather than trusted.
              </p>
            </Item>

            <Item title="What JobProfitAI does with the access it's given">
              <p>
                JobProfitAI <strong>only reads</strong> from QuickBooks. It does not create, modify
                or delete invoices, bills, customers, projects or any other record in your books.
                Every call the application makes to QuickBooks is a read.
              </p>
              <p>
                To be precise rather than reassuring: the connection uses Intuit&rsquo;s standard
                accounting scope, which is the scope Intuit provides for accounting data access. We
                describe our behaviour as read-only because that is what the software does,
                not because Intuit issues a separate read-only credential.
              </p>
            </Item>

            <Item title="Tokens and your company ID are encrypted before storage">
              <p>
                The OAuth access token, the refresh token, and your QuickBooks company (realm) ID
                are each encrypted with AES-256-GCM at the application layer before they are written
                to the database. The encryption key lives in the server environment, never in the
                database and never in source control, so a database dump or backup on its own does
                not yield usable credentials.
              </p>
              <p>
                Because encrypted values can&rsquo;t be searched, we also store a one-way SHA-256
                hash of the company ID purely as a lookup key. The plain company ID is never stored.
              </p>
            </Item>

            <Item title="You can disconnect at any time">
              <p>
                Disconnecting from Settings calls Intuit&rsquo;s token revocation endpoint to
                invalidate the connection on Intuit&rsquo;s side, then marks the connection inactive
                here. You can also revoke access from within QuickBooks itself at any time; if you
                do, JobProfitAI detects it on the next sync and asks you to reconnect rather than
                silently retrying.
              </p>
            </Item>
          </div>
        </div>
      </Section>

      {/* ── Your data ───────────────────────────────────────────────── */}
      <Section>
        <div className="mx-auto max-w-3xl">
          <SectionHeading eyebrow="Your data" title="What we store, and what we don't" />
          <div>
            <Item title="What is stored">
              <p>
                To produce profitability analysis, JobProfitAI stores a copy of the job-related data
                it reads from QuickBooks: jobs (Projects or Classes), cost line items from bills,
                expenses, purchases and time activities, invoice totals and status, estimate values,
                and the profitability figures calculated from them. It also stores the weekly
                digests and profit insights generated for you, and your own settings such as target
                margin and email recipients.
              </p>
            </Item>

            <Item title="What is not stored">
              <p>
                We do not store your QuickBooks password, your bank account details, your customers&rsquo;
                payment information, payroll records, or document attachments from your QuickBooks
                file. We do not store credit card numbers. See the billing section below.
              </p>
            </Item>

            <Item title="Every account's data is isolated from every other account">
              <p>
                Each QuickBooks connection belongs to exactly one JobProfitAI account. Every request
                that touches financial data verifies, on the server, that the signed-in account owns
                the connection or job being requested, a request for a record belonging to
                another account returns not-found, regardless of what the browser asks for.
              </p>
              <p>
                Being an accountant, a referral partner, or a referrer confers no access to any
                other business&rsquo;s financial data whatsoever. Partner dashboards show counts and
                commission amounts only, never a client&rsquo;s numbers.
              </p>
            </Item>

            <Item title="Logging is deliberately restricted">
              <p>
                Application error logs record status codes and Intuit&rsquo;s request-tracing ID
                only. Raw API responses, request bodies and error objects from QuickBooks are never
                logged, because those can echo back credentials or customer financial data.
              </p>
            </Item>

            <Item title="Deleting your account deletes your data">
              <p>
                You can permanently delete your account from Settings. Doing so revokes any live
                QuickBooks connection with Intuit, cancels any active subscription, and deletes your
                account together with the jobs, cost data, invoices, digests and insights derived
                from it. Deletion is irreversible and requires re-entering your password.
              </p>
              <p>
                Records of commissions already earned by an accounting partner are retained as
                financial records, without the deleted account&rsquo;s identifying details.
              </p>
            </Item>
          </div>
        </div>
      </Section>

      {/* ── Application & infrastructure ────────────────────────────── */}
      <Section tone="surface">
        <div className="mx-auto max-w-3xl">
          <SectionHeading
            eyebrow="Application &amp; infrastructure"
            title="Authentication, transport and hosting"
          />
          <div>
            <Item title="Authentication">
              <p>
                Passwords are hashed with bcrypt (work factor 12) and never stored in a recoverable
                form. Sessions use a signed token in an HTTP-only cookie, which browser JavaScript
                cannot read, marked Secure in production and scoped with SameSite protection against
                cross-site request forgery.
              </p>
            </Item>

            <Item title="Transport">
              <p>
                The application is served exclusively over HTTPS. All communication with Intuit,
                Stripe and our email provider is over TLS.
              </p>
            </Item>

            <Item title="Hosting and database">
              <p>
                JobProfitAI runs on Vercel, with a managed PostgreSQL database hosted by Neon.
                Database access is restricted to the application via a credential held in the server
                environment. Secrets. Database credentials, the token encryption key, API keys
. Are stored as environment variables in the hosting platform, never committed
                to source control, and never exposed to the browser.
              </p>
            </Item>

            <Item title="Payments">
              <p>
                Billing is handled by Stripe. Card details are entered on Stripe-hosted pages and
                are never transmitted to or stored on JobProfitAI systems. We hold only
                Stripe&rsquo;s identifiers for your customer and subscription. Stripe is a PCI
                Service Provider Level 1; that is Stripe&rsquo;s certification, not ours, and it
                applies to their handling of card data.
              </p>
              <p>
                Incoming billing events from Stripe are cryptographically signature-verified before
                being processed, so a forged request cannot alter your subscription state.
              </p>
            </Item>

            <Item title="Email">
              <p>
                Transactional email. Your Weekly Profit Brief, trial and billing notices
. Is sent through Resend from a verified JobProfitAI sending domain. Emails go
                only to the addresses on your own account and the recipients you configure.
              </p>
            </Item>

            <Item title="Artificial intelligence">
              <p>
                Profit insights and the weekly digest narrative are written by Anthropic&rsquo;s
                Claude API. What is sent is the calculated profitability data for your jobs,
                job names, categories and computed figures. The model writes explanatory prose only:
                every dollar amount, percentage and confidence level is calculated by the
                application and re-applied afterwards, so the AI cannot change a number. Your
                QuickBooks credentials are never sent to any AI service.
              </p>
            </Item>
          </div>
        </div>
      </Section>

      {/* ── Contact ─────────────────────────────────────────────────── */}
      <Section>
        <Card className="mx-auto max-w-3xl text-center">
          <h2 className="text-2xl font-bold tracking-tight text-jp-ink">
            Security questions, or something to report?
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-jp-slate">
            We&rsquo;d rather hear from you than not. If you have a question about how your data is
            handled, or believe you&rsquo;ve found a vulnerability, email us directly and we&rsquo;ll
            respond.
          </p>
          <a
            href="mailto:support@jobprofitai.com?subject=Security%20question"
            className="mt-5 inline-block text-lg font-semibold text-jp-blue hover:underline"
          >
            support@jobprofitai.com
          </a>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink href="/contact" variant="secondary">
              Use the contact form
            </ButtonLink>
            <ButtonLink href="/signup">Start Your 14-Day Free Trial</ButtonLink>
          </div>
          <p className="mt-6 text-xs leading-relaxed text-jp-muted">
            See also our{" "}
            <Link href="/privacy" className="font-medium text-jp-blue hover:underline">
              Privacy Policy
            </Link>{" "}
            and{" "}
            <Link href="/terms" className="font-medium text-jp-blue hover:underline">
              Terms of Service
            </Link>
            .
          </p>
        </Card>
      </Section>
    </>
  );
}
