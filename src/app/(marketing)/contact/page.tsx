import type { Metadata } from "next";
import Link from "next/link";
import { Card, Eyebrow, Section } from "@/components/marketing/ui";
import ContactForm from "@/components/marketing/ContactForm";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Get in touch with the JobProfitAI team about the product, pricing, support, billing, security, or the accountant partner program. Or email support@jobprofitai.com.",
  alternates: { canonical: "/contact" },
  openGraph: {
    title: "Contact JobProfitAI",
    description: "Questions about the product, pricing, security or the partner program?",
    url: "/contact",
  },
};

export default function ContactPage() {
  return (
    <Section>
      <div className="grid gap-12 lg:grid-cols-[1fr_1.4fr] lg:gap-16">
        <div>
          <Eyebrow>Contact</Eyebrow>
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-jp-ink">
            Talk to us.
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-jp-slate">
            Questions about whether JobProfitAI fits how you run jobs, what it costs, or how your
            QuickBooks data is handled? Send a message and a person will reply.
          </p>

          <Card className="mt-8">
            <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-jp-muted">
              Prefer email?
            </h2>
            <a
              href="mailto:support@jobprofitai.com"
              className="mt-2 block text-lg font-semibold text-jp-blue hover:underline"
            >
              support@jobprofitai.com
            </a>
            <p className="mt-3 text-sm leading-relaxed text-jp-slate">
              That address reaches us for everything. Product questions, support, billing and
              security.
            </p>
          </Card>

          <div className="mt-8 space-y-5 text-sm leading-relaxed text-jp-slate">
            <div>
              <h3 className="font-semibold text-jp-ink">Already a customer?</h3>
              <p className="mt-1">
                You can also send feedback from inside the app. It arrives with your account
                details attached, which usually gets you a faster answer.
              </p>
            </div>
            <div>
              <h3 className="font-semibold text-jp-ink">Accountants &amp; bookkeepers</h3>
              <p className="mt-1">
                If you work with several contractor clients, have a look at the{" "}
                <Link href="/partners" className="font-medium text-jp-blue hover:underline">
                  Partner Program
                </Link>{" "}
                first. It may answer your question, and you can apply from there.
              </p>
            </div>
            <div>
              <h3 className="font-semibold text-jp-ink">Security reports</h3>
              <p className="mt-1">
                Please email{" "}
                <a href="mailto:support@jobprofitai.com" className="font-medium text-jp-blue hover:underline">
                  support@jobprofitai.com
                </a>{" "}
                with &ldquo;Security&rdquo; in the subject. See our{" "}
                <Link href="/security" className="font-medium text-jp-blue hover:underline">
                  security page
                </Link>{" "}
                for how we handle data.
              </p>
            </div>
          </div>
        </div>

        <div>
          <ContactForm />
        </div>
      </div>
    </Section>
  );
}
