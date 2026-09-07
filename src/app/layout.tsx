import type { Metadata } from "next";
import "./globals.css";

/**
 * Root metadata. Individual pages override `title` via the template below
 * and set their own description/canonical - see each page's `metadata`
 * export. metadataBase is what makes relative Open Graph image paths resolve
 * to absolute URLs, which social platforms require.
 */
const siteUrl = process.env.APP_URL ?? "https://jobprofitai.com";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "JobProfitAI: Profit Intelligence for QuickBooks",
    template: "%s | JobProfitAI",
  },
  description:
    "JobProfitAI turns your QuickBooks data into clear job profitability, margin insights, profit alerts and actionable recommendations for contractors.",
  applicationName: "JobProfitAI",
  keywords: [
    "job profitability",
    "job costing",
    "contractor profitability",
    "QuickBooks Online",
    "construction margin",
    "profit intelligence",
  ],
  authors: [{ name: "PWL Solutions LLC" }],
  openGraph: {
    type: "website",
    siteName: "JobProfitAI",
    title: "JobProfitAI: Profit Intelligence for QuickBooks",
    description:
      "Know which jobs are making you money, and which ones are costing you. JobProfitAI turns QuickBooks data into job profitability, margin insights and clear next actions.",
    url: siteUrl,
  },
  twitter: {
    card: "summary_large_image",
    title: "JobProfitAI: Profit Intelligence for QuickBooks",
    description:
      "Know which jobs are making you money, and which ones are costing you.",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-navy antialiased">{children}</body>
    </html>
  );
}
