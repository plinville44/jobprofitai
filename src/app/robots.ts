import type { MetadataRoute } from "next";

/**
 * Keeps crawlers out of everything that isn't a public marketing page.
 *
 * /dashboard and /api are disallowed because they're authenticated and
 * useless as search results; /r/ is disallowed so referral links don't get
 * indexed and attributed to a crawler.
 */
export default function robots(): MetadataRoute.Robots {
  const base = (process.env.APP_URL ?? "https://jobprofitai.com").replace(/\/+$/, "");

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // /reset-password carries a live credential in its query string, so
        // it must never be indexed. /forgot-password is excluded for the
        // same reason /login is: it is a form, not a page anyone should
        // arrive at from a search result.
        disallow: [
          "/api/",
          "/dashboard/",
          "/r/",
          "/login",
          "/signup",
          "/forgot-password",
          "/reset-password",
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
