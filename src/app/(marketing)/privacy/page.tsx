import type { Metadata } from "next";
import Link from "next/link";
import {
  LegalList,
  LegalPage,
  LegalSection,
  LegalSub,
  LEGAL_LAST_UPDATED,
  MailingAddress,
  SupportEmail,
} from "@/components/marketing/Legal";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "What information JobProfitAI collects, including data read from QuickBooks Online, how it is used and shared, how long it is kept, and how to access or delete it.",
  alternates: { canonical: "/privacy" },
};

const SERVICE_PROVIDERS: { name: string; purpose: string; data: string }[] = [
  {
    name: "Intuit Inc.",
    purpose: "QuickBooks Online authorization and the source of your accounting data",
    data: "Authorization requests and read requests for your QuickBooks company",
  },
  {
    name: "Vercel Inc.",
    purpose: "Hosting the website and application",
    data: "All data processed by the application, and standard request logs such as IP address and browser type",
  },
  {
    name: "Neon",
    purpose: "Managed database",
    data: "All stored account, QuickBooks-derived and billing-status data",
  },
  {
    name: "Stripe, Inc.",
    purpose: "Payments, invoices, the billing portal and referral credits",
    data: "Your name, email, billing details and payment method, which you enter directly with Stripe",
  },
  {
    name: "Resend",
    purpose: "Sending email",
    data: "Recipient email addresses and email content, including the Weekly Profit Brief",
  },
  {
    name: "Anthropic, PBC",
    purpose: "Generating AI-written insights and summaries",
    data: "Calculated profitability information for your jobs, including job names, customer names, job types and figures",
  },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      updated={LEGAL_LAST_UPDATED}
      intro={
        <>
          <p>
            This Privacy Policy explains how PWL Solutions LLC, an Indiana limited liability
            company (“PWL Solutions,” “we,” “us,” or “our”), collects, uses, shares and protects
            information in connection with JobProfitAI, including our website, web application and
            emails (the “Service”). It applies to people who visit our website, people who create
            an account, people who receive emails from the Service, and partners in our partner
            program.
          </p>
          <p>
            In short: we collect what we need to calculate job profitability for your business, we
            only read from QuickBooks, we do not sell personal information or use it for
            advertising, and you can delete your account and its data yourself at any time.
          </p>
        </>
      }
    >
      <LegalSection id="collect" title="1. Information we collect">
        <LegalSub title="Information you give us">
          <LegalList>
            <li>
              <span className="font-medium text-jp-ink">Account information:</span> your name,
              email address and password. We store your password only as a bcrypt hash, never in
              readable form.
            </li>
            <li>
              <span className="font-medium text-jp-ink">Sign in with Intuit:</span> if you use it,
              Intuit tells us its permanent ID for your Intuit account, your name, your email
              address and whether Intuit has verified that address. We store the ID to recognize
              you next time, and use the name and email for your account.
            </li>
            <li>
              <span className="font-medium text-jp-ink">Team members:</span> the email addresses of
              people you invite to your account, when they were invited and whether they accepted.
              Someone who accepts has their own account information as above.
            </li>
            <li>
              <span className="font-medium text-jp-ink">Settings and job details:</span> target
              margins, overhead settings, estimated costs, contract values, percent complete, job
              types, job status, cost category choices, your time zone, and up to 10 email
              addresses you choose to receive the Weekly Profit Brief and profit alerts.
            </li>
            <li>
              <span className="font-medium text-jp-ink">Feedback:</span> answers to our trial
              feedback survey and messages sent through the in-app feedback form.
            </li>
            <li>
              <span className="font-medium text-jp-ink">Contact form:</span> your name, company,
              email, phone number if you provide it, and your message.
            </li>
            <li>
              <span className="font-medium text-jp-ink">Partner applications:</span> firm name,
              contact name, phone, website, an estimate of your client count, and the email address
              you want commission payouts sent to. We do not collect bank account details.
            </li>
          </LegalList>
        </LegalSub>

        <LegalSub title="Information from QuickBooks Online">
          <p>
            When you connect a QuickBooks Online company, you authorize us through Intuit to read
            data from it. We copy and store the data needed for job profitability analysis:
          </p>
          <LegalList>
            <li>
              projects (jobs), or customers if you make one customer per job, and the customer each
              job belongs to, including customer names;
            </li>
            <li>
              cost lines from bills, checks, expenses, credit card charges and refunds, vendor
              credits and journal entries that are tagged to a job, including the amount, date,
              account or product name, cost category and line description (a description can
              contain whatever text was typed into QuickBooks, such as a vendor or employee name);
            </li>
            <li>
              time entries, as the employee&rsquo;s name, hours and a labor cost calculated from
              the pay rate QuickBooks holds for them. We don&rsquo;t store the pay rate itself, but
              it can be worked out from a single entry, so anyone with a login to your account can
              see it. You can turn off labor from timesheets in Settings;
            </li>
            <li>invoice, sales receipt, credit memo and refund totals, sales tax amounts, dates and payment status;</li>
            <li>
              estimates: the number, date, expiry date, status, whether QuickBooks has emailed it,
              the customer or project it names, and each line&rsquo;s product or service name,
              amount and cost category (not line descriptions); and
            </li>
            <li>your company name and basic company information.</li>
          </LegalList>
          <p>
            When you use Check against QuickBooks on a job, we read QuickBooks&rsquo; Profit and Loss
            report for that job&rsquo;s customer or project to show you beside our figures. We
            don&rsquo;t store that report.
          </p>
          <p>
            We also store the access and refresh tokens Intuit issues for the connection, and your
            QuickBooks company ID. All three are encrypted with AES-256-GCM before they are saved.
            We never receive or store your Intuit or QuickBooks password.
          </p>
          <p>
            We do not store your bank account details, your customers’ payment information,
            payroll records, or document attachments from QuickBooks. We never write to your
            QuickBooks company.
          </p>
        </LegalSub>

        <LegalSub title="Information we create">
          <p>
            From the data above we calculate profitability figures, data-quality checks, trends,
            forecasts and comparisons, and we store the Weekly Profit Briefs, profit alerts and
            insights we generate for you. We also keep records of sync runs, the emails we send you
            (type, recipient, time and delivery status), your subscription status, and referral and
            partner program activity.
          </p>
          <p>
            To limit password guessing we record sign-in attempts as keyed one-way hashes of the
            email address and network address, never the addresses themselves, and delete them
            after a day. To give each QuickBooks company one free trial, we record a keyed one-way
            hash of the company&rsquo;s ID with the date it started a trial.
          </p>
        </LegalSub>

        <LegalSub title="Payment information">
          <p>
            Payments are handled by Stripe. You enter card details on Stripe’s pages, and they are
            never sent to or stored by us. We keep only Stripe’s identifiers for your customer
            record and subscription, your plan, your subscription status and billing dates, and
            payment amounts.
          </p>
        </LegalSub>

        <LegalSub title="Information collected automatically">
          <p>
            Like most websites, our hosting provider records standard request information such as
            IP address, browser type, pages requested and time. For the contact form we store a
            one-way hash of your IP address, not the address itself, along with your browser’s user
            agent, to limit abuse. We do not use analytics, advertising or tracking services, and
            we do not use cookies for advertising.
          </p>
        </LegalSub>

        <LegalSub title="Cookies">
          <p>We use these cookies, all first-party and all needed for the Service to work:</p>
          <LegalList>
            <li>
              <span className="font-medium text-jp-ink">jmai_session</span> keeps you signed in. It
              is a signed, HTTP-only cookie that lasts up to 30 days or until you log out.
            </li>
            <li>
              <span className="font-medium text-jp-ink">jpai_ref</span> is set only when you arrive
              through a referral or partner link. It stores the referral code for up to 30 days so
              the referral can be credited if you sign up, and it is cleared when you do.
            </li>
            <li>
              <span className="font-medium text-jp-ink">jpai_company</span> remembers which of
              your QuickBooks companies you were looking at, for up to a year.
            </li>
            <li>
              <span className="font-medium text-jp-ink">jpai_oidc</span> and{" "}
              <span className="font-medium text-jp-ink">jpai_intuit</span> are used only while you
              sign in with Intuit: the first checks the sign-in came back to the browser that
              started it (10 minutes), the second holds your Intuit sign-in while you link it to an
              account (15 minutes).
            </li>
          </LegalList>
          <p>
            Our payment pages are hosted by Stripe, which sets its own cookies under{" "}
            <a
              href="https://stripe.com/privacy"
              className="font-medium text-jp-blue hover:underline"
              rel="noopener noreferrer"
              target="_blank"
            >
              Stripe’s privacy policy
            </a>
            .
          </p>
        </LegalSub>
      </LegalSection>

      <LegalSection id="use" title="2. How we use information">
        <LegalList>
          <li>
            To provide the Service: syncing your QuickBooks data, calculating profitability, and
            showing it in your dashboard.
          </li>
          <li>
            To send the Weekly Profit Brief and profit alerts to the recipients you choose, once
            you have confirmed your email address, and team invitations to the people you invite.
          </li>
          <li>
            To send account and service emails, such as email confirmation, password resets,
            trial and billing notices, payment problems, referral and partner updates, and replies
            to messages you send us.
          </li>
          <li>To manage subscriptions, referral credits and partner commissions.</li>
          <li>
            To keep the Service secure, prevent fraud and abuse (including repeated trials and
            self-referrals), and troubleshoot problems.
          </li>
          <li>
            To improve the Service, including by reading feedback you send us and looking at how
            features are used in aggregate.
          </li>
          <li>To comply with law and enforce our Terms of Service.</li>
        </LegalList>
        <p>
          Near the end of a trial we may ask whether you would be willing to give a testimonial.
          That request is optional, it is never a condition of anything, and we do not publish
          anything you say without your separate permission.
        </p>
        <p>
          We do not sell personal information, share it for cross-context behavioral
          advertising, or use it to build advertising profiles. We do not use your QuickBooks data
          for any purpose other than providing the Service to you.
        </p>
      </LegalSection>

      <LegalSection id="ai" title="3. Artificial intelligence">
        <p>
          Profit insights and the written summary in the Weekly Profit Brief are generated using
          Anthropic’s Claude API. To produce them, we send Anthropic the calculated profitability
          information for your jobs, which includes job names, the customer names attached to
          them, job types and calculated figures. When you ask for suggested job types, we send
          the names of the jobs that don&rsquo;t have one, their customer names, and the names of
          your job types. We never send your QuickBooks credentials or access tokens.
        </p>
        <p>
          Under Anthropic’s commercial terms, data sent through its API is not used to train its
          models without permission, and it is automatically deleted from Anthropic’s systems
          within 30 days, except where a longer period is needed to enforce Anthropic’s usage
          policies or is required by law. We have not given Anthropic permission to train on your
          data.
        </p>
      </LegalSection>

      <LegalSection id="share" title="4. How we share information">
        <p>We share information only in these ways:</p>
        <LegalSub title="Service providers">
          <p>
            We use the companies below to run the Service. They process information on our behalf
            and under their own terms and privacy commitments, and only for the purposes listed.
          </p>
          <div className="overflow-x-auto rounded-lg border border-jp-line">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="bg-jp-surface">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold text-jp-ink">Provider</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-jp-ink">Purpose</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-jp-ink">Information involved</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-jp-line">
                {SERVICE_PROVIDERS.map((p) => (
                  <tr key={p.name}>
                    <th scope="row" className="px-4 py-3 align-top font-medium text-jp-ink">
                      {p.name}
                    </th>
                    <td className="px-4 py-3 align-top">{p.purpose}</td>
                    <td className="px-4 py-3 align-top">{p.data}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </LegalSub>
        <LegalSub title="People you choose">
          <p>
            If you add recipients to the Weekly Profit Brief, we send it to them. The brief
            contains your job names, customer names and profitability figures.
          </p>
        </LegalSub>
        <LegalSub title="Referrers and partners">
          <p>
            If you sign up through someone’s referral or partner link, they are told that an
            account was created through their link, and later whether it became a paying account,
            because that is how credits and commissions are earned. Partners see how many referred
            accounts are on trial or paying, and the commission amounts earned. They do not see your QuickBooks data, jobs,
            customers or any financial figures from your account, and a referral never gives
            anyone access to your data.
          </p>
        </LegalSub>
        <LegalSub title="Legal and safety reasons">
          <p>
            We may disclose information if we believe in good faith that it is required by law,
            subpoena or other legal process, or needed to protect the rights, property or safety of
            our users, the public or PWL Solutions. Where the law allows, we will try to tell you
            before disclosing your data in response to a legal request.
          </p>
        </LegalSub>
        <LegalSub title="Business transfers">
          <p>
            If PWL Solutions is involved in a merger, acquisition, financing or sale of assets,
            information may be transferred as part of that transaction, subject to this Privacy
            Policy or protections at least as strong. We will notify you before your information
            becomes subject to a different privacy policy.
          </p>
        </LegalSub>
      </LegalSection>

      <LegalSection id="retention" title="5. How long we keep information">
        <LegalList>
          <li>
            <span className="font-medium text-jp-ink">While your account exists:</span> we keep
            your account, settings and QuickBooks-derived data so the Service can show your
            history. This includes data from a QuickBooks company you have disconnected, and data
            in accounts whose trial ended without subscribing, so you can pick up where you left
            off. You can remove it at any time by deleting your account.
          </li>
          <li>
            <span className="font-medium text-jp-ink">When you delete your account:</span> we
            revoke any live QuickBooks connection with Intuit, cancel any subscription, and delete
            your account together with your QuickBooks connections and tokens, jobs, cost data,
            invoices, estimates, Weekly Profit Briefs, alerts, insights, settings, team
            invitations, trial feedback, in-app feedback, referral codes and email records. Team
            members you invited lose access at once; their own logins remain theirs to delete.
          </li>
          <li>
            <span className="font-medium text-jp-ink">What we keep after deletion:</span> if you
            were referred by a partner, the commission records for payments you made are kept so
            the partner can be paid and our accounts reconcile. They contain amounts, dates and
            internal and Stripe reference numbers, not your name, email or any QuickBooks data. A
            record that a referral link led to an account is also kept with your account removed
            from it. The one-free-trial-per-company record (a keyed hash of the QuickBooks company
            ID, the date and an internal account number) is kept so the same company can&rsquo;t
            start another trial. Stripe keeps its own records of your payments, as payment processors are
            required to. We may also keep information we are legally required to keep, such as
            tax and accounting records.
          </li>
          <li>
            <span className="font-medium text-jp-ink">Contact form messages</span> are kept so we
            can follow up and handle your request. Email <SupportEmail /> if you want yours
            deleted.
          </li>
          <li>
            <span className="font-medium text-jp-ink">Backups and logs:</span> deleted data may
            remain for a limited time in database backups and our providers’ logs until those are
            overwritten on their normal schedule. We do not restore deleted accounts from backups
            except to recover from a system failure, and if that happens we delete the account
            again.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection id="security" title="6. Security">
        <p>
          We use safeguards designed to protect your information, including encryption of
          QuickBooks tokens and company IDs at the application level, hashed passwords, signed
          HTTP-only session cookies, HTTPS for all traffic, server-side checks that every request
          for financial data comes from the account that owns it, and error logs that exclude raw
          QuickBooks responses. Our{" "}
          <Link href="/security" className="font-medium text-jp-blue hover:underline">
            Security page
          </Link>{" "}
          describes these controls in more detail, including the certifications we do not hold.
          No method of storage or transmission is completely secure. If a breach affects your
          personal information, we will notify you as required by law.
        </p>
      </LegalSection>

      <LegalSection id="rights" title="7. Your choices and rights">
        <LegalSub title="What you can do yourself">
          <LegalList>
            <li>
              Change your target margin, overhead settings, and Weekly Profit Brief recipients and
              schedule in Settings. To change the name or email address on your account, email{" "}
              <SupportEmail />.
            </li>
            <li>Disconnect QuickBooks from Settings or from your Intuit account at any time.</li>
            <li>Cancel your subscription from Billing.</li>
            <li>Delete your account and its data from Settings at any time.</li>
          </LegalList>
        </LegalSub>
        <LegalSub title="Requests you can make">
          <p>
            You can ask us to confirm whether we process your personal information, give you a
            copy of it in a portable format, correct it, or delete it. Email <SupportEmail /> from
            the address on your account, or tell us how to reach you if you do not have an
            account. We will verify your request before acting on it, and we respond within 45
            days. If we need more time, which the law allows in some cases, we will tell you why.
            These requests are free of charge. If you have an account, we offer these rights to
            you wherever you live, not only where a law requires it.
          </p>
          <p>
            If we decline your request, you can appeal by replying to our decision or emailing{" "}
            <SupportEmail /> with the subject line “Privacy appeal.” We will respond to an appeal
            within 60 days and explain our decision. If you are not satisfied, you may contact the
            attorney general of your state.
          </p>
          <p>
            Because we do not sell personal information, use it for targeted advertising, or use
            it for profiling that produces legal or similarly significant effects, there is
            nothing to opt out of in those areas. We treat a browser’s Global Privacy Control
            signal as a valid opt-out request, and it does not change how the Service works because
            none of those activities happen.
          </p>
        </LegalSub>
        <LegalSub title="Emails">
          <p>
            You choose whether the Weekly Profit Brief is sent and to whom, in Settings. Account,
            security and billing emails are part of the Service and are sent while you have an
            account. If we ever send promotional email, it will include a way to unsubscribe.
          </p>
        </LegalSub>
        <LegalSub title="Data about your customers, vendors and employees">
          <p>
            Your QuickBooks data includes the names of your customers, and transaction descriptions
            can include names of vendors, employees or others. We process that information on your
            behalf, to provide the Service to you. If one of
            those people contacts us about their information, we will refer them to you, and we
            will help you respond to their request.
          </p>
        </LegalSub>
      </LegalSection>

      <LegalSection id="children" title="8. Children">
        <p>
          The Service is for businesses and is not directed to anyone under 18. We do not knowingly
          collect personal information from children. If you believe a child has given us
          information, email <SupportEmail /> and we will delete it.
        </p>
      </LegalSection>

      <LegalSection id="location" title="9. Where information is processed">
        <p>
          JobProfitAI is operated from the United States and our service providers are based in
          the United States. The Service is intended for businesses in the United States. If you
          use it from elsewhere, your information will be transferred to and processed in the
          United States, where data protection laws may differ from those where you are.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="10. Changes to this policy">
        <p>
          We may update this Privacy Policy. If we make a material change, such as using your
          information in a new way or sharing it with a new kind of recipient, we will email the
          address on your account before the change takes effect and update the “Last updated”
          date above. We will not use information collected under this policy in a materially
          different way without telling you first and, where the law requires, getting your
          consent.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="11. Contact">
        <p>
          JobProfitAI is operated by PWL Solutions LLC, an Indiana limited liability company, which
          is responsible for your information under this policy. For privacy questions or
          requests, email <SupportEmail /> or use our{" "}
          <Link href="/contact" className="font-medium text-jp-blue hover:underline">
            contact form
          </Link>
          , or write to us at:
        </p>
        <MailingAddress />
      </LegalSection>
    </LegalPage>
  );
}
