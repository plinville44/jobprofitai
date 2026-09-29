import LandingPage, { landingMetadata } from "@/components/marketing/LandingPage";

// Ad landing page for the "wip" ad group. Copy lives in src/lib/landingPages.ts.
export const metadata = landingMetadata("wip");

export default function Page() {
  return <LandingPage slug="wip" />;
}
