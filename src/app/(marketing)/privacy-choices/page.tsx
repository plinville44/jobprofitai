import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection, LegalList, LEGAL_LAST_UPDATED, SupportEmail } from "@/components/marketing/Legal";
import PrivacyChoices from "@/components/marketing/PrivacyChoices";

export const metadata: Metadata = {
  title: "Your Privacy Choices",
  description:
    "Turn off the analytics and advertising tags on the JobProfitAI website, opt out of the sale or sharing of personal information and targeted advertising, and make other privacy requests.",
  alternates: { canonical: "/privacy-choices" },
};

const linkClass = "font-medium text-jp-blue hover:underline";

export default function PrivacyChoicesPage() {
  return (
    <LegalPage
      title="Your Privacy Choices"
      updated={LEGAL_LAST_UPDATED}
      intro={
        <p>
          Our public website uses Google Analytics, Google Ads and the LinkedIn Insight Tag to measure
          our ads and to show our ads to people who have visited us. They never run inside the
          JobProfitAI app and never see your QuickBooks data. Some state laws treat this kind of
          advertising as a &ldquo;sale&rdquo; or &ldquo;sharing&rdquo; of personal information. You
          can opt out here. Our{" "}
          <Link href="/privacy#cookies" className={linkClass}>
            Privacy Policy
          </Link>{" "}
          explains these tools in full.
        </p>
      }
    >
      <LegalSection id="this-browser" title="Opt out in this browser">
        <PrivacyChoices />
        <p>
          Your choice is saved in a cookie in this browser. If you clear your cookies, or use another
          browser or device, make the choice there too. A browser or extension that sends{" "}
          <a href="https://globalprivacycontrol.org" className={linkClass} rel="noopener noreferrer" target="_blank">
            Global Privacy Control
          </a>{" "}
          does this for you on every site that honors it, including ours.
        </p>
        <p>
          Opting out stops our tags from collecting anything new in this browser, and we won&rsquo;t send
          Google or LinkedIn your sign-up or subscription from our servers if you sign up while opted out.
          It doesn&rsquo;t delete what Google and LinkedIn already hold. You can manage that with them:
        </p>
        <LegalList>
          <li>
            <a href="https://adssettings.google.com" className={linkClass} rel="noopener noreferrer" target="_blank">
              Google&rsquo;s ad settings
            </a>{" "}
            and the{" "}
            <a href="https://tools.google.com/dlpage/gaoptout" className={linkClass} rel="noopener noreferrer" target="_blank">
              Google Analytics opt-out browser add-on
            </a>
            ;
          </li>
          <li>
            LinkedIn&rsquo;s advertising settings in your LinkedIn account, or its{" "}
            <a
              href="https://www.linkedin.com/psettings/guest-controls"
              className={linkClass}
              rel="noopener noreferrer"
              target="_blank"
            >
              guest controls
            </a>{" "}
            if you don&rsquo;t have an account; and
          </li>
          <li>
            the industry opt-out pages of the{" "}
            <a href="https://optout.networkadvertising.org" className={linkClass} rel="noopener noreferrer" target="_blank">
              Network Advertising Initiative
            </a>{" "}
            and the{" "}
            <a href="https://optout.aboutads.info" className={linkClass} rel="noopener noreferrer" target="_blank">
              Digital Advertising Alliance
            </a>
            .
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection id="other-requests" title="Other requests">
        <p>
          To opt out by email instead, or to ask us to access, correct or delete your information, or to
          stop contacting you, email <SupportEmail />. We don&rsquo;t sell personal information for money,
          and we never use your QuickBooks data, jobs, customers or figures for advertising. The{" "}
          <Link href="/privacy#rights" className={linkClass}>
            Your choices and rights
          </Link>{" "}
          section of our Privacy Policy explains each request and how we handle it.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
