/**
 * The key the emails' unsubscribe links are signed with (the Weekly Profit
 * Brief's and alerts' links, and the tips and reminders link).
 *
 * In production a missing AUTH_SECRET refuses to sign or check a link
 * rather than falling back to a key anyone could read in the source: a
 * link signed with it would let anyone take any address off any company's
 * list. Sending the email fails instead, which is reported. Development and
 * tests keep a fixed key so links work without one.
 */
export function linkSigningKey(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET is not set, so email links can't be signed or checked.");
  }
  return "dev-only";
}
