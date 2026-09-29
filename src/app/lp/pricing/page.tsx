import LandingPage, { landingMetadata } from "@/components/marketing/LandingPage";

// Ad landing page for the "pricing" ad group. Copy lives in src/lib/landingPages.ts.
export const metadata = landingMetadata("pricing");

export default function Page() {
  return <LandingPage slug="pricing" />;
}
