import type { Metadata } from "next";
import Link from "next/link";
import {
  LegalList,
  LegalPage,
  LegalSection,
  LEGAL_UPDATED,
  MailingAddress,
  SupportEmail,
} from "@/components/marketing/Legal";
import { DISCONNECTED_RETENTION_DAYS } from "@/lib/dataRetention";

export const metadata: Metadata = {
  title: "Data Processing Addendum",
  description:
    "How PWL Solutions LLC processes personal information in customers' QuickBooks data on their behalf: instructions, service provider commitments, subprocessors, security, incidents, assistance and deletion.",
  alternates: { canonical: "/dpa" },
};

const linkClass = "font-medium text-jp-blue hover:underline";

/**
 * The providers that process Customer Personal Data for us. Narrower than
 * the Privacy Policy's list: the outreach, advertising and analytics
 * companies never receive it. Keep in step with the Privacy Policy table
 * and with a written data-protection agreement for each (Intuit's
 * developer terms, section 12.2, require one).
 */
const SUBPROCESSORS: { name: string; purpose: string; location: string }[] = [
  { name: "Vercel Inc.", purpose: "Hosting the application", location: "United States" },
  { name: "Neon", purpose: "Managed database", location: "United States" },
  {
    name: "Anthropic, PBC",
    purpose: "Writing the AI insights and summaries from calculated job figures",
    location: "United States (processing restricted to US infrastructure; see the Privacy Policy, Section 4)",
  },
  { name: "Resend", purpose: "Sending the Weekly Profit Brief, alerts and account email", location: "United States" },
  {
    name: "Functional Software, Inc. (Sentry)",
    purpose: "Error monitoring, set up to leave out names, email addresses, tokens and figures",
    location: "United States",
  },
  {
    name: "Google LLC (Google Workspace)",
    purpose: "Our email, for support messages you send us",
    location: "Google's data centers, which may be outside the United States",
  },
];

export default function DpaPage() {
  return (
    <LegalPage
      title="Data Processing Addendum"
      updated={LEGAL_UPDATED.dpa}
      intro={
        <>
          <p>
            This Data Processing Addendum (the &ldquo;Addendum&rdquo;) is part of the{" "}
            <Link href="/terms" className={linkClass}>
              Terms of Service
            </Link>{" "}
            between you and PWL Solutions LLC (&ldquo;we,&rdquo; &ldquo;us&rdquo; or &ldquo;our&rdquo;). It applies
            when we process Customer Personal Data on your behalf while providing JobProfitAI. Words defined in the
            Terms have the same meaning here.
          </p>
          <p>
            Our{" "}
            <Link href="/privacy" className={linkClass}>
              Privacy Policy
            </Link>{" "}
            covers the information we handle for our own purposes, such as your account login, billing, our website
            and our marketing. This Addendum covers the personal information in your QuickBooks data and the other
            data you put in the Service.
          </p>
        </>
      }
    >
      <LegalSection id="definitions" title="1. Definitions">
        <LegalList>
          <li>
            <span className="font-medium text-jp-ink">Customer Personal Data</span> means personal information in
            Your Data that we process on your behalf, such as the names of your customers, vendors and employees,
            the hours and labor cost on time entries, descriptions and memos typed into QuickBooks, and the email
            addresses of team members and brief recipients you add.
          </li>
          <li>
            <span className="font-medium text-jp-ink">Data Protection Laws</span> means the United States federal
            and state privacy and data security laws that apply to that processing, such as the California Consumer
            Privacy Act and other state consumer privacy laws, to the extent they apply.
          </li>
          <li>
            <span className="font-medium text-jp-ink">Subprocessor</span> means a service provider we engage that
            processes Customer Personal Data.
          </li>
          <li>
            <span className="font-medium text-jp-ink">Security Incident</span> means a confirmed breach of security
            that leads to the accidental or unlawful destruction, loss, alteration, or unauthorized disclosure of or
            access to Customer Personal Data.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection id="roles" title="2. Roles">
        <p>
          You decide why and how Customer Personal Data is processed, and we process it for you as your service
          provider or processor. You are responsible for having the right to give us that data and for any notices
          or consents the law requires you to give the people it concerns. If you are a bookkeeping or accounting
          firm using the Service for your clients, you may yourself be processing their data for them; you are
          responsible to them, and we act on your instructions as the account holder.
        </p>
        <p>
          We process QuickBooks data for you, not on Intuit&rsquo;s behalf.
        </p>
      </LegalSection>

      <LegalSection id="instructions" title="3. Processing only on your instructions">
        <p>
          We process Customer Personal Data only to provide, secure, support and improve the Service for you as the
          Terms describe, following the settings and choices you make in the Service and any other written
          instructions we agree to, and as the law requires. If the law requires other processing, we will tell you
          first unless the law forbids it. If we believe an instruction breaks a Data Protection Law, we will tell you.
          Improving the Service may include creating aggregated or de-identified information that does not identify
          you, your business or any person.
        </p>
      </LegalSection>

      <LegalSection id="service-provider" title="4. Service provider commitments">
        <p>We will not:</p>
        <LegalList>
          <li>sell or share Customer Personal Data, as Data Protection Laws use those words;</li>
          <li>
            keep, use or disclose it for any purpose other than the business purposes in this Addendum, including
            for targeted or cross-context behavioral advertising, or outside our direct business relationship with
            you; or
          </li>
          <li>
            combine it with personal information we receive from anyone else or collect ourselves, except as Data
            Protection Laws allow.
          </li>
        </LegalList>
        <p>
          We will comply with the obligations Data Protection Laws place on us as a service provider or processor,
          give Customer Personal Data the level of protection those laws require, and tell you if we can no longer
          meet these commitments. You may then take reasonable steps to stop and remedy any unauthorized use,
          including by contacting us or suspending your use of the Service. We certify that we understand these
          restrictions and will comply with them.
        </p>
      </LegalSection>

      <LegalSection id="confidentiality" title="5. Confidentiality">
        <p>
          Everyone we allow to process Customer Personal Data is bound by a duty of confidentiality. Contractors who
          help with our outreach and sales have no access to the Service&rsquo;s data.
        </p>
      </LegalSection>

      <LegalSection id="subprocessors" title="6. Subprocessors">
        <p>You authorize us to use these Subprocessors for these purposes:</p>
        <div className="overflow-x-auto rounded-lg border border-jp-line">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="bg-jp-surface">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold text-jp-ink">Subprocessor</th>
                <th scope="col" className="px-4 py-3 font-semibold text-jp-ink">Purpose</th>
                <th scope="col" className="px-4 py-3 font-semibold text-jp-ink">Location</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-jp-line">
              {SUBPROCESSORS.map((p) => (
                <tr key={p.name}>
                  <th scope="row" className="px-4 py-3 align-top font-medium text-jp-ink">
                    {p.name}
                  </th>
                  <td className="px-4 py-3 align-top">{p.purpose}</td>
                  <td className="px-4 py-3 align-top">{p.location}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          We have a written agreement with each Subprocessor that requires data protection and security at least as
          protective as this Addendum, and we are responsible for their work as if it were our own. Before a new
          Subprocessor starts processing Customer Personal Data, we will update this list and email the address on
          your account at least 30 days ahead, unless an urgent change is needed to keep the Service running or
          secure, in which case we will tell you as soon as we can. If you object on reasonable data protection
          grounds, tell us; if we can&rsquo;t resolve it, you may cancel, and we will refund any amount you prepaid
          for the period after cancellation.
        </p>
      </LegalSection>

      <LegalSection id="security" title="7. Security">
        <p>
          We use administrative, technical and physical safeguards appropriate to the risk, including those our{" "}
          <Link href="/security" className={linkClass}>
            Security page
          </Link>{" "}
          describes: HTTPS for all traffic, QuickBooks tokens and company IDs encrypted before they are stored,
          hashed passwords, server-side checks that every request for financial data comes from the account that
          owns it, and error logs that leave out raw QuickBooks responses. We do not hold SOC 2, ISO 27001 or similar
          certifications, and the Security page says so.
        </p>
      </LegalSection>

      <LegalSection id="incidents" title="8. Security incidents">
        <p>
          If we confirm a Security Incident affecting your Customer Personal Data, we will tell you without undue
          delay, and within any deadline the law sets for us. We will describe what happened and the data involved
          as far as we know it, take reasonable steps to contain it and reduce harm, and give you the information
          and help you reasonably need to meet your own notification obligations.
        </p>
      </LegalSection>

      <LegalSection id="assistance" title="9. Help with requests and assessments">
        <p>
          The Service lets you correct settings and job details, delete a company&rsquo;s data and delete your
          account. Where that is not enough for a request from a person whose information is in Customer Personal
          Data, we will help you respond, taking into account what the Service does and the information we have. If
          such a person asks us directly, we will refer them to you. We will also give you information you
          reasonably need for a data protection assessment the law requires of you.
        </p>
      </LegalSection>

      <LegalSection id="deletion" title="10. Return and deletion">
        <p>
          You can export reports such as the WIP schedule from the Service at any time. If you need a copy of other
          Customer Personal Data we hold, ask us before you delete it and we will provide it in a common format
          within 30 days where reasonably practical.
        </p>
        <p>
          When you delete a company&rsquo;s data or your account, we delete the related Customer Personal Data. When
          a company is disconnected from QuickBooks (including from your Intuit account), we stop processing its data and delete it{" "}
          {DISCONNECTED_RETENTION_DAYS} days later unless you reconnect it first, as the Terms (Section 3) describe.
          Deleted data may remain in database backups until they are overwritten on their normal schedule, and we
          keep only what the law requires us to keep.
        </p>
      </LegalSection>

      <LegalSection id="information" title="11. Information and audits">
        <p>
          Once a year, and after a Security Incident, we will answer your reasonable written questions about how we
          protect Customer Personal Data, and share any security summaries our Subprocessors make available to us.
          This Addendum does not give a right to inspect our premises or systems.
        </p>
      </LegalSection>

      <LegalSection id="location" title="12. Where data is processed">
        <p>
          Customer Personal Data in the Service is stored and processed in the United States, except that our
          providers may access it from other countries for their own safety review, support and incident response,
          as Section 10 of our Privacy Policy describes. Emails you send us are kept in Google Workspace, which may
          store them outside the United States.
        </p>
      </LegalSection>

      <LegalSection id="general" title="13. General">
        <p>
          This Addendum lasts as long as we process Customer Personal Data for you. It is subject to the limitation
          of liability in Section 12 of the Terms. If it conflicts with the Terms about the processing of Customer
          Personal Data, this Addendum controls. We may update it as Section 18 of the Terms describes. Questions go
          to <SupportEmail />, or by mail to:
        </p>
        <MailingAddress />
      </LegalSection>
    </LegalPage>
  );
}
