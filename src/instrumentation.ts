import { reportError } from "@/lib/monitoring";

/**
 * Next.js calls onRequestError for an error that escapes a server component,
 * a route handler or a server action. Each goes to Sentry (see
 * src/lib/monitoring.ts) with the route's path pattern, the HTTP method and
 * the router and route type, and nothing else: the request's real path (with
 * its IDs and query string) and its headers (cookies, authorization) are
 * never read. An error a route catches itself and turns into a response
 * doesn't come through here.
 *
 * No register() export: nothing in the app needs setting up at start-up.
 *
 * Typed loosely here rather than with Next's own types, so a change in their
 * shape can't break the build; anything unexpected is simply left out.
 */

/**
 * Next.js's own signals (redirect(), notFound() and the like) travel as
 * thrown errors with these digests. They aren't faults, and Next.js
 * shouldn't pass them here, but if it does they're not reported.
 */
const NEXT_SIGNAL = /^(NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING)/;

type Loose = Record<string, unknown> | null | undefined;

export async function onRequestError(err: unknown, request: Loose, context: Loose): Promise<void> {
  try {
    const digest = (err as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string" && NEXT_SIGNAL.test(digest)) return;
    const text = (v: unknown) => (typeof v === "string" ? v : undefined);
    await reportError(err, {
      route: text(context?.routePath),
      method: text(request?.method),
      routeType: text(context?.routeType),
      router: text(context?.routerKind),
    });
  } catch {
    // Reporting an error must never cause another.
  }
}
