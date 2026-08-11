import Link from "next/link";

export const metadata = {
  title: "Privacy Policy — JobProfitAI",
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <Link href="/" className="text-sm text-brand hover:underline">
        &larr; Back to JobProfitAI
      </Link>
      <h1 className="mt-4 text-3xl font-bold text-navy">Privacy Policy</h1>
      <p className="mt-2 text-sm text-gray-500">Last updated: August 7, 2026</p>

      <div className="prose prose-sm mt-8 max-w-none text-gray-700">
        <p>
          JobProfitAI (&quot;JobProfitAI,&quot; &quot;we,&quot; &quot;us,&quot; or
          &quot;our&quot;) is operated by PWL Solutions LLC, an Indiana limited
          liability company. This Privacy Policy explains what information we
          collect, how we use it, and the choices you have when you use our
          website and application (the &quot;Service&quot;).
        </p>

        <h2 className="mt-8 text-lg font-semibold text-navy">1. Information we collect</h2>
        <p>We collect the following categories of information:</p>
        <ul>
          <li>
            <strong>Account information</strong> you provide directly, such as your
            name, email address, and password (stored as a one-way hash, never in
            plain text).
          </li>
          <li>
            <strong>QuickBooks Online data</strong> you authorize us to access via
            Intuit&apos;s OAuth 2.0 connection. This includes job/project and class
            records, customer names associated with jobs, invoices, expenses,
            purchases, and related transaction line items needed to compute
            job-cost and profitability metrics. We request read access only and do
            not write to, modify, or delete anything in your QuickBooks company
            file.
          </li>
          <li>
            <strong>Usage data</strong>, such as when you sync your QuickBooks data
            or generate a digest, collected automatically to operate and improve
            the Service.
          </li>
          <li>
            <strong>Billing information</strong>, handled by our payment processor
            (Stripe) once billing is enabled — we do not store your full card
            number on our own servers.
          </li>
        </ul>

        <h2 className="mt-8 text-lg font-semibold text-navy">2. How we use your information</h2>
        <p>We use the information above to:</p>
        <ul>
          <li>Operate the Service, including syncing your QuickBooks data and generating your weekly profitability digest.</li>
          <li>Authenticate you and secure your account.</li>
          <li>Send you the digest and other service-related communications (e.g. connection or billing issues).</li>
          <li>Improve the accuracy and usefulness of the digest and underlying profitability calculations.</li>
          <li>Comply with legal obligations and enforce our Terms of Service.</li>
        </ul>
        <p>
          To generate your written digest, relevant financial metrics computed
          from your QuickBooks data are sent to Anthropic&apos;s Claude API, which
          writes the narrative summary. We do not use your data to train any
          third-party AI model, and we instruct the model to work only from the
          specific numbers we provide it — it does not have general access to
          your QuickBooks account.
        </p>

        <h2 className="mt-8 text-lg font-semibold text-navy">3. How we protect your information</h2>
        <p>
          QuickBooks OAuth tokens are encrypted at rest (AES-256-GCM) before being
          stored in our database and are never displayed to any user, including
          our own staff, in plain text. Passwords are hashed with bcrypt and never
          stored in plain text. Data is transmitted over encrypted (HTTPS)
          connections.
        </p>

        <h2 className="mt-8 text-lg font-semibold text-navy">4. Sharing your information</h2>
        <p>
          We do not sell your personal information or your QuickBooks data. We
          share information only with the service providers necessary to operate
          JobProfitAI, including:
        </p>
        <ul>
          <li>Intuit (QuickBooks Online), to read the data you&apos;ve authorized us to access.</li>
          <li>Anthropic (Claude API), to generate the written digest narrative from your computed metrics.</li>
          <li>Our hosting and database providers (Vercel, Neon), to run and store the Service.</li>
          <li>Stripe, to process payments once billing is enabled.</li>
          <li>Resend or a similar email provider, to deliver your digest emails.</li>
        </ul>
        <p>
          We may also disclose information if required to by law, or to protect
          the rights, property, or safety of JobProfitAI, our users, or others.
        </p>

        <h2 className="mt-8 text-lg font-semibold text-navy">5. Disconnecting QuickBooks and data retention</h2>
        <p>
          You can disconnect your QuickBooks connection at any time from your
          dashboard. Doing so revokes our access tokens with Intuit immediately.
          You can also revoke access directly from your Intuit/QuickBooks account
          settings at any time, independent of our app.
        </p>
        <p>
          We retain your account and previously-synced job data so that
          reconnecting restores your history, until you request deletion (see
          Section 7) or your account has been inactive and disconnected for an
          extended period, at which point we may delete it.
        </p>

        <h2 className="mt-8 text-lg font-semibold text-navy">6. Children&apos;s privacy</h2>
        <p>
          JobProfitAI is a business tool intended for contractors and business
          owners. It is not directed to, and we do not knowingly collect
          information from, anyone under the age of 18.
        </p>

        <h2 className="mt-8 text-lg font-semibold text-navy">7. Your choices and rights</h2>
        <p>
          You may access, correct, or request deletion of your account
          information, and disconnect your QuickBooks connection, at any time.
          To request deletion of your account and associated data, contact us
          using the information below.
        </p>

        <h2 className="mt-8 text-lg font-semibold text-navy">8. Changes to this policy</h2>
        <p>
          We may update this Privacy Policy from time to time. If we make
          material changes, we will update the &quot;Last updated&quot; date above and,
          where appropriate, notify you directly.
        </p>

        <h2 className="mt-8 text-lg font-semibold text-navy">9. Contact us</h2>
        <p>
          Questions about this Privacy Policy or your data can be sent to{" "}
          <a href="mailto:privacy@jobprofitai.com" className="text-brand hover:underline">
            privacy@jobprofitai.com
          </a>
          , or to PWL Solutions LLC.
        </p>

        <p className="mt-10 rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
          Note: this policy is a working draft prepared to accurately describe how
          JobProfitAI currently operates. Have it reviewed by a licensed attorney
          before relying on it for real customer data at scale.
        </p>
      </div>
    </main>
  );
}
