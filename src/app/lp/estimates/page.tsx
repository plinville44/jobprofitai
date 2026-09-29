import LandingPage, { landingMetadata } from "@/components/marketing/LandingPage";

// Ad landing page for the "estimates" ad group. Copy lives in src/lib/landingPages.ts.
export const metadata = landingMetadata("estimates");

export default function Page() {
  return <LandingPage slug="estimates" />;
}
