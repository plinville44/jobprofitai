import LandingPage, { landingMetadata } from "@/components/marketing/LandingPage";

// Ad landing page for the "job-profit" ad group. Copy lives in src/lib/landingPages.ts.
export const metadata = landingMetadata("job-profit");

export default function Page() {
  return <LandingPage slug="job-profit" />;
}
