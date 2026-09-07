/**
 * Contact form options, shared by the marketing form and the API route.
 *
 * Lives in lib rather than in the route file because Next.js route handlers
 * may only export HTTP methods and a fixed set of config keys - any other
 * export fails the generated route type check at build time.
 */
export const CONTACT_REASONS = [
  "Product Question",
  "Sales",
  "Accountant / Partner Program",
  "Support",
  "Billing",
  "Security / Privacy",
  "Other",
] as const;

export type ContactReason = (typeof CONTACT_REASONS)[number];
