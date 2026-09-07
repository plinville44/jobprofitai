import type { NextRequest } from "next/server";

/**
 * Shared authorization for scheduled endpoints.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` on its own
 * invocations once CRON_SECRET is set as an environment variable. These
 * endpoints send customer email, spend Anthropic tokens and issue account
 * credits, so an unauthenticated caller must never be able to trigger them.
 *
 * The important difference from a plain `if (process.env.CRON_SECRET)` check:
 * this FAILS CLOSED in production. If CRON_SECRET is missing in a production
 * deployment, every cron request is rejected rather than the endpoint
 * silently becoming public - a missing environment variable should break the
 * schedule loudly, not quietly open a hole that emails customers on demand.
 *
 * Outside production a missing secret is allowed, so local development and
 * preview deployments can exercise the schedule by hand.
 */
export type CronAuthResult = { ok: true } | { ok: false; status: number; error: string };

export function authorizeCron(req: NextRequest): CronAuthResult {
  const secret = process.env.CRON_SECRET;
  const isProduction = process.env.NODE_ENV === "production";

  if (!secret) {
    if (isProduction) {
      console.error("cron: CRON_SECRET is not set in production - rejecting request.");
      return { ok: false, status: 503, error: "Scheduled jobs are not configured." };
    }
    return { ok: true };
  }

  const header = req.headers.get("authorization");
  if (header !== `Bearer ${secret}`) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  return { ok: true };
}
