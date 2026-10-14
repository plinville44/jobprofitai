import type { Metadata } from "next";
import Link from "next/link";
import {
  ExternalLink,
  LegalList,
  LegalPage,
  LegalSection,
  LegalSub,
  LEGAL_LAST_UPDATED,
  MailingAddress,
  SupportEmail,
} from "@/components/marketing/Legal";
import { DISCONNECTED_RETENTION_DAYS, LAPSED_DISCONNECT_DAYS, REVOKED_GRANT_GRACE_DAYS } from "@/lib/dataRetention";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "What information JobProfitAI collects, including data read from QuickBooks Online, how it is used and shared, the analytics and advertising cookies on our website, how long it is kept, and your choices.",
  alternates: { canonical: "/privacy" },
};

const linkClass = "font-medium text-jp-blue hover:underline";

const SERVICE_PROVIDERS: { name: string; purpose: string; data: string }[] = [
  {
    name: "Intuit Inc.",
    purpose: "QuickBooks Online authorization and the source of your accounting data",
    data: "Authorization requests and read requests for your QuickBooks company",
  },
  {
    name: "Vercel Inc.",
    purpose: "Hosting the website and application, in the United States",
    data: "All data processed by the application, and standard request logs such as IP address and browser type",
  },
  {
    name: "Neon",
    purpose: "Managed database, stored in the United States",
    data: "All stored account, QuickBooks-derived and billing-status data",
  },
  {
    name: "Stripe, Inc.",
    purpose: "Payments, invoices, the billing portal and referral credits",
    data: "Your name, email, billing details and payment method, which you enter directly with Stripe",
  },
  {
    name: "Resend",
    purpose: "Sending email from the Service",
    data: "Recipient email addresses and email content, including the Weekly Profit Brief",
  },
  {
    name: "Anthropic, PBC",
    purpose: "Generating AI-written insights and summaries, with processing restricted to the United States",
    data: "Calculated profitability information for your jobs, including job names, customer names, job types and figures",
  },
  {
    name: "Functional Software, Inc. (Sentry)",
    purpose: "Error monitoring, and checking that our scheduled jobs run on time",
    data: "When something goes wrong: the kind of error, its message, where in our code it happened, and the page or scheduled job it happened on. For scheduled jobs, when each run starts and finishes and whether it worked. Reports are set up to leave out QuickBooks figures, job and customer names, email addresses and tokens",
  },
  {
    name: "Google LLC (Google Workspace)",
    purpose: "Email accounts our team uses, including for support and outreach",
    data: "The emails we send and receive, and the names, email addresses and anything else written in them",
  },
  {
    name: "HubSpot, Inc.",
    purpose: "Keeping track of the businesses we contact and our conversations with them",
    data: "Business contact information, notes and messages for people we contact or who contact us. Never QuickBooks data",
  },
  {
    name: "Apollo.io",
    purpose: "Finding and checking business contact information",
    data: "Names, job titles, companies and business email addresses of people we may contact",
  },
  {
    name: "Instantly",
    purpose: "Sending outreach email and handling replies",
    data: "Business contact information and the emails we send and receive. It can record whether an email was delivered, opened or answered and whether a link in it was clicked",
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
            an account, people who receive emails from the Service, partners in our partner
            program, and people at businesses we contact about JobProfitAI.
          </p>
          <p>
            In short: we collect what we need to calculate job profitability for your business, and
            we only read from QuickBooks. We never sell your information for money, and we never use
            your QuickBooks data, jobs, customers or figures for advertising. Our public website uses
            Google and LinkedIn analytics and advertising tags, which never run inside the app and
            which you can turn off on our{" "}
            <Link href="/privacy-choices" className={linkClass}>
              Your Privacy Choices
            </Link>{" "}
            page. You can delete your account and its data yourself at any time.
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
              people you invite to your account, when they were invited and whether they accepted,
              and for a view-only client login, which company it shows. Someone who accepts has their
              own account information as above.
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
              <span className="font-medium text-jp-ink">Messages:</span> emails you send us,
              replies to our emails and LinkedIn messages, and our notes from any conversation we
              have with you.
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
            data from it. We process it for you, to provide the Service, and not on Intuit&rsquo;s
            behalf. We copy and store the data needed for job profitability analysis:
          </p>
          <LegalList>
            <li>
              your jobs and their names: projects or sub-customers, customers if you make one
              customer per job, or classes (including class names) if each job is a class, and the
              customer each job belongs to, including customer names;
            </li>
            <li>
              cost lines from bills, checks, expenses, credit card charges and refunds, vendor
              credits and journal entries that are tagged to a job, including the amount, date,
              account or product name, cost category and line description (a description can
              contain whatever text was typed into QuickBooks, such as a vendor or employee name);
            </li>
            <li>
              job cost lines from the last 12 months that aren&rsquo;t tagged to any job, so the
              Data Health page can list them: the date, amount, form (bill, check, expense and so
              on), bill or check number, vendor or payee name, account or product name, and the
              line description or memo (up to 500 characters);
            </li>
            <li>
              time entries, as the employee&rsquo;s name, hours and a labor cost calculated from
              the cost rate on the entry, which comes from the employee&rsquo;s cost rate in
              QuickBooks. We don&rsquo;t store the cost rate itself, but it can be worked out from a
              single entry, so anyone with a login to your account can see it. You can turn off
              labor from timesheets in Settings;
            </li>
            <li>
              invoice, sales receipt, credit memo and refund totals, sales tax amounts, dates and
              payment status, and what is still owed on each open invoice;
            </li>
            <li>
              income recorded against a job without an invoice, from deposits and journal entries:
              the amount and date of each line;
            </li>
            <li>
              estimates: the number, date, expiry date, status, whether QuickBooks has emailed it,
              the customer or project it names, and each line&rsquo;s product or service name,
              amount, quantity, cost category and the purchase cost set on that product or service
              in QuickBooks (not line descriptions); and
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
            partner program activity. We also save month-end copies of your Work in Progress schedule
            (job and customer names, each job&rsquo;s contract, cost, billing and profit figures, and
            the totals), and delete them when you delete your account. If you arrived from one of our
            ads or a link with campaign tags, we save where you came from with your account when you
            sign up (see Section 2).
          </p>
          <p>
            When you agree to our Terms of Service and this policy, we record which version you
            agreed to, when, how (the signup box, a later prompt, or Stripe checkout), a keyed one-way
            hash of your network address and your browser&rsquo;s user agent. We also record your
            privacy choices on your account (Section 8) and whether you&rsquo;ve turned off tips and
            reminder emails.
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

        <LegalSub title="Information from other sources">
          <LegalList>
            <li>
              <span className="font-medium text-jp-ink">Business contact information:</span> to find
              contractors and bookkeepers who may want JobProfitAI, we collect business contact
              information about owners and staff of contracting, construction and bookkeeping
              businesses from business contact databases (currently Apollo.io), from LinkedIn
              (including LinkedIn Sales Navigator), from company websites and other public business
              listings, and from people who refer a business to us. This can include name, job
              title, company name, industry, size and location, business email address, business
              phone number and LinkedIn profile address. Section 3 explains how we use it.
            </li>
            <li>
              <span className="font-medium text-jp-ink">Advertising and analytics reports:</span>{" "}
              Google and LinkedIn give us reports about how our ads and website perform. These are
              mostly totals, such as how many people clicked an ad or started a trial.
            </li>
          </LegalList>
        </LegalSub>

        <LegalSub title="Information collected automatically">
          <p>
            Like most websites, our hosting provider records standard request information such as
            IP address, browser type, pages requested and time. For the contact form we store a
            one-way hash of your IP address, not the address itself, along with your browser’s user
            agent, to limit abuse. On our public website pages, analytics and advertising tags also
            collect information about your visit, as Section 2 describes.
          </p>
        </LegalSub>
      </LegalSection>

      <LegalSection id="cookies" title="2. Cookies, analytics and advertising">
        <LegalSub title="Where our tags run">
          <p>
            Our website uses Google Tag Manager to load Google Analytics, Google Ads and the LinkedIn
            Insight Tag. These tags run only on our public website pages, such as the homepage,
            pricing, the sample-data demo and our ad landing pages, and on the signup page. They never
            run inside the JobProfitAI app: not on your dashboard, job pages, reports, settings or
            billing pages, where your QuickBooks figures, jobs and customers are shown. They
            don&rsquo;t load at all if your browser sends Global Privacy Control or you turn them off
            on our{" "}
            <Link href="/privacy-choices" className={linkClass}>
              Your Privacy Choices
            </Link>{" "}
            page.
          </p>
          <p>
            Because our tags don&rsquo;t run in the app, they can&rsquo;t see your QuickBooks data, and
            we don&rsquo;t send Google, LinkedIn or any other analytics or advertising company your
            QuickBooks data, job or customer names, or financial figures.
          </p>
        </LegalSub>

        <LegalSub title="Google Analytics">
          <p>
            Google Analytics, a service of Google LLC, tells us how people find and use our website.
            Using cookies, it collects the pages you view; the website, search, ad or link that
            brought you here, including any campaign tags in the link; your device, browser, screen
            size and language; your approximate location, worked out from your IP address; and steps
            you take, such as playing our demo video or starting a trial. We link Google Analytics to
            our Google Ads account, so the visits it measures can also be used to measure our ads and
            to choose who sees them. Google explains what it does with this information in{" "}
            <ExternalLink href="https://policies.google.com/technologies/partner-sites">
              How Google uses information from sites or apps that use its services
            </ExternalLink>
            . You can stop Google Analytics from collecting information in your browser with the{" "}
            <ExternalLink href="https://tools.google.com/dlpage/gaoptout">
              Google Analytics opt-out browser add-on
            </ExternalLink>
            .
          </p>
        </LegalSub>

        <LegalSub title="Google Ads">
          <p>
            We advertise on Google, including Google Search and YouTube. Google Ads tags and cookies
            tell us which ad clicks lead to trials and subscriptions, and let us show our ads to
            people who have visited our website, which is called remarketing. Third-party vendors,
            including Google, use cookies to show ads based on your past visits to our website and
            other websites. Google&rsquo;s use of advertising cookies lets Google and its partners
            show you ads based on your visits to our site and other sites on the internet. You can
            opt out of personalized advertising in{" "}
            <ExternalLink href="https://adssettings.google.com">Google&rsquo;s ad settings</ExternalLink>
            , and opt out of personalized ads from many other companies on the{" "}
            <ExternalLink href="https://optout.networkadvertising.org">
              Network Advertising Initiative
            </ExternalLink>{" "}
            and{" "}
            <ExternalLink href="https://optout.aboutads.info">Digital Advertising Alliance</ExternalLink>{" "}
            opt-out pages.
          </p>
          <p>
            <span className="font-medium text-jp-ink">Enhanced conversions:</span> when you create an
            account, we may send Google a hashed copy of the email address you signed up with.
            Hashing turns the address into a fixed code (SHA-256). That code is not anonymous: anyone
            who already has the same address can produce the same code, which is exactly how Google
            matches it to people signed in to Google and tells us whether one of our ads led to the
            signup. Google says it uses this data only to provide its measurement services to us and
            doesn&rsquo;t share it with other advertisers.
          </p>
        </LegalSub>

        <LegalSub title="LinkedIn">
          <p>
            The LinkedIn Insight Tag, from LinkedIn Corporation, tells us which LinkedIn ads lead to
            visits and trials, gives us totals about the job titles, industries and company sizes of
            our visitors, and lets us show our ads on LinkedIn to people who have visited our
            website. It collects the page address, the page you came from, your IP address, your
            device and browser, and the time, and LinkedIn&rsquo;s cookies may connect the visit to
            your LinkedIn account if you are signed in to LinkedIn. LinkedIn shows us totals; it
            doesn&rsquo;t tell us who you are. LinkedIn uses this information under its{" "}
            <ExternalLink href="https://www.linkedin.com/legal/privacy-policy">privacy policy</ExternalLink>{" "}
            and{" "}
            <ExternalLink href="https://www.linkedin.com/legal/cookie-policy">cookie policy</ExternalLink>.
          </p>
        </LegalSub>

        <LegalSub title="Steps reported from our servers">
          <p>
            Some steps happen inside the app, where our tags never run, such as connecting
            QuickBooks and starting a subscription. When you take one, our servers may tell Google
            Analytics, Google Ads and LinkedIn that it happened, with the plan, the amount and a
            reference number, linked to the Google Analytics browser ID and ad click ID saved when
            you signed up. These reports never include your name or anything from QuickBooks, and
            include your email address only in the hashed form described above. We don&rsquo;t send
            them for an account that has opted out. An opt-out is saved on your account when you make
            it while signed in to JobProfitAI (on Your Privacy Choices, or by your browser sending
            Global Privacy Control), when it was in effect in your browser at signup, or when you ask
            us by email. From then on these reports stop, including for steps that happen later,
            such as a renewal.
          </p>
        </LegalSub>

        <LegalSub title="Where you came from">
          <p>
            When you arrive from one of our ads or a link with campaign tags, we save the ad click ID
            (Google&rsquo;s gclid), the campaign tags (utm_source, utm_medium, utm_campaign and
            utm_term) and the first page you landed on in our own cookie, jpai_src, for 90 days. If you
            sign up, we copy them onto your account so we can see which ads and links bring
            customers, not just visits. We don&rsquo;t set this cookie if you have opted out or your
            browser sends Global Privacy Control.
          </p>
        </LegalSub>

        <LegalSub title="Videos">
          <p>
            Our demo videos may be hosted on YouTube, a Google service. We show a picture of the video
            until you click play, and use YouTube&rsquo;s privacy-enhanced mode, so YouTube sets no
            cookies before you play. Once you play a video, YouTube may set cookies and collect
            information under{" "}
            <ExternalLink href="https://policies.google.com/privacy">Google&rsquo;s privacy policy</ExternalLink>.
          </p>
        </LegalSub>

        <LegalSub title="Cookies we use">
          <p>These cookies are needed for the Service to work. They are first-party and always on:</p>
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
            <li>
              <span className="font-medium text-jp-ink">jpai_optout</span> is set only if you turn
              off analytics and advertising on our Your Privacy Choices page. It remembers that
              choice for about 13 months.
            </li>
          </LegalList>
          <p>
            These cookies are for analytics and advertising. They are set only on our public website
            pages and the signup page, and not at all if you opt out or your browser sends Global
            Privacy Control:
          </p>
          <LegalList>
            <li>
              <span className="font-medium text-jp-ink">jpai_src</span>, our own cookie, remembers
              where you came from for 90 days, as described above.
            </li>
            <li>
              <span className="font-medium text-jp-ink">_ga</span> and{" "}
              <span className="font-medium text-jp-ink">_ga_</span> followed by an ID, from Google
              Analytics, tell visits apart and keep track of a visit, for up to 2 years.
            </li>
            <li>
              <span className="font-medium text-jp-ink">_gcl_au</span>,{" "}
              <span className="font-medium text-jp-ink">_gcl_aw</span> and other cookies starting{" "}
              <span className="font-medium text-jp-ink">_gcl_</span>, from Google Ads, connect ad
              clicks to trials and subscriptions, for 90 days.
            </li>
            <li>
              Google&rsquo;s cookies on its own domains (doubleclick.net, google.com and
              googleadservices.com), such as <span className="font-medium text-jp-ink">IDE</span>{" "}
              (ads and fraud prevention, up to 2 years),{" "}
              <span className="font-medium text-jp-ink">test_cookie</span> (15 minutes) and{" "}
              <span className="font-medium text-jp-ink">ar_debug</span> (90 days).
            </li>
            <li>
              LinkedIn&rsquo;s cookies, such as <span className="font-medium text-jp-ink">li_sugr</span>{" "}
              (90 days), <span className="font-medium text-jp-ink">bcookie</span> (1 year),{" "}
              <span className="font-medium text-jp-ink">lidc</span> (1 day), and{" "}
              <span className="font-medium text-jp-ink">li_fat_id</span>,{" "}
              <span className="font-medium text-jp-ink">UserMatchHistory</span> and{" "}
              <span className="font-medium text-jp-ink">AnalyticsSyncHistory</span> (30 days each),
              which recognize your browser, measure LinkedIn ads and show them to past visitors.
            </li>
          </LegalList>
          <p>
            Google and LinkedIn can change the names and lifetimes of their cookies. Their own pages
            have the current lists:{" "}
            <ExternalLink href="https://policies.google.com/technologies/cookies">Google</ExternalLink> and{" "}
            <ExternalLink href="https://www.linkedin.com/legal/cookie-policy">LinkedIn</ExternalLink>.
            Our payment pages are hosted by Stripe, which sets its own cookies under{" "}
            <ExternalLink href="https://stripe.com/privacy">Stripe’s privacy policy</ExternalLink>. You
            can also block or delete cookies in your browser&rsquo;s settings; if you block the cookies
            the Service needs, you won&rsquo;t be able to sign in.
          </p>
        </LegalSub>

        <LegalSub title="Global Privacy Control and Do Not Track">
          <p>
            We treat a Global Privacy Control signal from your browser as a valid request to opt out
            of the sale or sharing of your personal information and of targeted advertising. When we
            receive it, our analytics and advertising tags don&rsquo;t load, and our Your Privacy
            Choices page shows that the signal was received and honored. Some browsers also send a
            &ldquo;Do Not Track&rdquo; signal. There is no agreed standard for what it means, so we
            don&rsquo;t respond to it. Use Global Privacy Control or our Your Privacy Choices page
            instead.
          </p>
        </LegalSub>

        <LegalSub title="Visitors outside the United States">
          <p>
            JobProfitAI is for businesses in the United States. For visitors in the European Economic
            Area, the United Kingdom and Switzerland, our Google tags run with their cookies and
            advertising features turned off, and our LinkedIn tag doesn&rsquo;t run.
          </p>
        </LegalSub>
      </LegalSection>

      <LegalSection id="use" title="3. How we use information">
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
          <li>
            To understand how people find and use our website, and which ads and links bring trials
            and paying customers.
          </li>
          <li>
            To advertise JobProfitAI on Google (including YouTube), LinkedIn and other websites,
            including to people who have visited our website.
          </li>
          <li>
            To contact people at contracting, construction and bookkeeping businesses about
            JobProfitAI by email and LinkedIn message, using the business contact information
            described in Section 1, to follow up with people who reply, and to keep a record of those
            conversations.
          </li>
          <li>To comply with law and enforce our Terms of Service.</li>
        </LegalList>
        <p>
          Near the end of a trial we may ask whether you would be willing to give a testimonial.
          That request is optional, it is never a condition of anything, and we do not publish
          anything you say without your separate permission.
        </p>
        <p>
          We do not sell personal information for money. We do not use your QuickBooks data, or the
          jobs, customers and figures in your account, for any purpose other than providing the
          Service to you, and we never share them with advertising or analytics companies. Letting
          Google and LinkedIn collect information through cookies on our website, so that our ads can
          be shown to people who visited, may count as a &ldquo;sale&rdquo; or &ldquo;sharing&rdquo;
          of personal information, or as targeted advertising, under some state privacy laws. You
          can opt out as Section 8 describes.
        </p>
      </LegalSection>

      <LegalSection id="ai" title="4. Artificial intelligence">
        <p>
          Profit insights and the written summary in the Weekly Profit Brief are generated using
          Anthropic’s Claude API. To produce them, we send Anthropic the calculated profitability
          information for your jobs, which includes job names, the customer names attached to
          them, job types and calculated figures. When you ask for suggested job types, we send
          the names of the jobs that don&rsquo;t have one, their customer names, and the names of
          your job types. If a written summary breaks one of our accuracy rules, we send it back
          once with the sentences at fault and the reason. We never send your QuickBooks credentials
          or access tokens.
        </p>
        <p>
          We ask Anthropic to run these requests only on infrastructure in the United States, and
          Anthropic stores API data in the United States. Anthropic says it may also process data
          in other countries where it or its affiliates operate for its own safety review, product
          support and incident response.
        </p>
        <p>
          Under Anthropic’s commercial terms, data sent through its API is not used to train its
          models without permission, and we have not given that permission. Anthropic deletes API
          inputs and outputs within 30 days, except that it keeps data flagged for a usage policy
          violation for up to 2 years, and keeps data where the law requires. We don&rsquo;t use
          Anthropic features that store data for longer, such as its Files API.
        </p>
      </LegalSection>

      <LegalSection id="share" title="5. How we share information">
        <p>We share information only in these ways:</p>
        <LegalSub title="Service providers">
          <p>
            We use the companies below to run the Service and our business. They process information
            on our behalf and under their own terms and privacy commitments, and only for the
            purposes listed.
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
        <LegalSub title="Advertising and analytics companies">
          <p>
            Google LLC and LinkedIn Corporation receive information through their tags on our public
            website pages, and the steps reported from our servers, as Section 2 describes. They use
            it to provide their services to us, and also for their own purposes, including showing
            ads, under their own privacy policies:{" "}
            <ExternalLink href="https://policies.google.com/privacy">Google</ExternalLink> and{" "}
            <ExternalLink href="https://www.linkedin.com/legal/privacy-policy">LinkedIn</ExternalLink>.
          </p>
        </LegalSub>
        <LegalSub title="Contractors who help with outreach">
          <p>
            We work with independent contractors, who may be located outside the United States, to
            find and contact businesses that may want JobProfitAI and to answer their questions. They
            use business contact information, the messages we exchange with those businesses, and the
            outreach tools listed above. They have no access to the JobProfitAI app, to customer
            accounts or to QuickBooks data, and they must keep the information confidential and use
            it only for our work.
          </p>
        </LegalSub>
        <LegalSub title="People you choose">
          <p>
            If you add recipients to the Weekly Profit Brief, we send it to them. The brief
            contains your job names, customer names and profitability figures. Team members you
            invite see the companies on your account, and a view-only client login sees only the
            one company you choose for it.
          </p>
        </LegalSub>
        <LegalSub title="Firm accounts">
          <p>
            A bookkeeper or accounting firm on our Firm plan connects its clients&rsquo; QuickBooks
            companies to its own account. The firm is the account holder: it and the team members
            it invites see every client company it connects, and it controls each connection, the
            settings and deletion. One client of a firm never sees another client&rsquo;s company.
            Each view-only client login the firm creates sees one company, and can&rsquo;t change
            anything. When a client leaves, the firm can delete that client&rsquo;s company data from
            Settings without affecting its other clients, and that company&rsquo;s client logins
            lose access. If your QuickBooks company was connected by a firm and you ask us about its
            data, we will direct you to the firm, except where the law requires otherwise.
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

      <LegalSection id="retention" title="6. How long we keep information">
        <LegalList>
          <li>
            <span className="font-medium text-jp-ink">While a company is connected:</span> we keep
            its QuickBooks-derived data, and your account and settings, so the Service can show
            your history.
          </li>
          <li>
            <span className="font-medium text-jp-ink">When a company is disconnected:</span>{" "}
            whether you disconnect it in Settings or in your Intuit account, we stop syncing it and
            stop all use of its data at once. We keep the data untouched for{" "}
            {DISCONNECTED_RETENTION_DAYS} days, so reconnecting the same company brings its history
            back, and then delete it. We email the account owner a week before. If QuickBooks stops
            letting us read a company, for example because you disconnected JobProfitAI from your
            Intuit account while signed out of JobProfitAI, nothing can be synced from then on, and
            if it isn&rsquo;t reconnected within {REVOKED_GRANT_GRACE_DAYS} days we treat it as
            disconnected.
          </li>
          <li>
            <span className="font-medium text-jp-ink">When an account has no trial or plan:</span>{" "}
            if your account goes {LAPSED_DISCONNECT_DAYS} days without an active trial or
            subscription, we disconnect its QuickBooks companies and email you, and the{" "}
            {DISCONNECTED_RETENTION_DAYS}-day period above begins. Your login and settings stay
            until you delete them.
          </li>
          <li>
            <span className="font-medium text-jp-ink">Deleting one company:</span> you can delete a
            company&rsquo;s data at any time from Settings, connected or not, without deleting your
            account. We delete its jobs, cost data, time entries, invoices, estimates, Weekly Profit
            Briefs, alerts, insights, month-end WIP copies, job types, settings and client logins.
          </li>
          <li>
            <span className="font-medium text-jp-ink">When you delete your account:</span> we
            revoke any live QuickBooks connection with Intuit, cancel any subscription, and delete
            your account together with your QuickBooks connections and tokens, jobs, cost data,
            invoices, estimates, Weekly Profit Briefs, alerts, insights, settings, team and client
            login invitations, trial feedback, in-app feedback, referral codes and the referrals
            and credits made through them, any partner application and its commission records,
            email records, your records of accepting our Terms, your privacy and email choices, and
            the record of where you came from. Team members and client logins you
            invited lose access at once; their own logins remain theirs to delete.
          </li>
          <li>
            <span className="font-medium text-jp-ink">What we keep after deletion:</span> if you
            were referred by a partner, the commission records for payments you made are kept so
            the partner can be paid and our accounts reconcile. They contain amounts, dates and
            internal and Stripe reference numbers, not your name, email or any QuickBooks data. A
            record that a referral link led to an account is also kept with your account removed
            from it. The one-free-trial-per-company record (a keyed hash of the QuickBooks company
            ID, the date and an internal account number) is kept, including for a company whose data
            was deleted, so the same company can&rsquo;t start another trial. Stripe keeps its own records of your payments, as payment processors are
            required to. We may also keep information we are legally required to keep, such as
            tax and accounting records.
          </li>
          <li>
            <span className="font-medium text-jp-ink">Website analytics:</span> Google Analytics
            keeps the details of visits to our website for 14 months, then deletes them. Google and
            LinkedIn keep what their own cookies collect under their own policies.
          </li>
          <li>
            <span className="font-medium text-jp-ink">Businesses we contact:</span> we keep business
            contact information and our messages while we are in touch. At least once a year we
            delete the records of people we haven&rsquo;t been in touch with for 2 years, unless they
            became customers. If you ask us not to contact you, we keep your email address and the
            date of your request on a do-not-contact list, so that we don&rsquo;t contact you again.
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

      <LegalSection id="security" title="7. Security">
        <p>
          We use safeguards designed to protect your information, including encryption of
          QuickBooks tokens and company IDs at the application level, hashed passwords, signed
          HTTP-only session cookies, HTTPS for all traffic, server-side checks that every request
          for financial data comes from the account that owns it, error logs that exclude raw
          QuickBooks responses, and keeping analytics and advertising tags out of the app. Our{" "}
          <Link href="/security" className={linkClass}>
            Security page
          </Link>{" "}
          describes these controls in more detail, including the certifications we do not hold.
          No method of storage or transmission is completely secure. If a breach affects your
          personal information, we will notify you as required by law.
        </p>
      </LegalSection>

      <LegalSection id="rights" title="8. Your choices and rights">
        <LegalSub title="What you can do yourself">
          <LegalList>
            <li>
              Change your target margin, overhead settings, and Weekly Profit Brief recipients and
              schedule in Settings. To change the name or email address on your account, email{" "}
              <SupportEmail />.
            </li>
            <li>Disconnect QuickBooks from Settings or from your Intuit account at any time.</li>
            <li>Cancel your subscription from Billing.</li>
            <li>
              Delete one company&rsquo;s data from Settings, connected or not, without deleting your
              account. A firm can remove a client&rsquo;s company this way.
            </li>
            <li>Delete your account and all of its data from Settings at any time.</li>
            <li>
              Turn off our analytics and advertising tags in your browser on our{" "}
              <Link href="/privacy-choices" className={linkClass}>
                Your Privacy Choices
              </Link>{" "}
              page.
            </li>
          </LegalList>
        </LegalSub>
        <LegalSub title="Requests you can make">
          <p>
            You can ask us to confirm whether we process your personal information, give you a
            copy of it in a portable format, correct it, or delete it. Email <SupportEmail /> from
            the address on your account, or tell us how to reach you if you do not have an
            account. We will verify your request before acting on it, and we respond within 45
            days. If we need more time, which the law allows in some cases, we will tell you why.
            These requests are free of charge. We offer these rights to everyone, including people
            we have contacted about JobProfitAI, wherever you live and not only where a law requires
            it.
          </p>
          <p>
            If we decline your request, you can appeal by replying to our decision or emailing{" "}
            <SupportEmail /> with the subject line “Privacy appeal.” We will respond to an appeal
            within 60 days and explain our decision. If you are not satisfied, you may contact the
            attorney general of your state.
          </p>
        </LegalSub>
        <LegalSub title="Opting out of sale, sharing and targeted advertising">
          <p>
            You can opt out on our{" "}
            <Link href="/privacy-choices" className={linkClass}>
              Your Privacy Choices
            </Link>{" "}
            page, by turning on Global Privacy Control in your browser, or by emailing{" "}
            <SupportEmail /> with the subject line &ldquo;Opt out.&rdquo; In your browser, opting out
            stops our analytics and advertising tags and our jpai_src cookie. When we know it&rsquo;s
            you, because you&rsquo;re signed in to JobProfitAI when you opt out or your browser sends
            Global Privacy Control, or you email us, we also save the opt-out on your account, so it
            applies in every browser where you sign in to JobProfitAI and stops anything we would
            report about your account to Google and LinkedIn from our servers. Turning the tags back on from Your Privacy Choices undoes
            only an opt-out made on that page; one from Global Privacy Control or email stays until
            you ask us.
            We don&rsquo;t use personal information for profiling that produces legal or similarly
            significant effects. We don&rsquo;t ask for or deliberately extract Social Security
            numbers, bank account numbers, health information or precise location, and we use your
            password only to sign you in. Free-text fields, such as messages you send us and the
            descriptions and memos copied from QuickBooks, can contain whatever someone typed into
            them; we handle that text as part of the information it came with and don&rsquo;t use it
            for anything else.
          </p>
        </LegalSub>
        <LegalSub title="Emails and messages">
          <p>
            You choose whether the Weekly Profit Brief is sent and to whom, in Settings. Account,
            security, billing and trial-status emails, such as the notice that your trial is ending,
            are part of the Service and are sent while you have an account. Tips and reminders, such
            as setup reminders, product tips, feedback requests and trial extension offers, include an
            unsubscribe link. Marketing
            emails, including the emails we send to businesses we contact, include a way to
            unsubscribe too, and we stop within 10 business days of your request. To stop LinkedIn messages from us, reply to say so.
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

      <LegalSection id="children" title="9. Children">
        <p>
          The Service is for businesses and is not directed to anyone under 18. We do not knowingly
          collect personal information from children. If you believe a child has given us
          information, email <SupportEmail /> and we will delete it.
        </p>
      </LegalSection>

      <LegalSection id="location" title="10. Where information is processed">
        <p>
          JobProfitAI is operated from the United States, and the Service is intended for businesses
          in the United States.
        </p>
        <LegalList>
          <li>
            <span className="font-medium text-jp-ink">Stored in the United States:</span> your
            account and the QuickBooks data we copy, in our database (Neon) and hosting (Vercel).
          </li>
          <li>
            <span className="font-medium text-jp-ink">Processed in the United States:</span> the
            app itself, and the AI write-ups, which we ask Anthropic to run only on US
            infrastructure. Our email and error-monitoring providers (Resend and Sentry) handle their
            parts in the United States.
          </li>
          <li>
            <span className="font-medium text-jp-ink">Handled elsewhere in some cases:</span>{" "}
            Anthropic may access data from other countries for its own safety review, support and
            incident response. Stripe processes payments in many countries. Google Workspace may
            store our email, including messages you send us, outside the United States. Google and
            LinkedIn may process what their tags collect in other countries. Contractors who help
            with outreach may work from other countries and handle business contact information and
            outreach messages there.
          </li>
        </LegalList>
        <p>
          If you use the Service from outside the United States, your information will be
          transferred to and processed in the United States, where data protection laws may differ
          from those where you are.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="11. Changes to this policy">
        <p>
          We may update this Privacy Policy. If we make a material change, such as using your
          information in a new way or sharing it with a new kind of recipient, we will email the
          address on your account before the change takes effect and update the “Last updated”
          date above. We will not use information collected under this policy in a materially
          different way without telling you first and, where the law requires, getting your
          consent.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="12. Contact">
        <p>
          JobProfitAI is operated by PWL Solutions LLC, an Indiana limited liability company, which
          is responsible for your information under this policy. For privacy questions or
          requests, email <SupportEmail /> or use our{" "}
          <Link href="/contact" className={linkClass}>
            contact form
          </Link>
          , or write to us at:
        </p>
        <MailingAddress />
      </LegalSection>
    </LegalPage>
  );
}
