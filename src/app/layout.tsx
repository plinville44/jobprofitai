import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "JobProfitAI — Weekly job-cost accuracy for contractors",
  description:
    "A weekly AI-written digest that tells you which jobs are on track and which are bleeding margin, straight from your QuickBooks data.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-navy antialiased">{children}</body>
    </html>
  );
}
