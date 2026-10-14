import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection, LEGAL_LAST_UPDATED, SupportEmail } from "@/components/marketing/Legal";
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
          Our public website uses Google Analytics, which also measures our Google Ads, to see how
          people find us and which ads work. It never runs inside the JobProfitAI app and never sees
          your QuickBooks data. Some state laws treat this kind of measurement as a &ldquo;sale&rdquo;
          or &ldquo;sharing&rdquo; of personal information. You can opt out here. Our{" "}
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
          Opting out stops our tags from collecting anything new in this browser. If you&rsquo;re signed in
          to JobProfitAI when you opt out, or the next time you sign in from this browser, we also save the
          choice on your account, so it applies wherever you sign in and we stop reporting your sign-up,
          QuickBooks connection, checkout or subscription to Google from our servers. If you sign up while
          opted out, we never report them.
        </p>
        <p>
          Opting out doesn&rsquo;t delete what Google already holds. You can manage that in{" "}
          <a href="https://adssettings.google.com" className={linkClass} rel="noopener noreferrer" target="_blank">
            Google&rsquo;s ad settings
          </a>
          , and stop Google Analytics on every website with the{" "}
          <a href="https://tools.google.com/dlpage/gaoptout" className={linkClass} rel="noopener noreferrer" target="_blank">
            Google Analytics opt-out browser add-on
          </a>
          .
        </p>
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
