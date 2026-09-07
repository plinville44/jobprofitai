import type { MetadataRoute } from "next";

/**
 * Sitemap covering the public marketing pages only.
 *
 * Authenticated routes (/dashboard/*), API routes and the referral landing
 * pages are deliberately excluded - they're either private or not useful
 * search results.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = (process.env.APP_URL ?? "https://jobprofitai.com").replace(/\/+$/, "");
  const now = new Date();

  const routes: { path: string; priority: number; changeFrequency: "monthly" | "yearly" }[] = [
    { path: "/", priority: 1, changeFrequency: "monthly" },
    { path: "/how-it-works", priority: 0.9, changeFrequency: "monthly" },
    { path: "/pricing", priority: 0.9, changeFrequency: "monthly" },
    { path: "/security", priority: 0.7, changeFrequency: "monthly" },
    { path: "/partners", priority: 0.7, changeFrequency: "monthly" },
    { path: "/contact", priority: 0.6, changeFrequency: "yearly" },
    { path: "/privacy", priority: 0.3, changeFrequency: "yearly" },
    { path: "/terms", priority: 0.3, changeFrequency: "yearly" },
  ];

  return routes.map((route) => ({
    url: `${base}${route.path}`,
    lastModified: now,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
