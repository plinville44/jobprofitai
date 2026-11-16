/**
 * Response headers for every page and endpoint, set here so no route can
 * forget them. They follow Intuit's security requirements for apps on the
 * QuickBooks App Store (src/lib/__tests__/intuitReview.test.ts checks them):
 *
 *  - Caching off ("no-cache" and "no-store", not just "private") on every
 *    page and every API response, so neither the browser nor anything in
 *    between keeps a copy. Next.js's own hashed files, resized images and
 *    the plain image and text files in public/ keep their normal caching;
 *    they hold no account data.
 *  - The usual protections against clickjacking, content sniffing and
 *    leaking a page's address to other sites.
 *  - No Referer header at all from the pages a one-time link opens (password
 *    reset, email verification, invitations, unsubscribe) or the QuickBooks
 *    disconnect page, whose address can carry the company's realm ID.
 *  - On the staging site only, "X-Robots-Tag: noindex, nofollow" on every
 *    response, so search engines never list it. Staging sets
 *    SITE_NOINDEX=1; production leaves it unset and is unchanged.
 */
const NO_STORE = [
  { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, max-age=0" },
  { key: "Pragma", value: "no-cache" },
  { key: "Expires", value: "0" },
];

const SECURITY = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

// Staging only (SITE_NOINDEX=1). Sent as a header rather than a robots.txt
// block, so crawlers can still read it and drop any page they already found.
const NO_INDEX = { key: "X-Robots-Tag", value: "noindex, nofollow" };

const ONE_TIME_LINK_PATHS = [
  "/reset-password",
  "/verify-email",
  "/invite/:path*",
  "/quickbooks/:path*",
  "/api/brief/unsubscribe",
  "/api/email/tips-off",
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // No "X-Powered-By: Next.js": it tells a scanner what to try.
  poweredByHeader: false,
  async headers() {
    // Read here, not at the top of the file, so the value is the one set
    // when the site is built.
    const noIndex = process.env.SITE_NOINDEX === "1";
    return [
      { source: "/:path*", headers: noIndex ? [...SECURITY, NO_INDEX] : SECURITY },
      // Not Next.js's hashed files or resized images, nor the plain image,
      // icon and text files in public/: they hold no account data, and
      // caching them keeps the pages quick.
      {
        source: "/:path((?!_next/static|_next/image|.*\\.(?:png|jpe?g|gif|svg|ico|webp|avif|woff2?|txt|xml|webmanifest)$).*)",
        headers: NO_STORE,
      },
      // Listed last so it replaces the Referrer-Policy above on these paths.
      ...ONE_TIME_LINK_PATHS.map((source) => ({
        source,
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      })),
    ];
  },
};

export default nextConfig;
