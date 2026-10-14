import { prisma } from "@/lib/prisma";
import { fromConsentRegion, serverReportsAllowed } from "@/lib/tracking";
import { requestAdOptOut } from "@/lib/adOptOut";
import { SOURCE_COOKIE, decodeSource, gaClientIdFrom, gaSessionIdFrom, readCookie } from "@/lib/adSource";

/**
 * Steps reported to Google Analytics from our servers, with the GA4
 * Measurement Protocol. Signing up, connecting QuickBooks, starting checkout
 * and subscribing happen where our tags don't run (the app, Stripe, the
 * Intuit sign-in pages), so the server says they happened. Google Analytics
 * passes them on to the linked Google Ads account, where they count as
 * conversions (Google includes Measurement Protocol events in what it
 * exports to linked advertising products).
 *
 * The Privacy Policy (section 2, "Steps reported from our servers")
 * promises exactly this:
 *   - only the event name and the plan, amount, currency, reference number
 *     or sign-up method. Never a name, an email address or anything from
 *     QuickBooks;
 *   - linked only to the Google Analytics browser ID saved at signup, which
 *     is saved only when the signup request carried no opt-out;
 *   - nothing for an account that has opted out (serverReportsAllowed), at
 *     any time, including steps that happen later;
 *   - ad personalization marked as denied: these events measure ads, they
 *     aren't used to choose who sees them.
 *
 * Nothing is sent until GA4_MEASUREMENT_ID and GA4_API_SECRET are set.
 * Never throws: measurement must never break signup, connecting or billing.
 */

export type ServerEventName = "sign_up" | "qbo_connected" | "begin_checkout" | "purchase";

/** The only parameters an event may carry. */
export interface ServerEventParams {
  method?: "email" | "intuit";
  plan?: string;
  value?: number;
  currency?: string;
  transaction_id?: string;
}

const ALLOWED_PARAMS = ["method", "plan", "value", "currency", "transaction_id"] as const satisfies readonly (keyof ServerEventParams)[];

const MP_ENDPOINT = "https://www.google-analytics.com/mp/collect";
const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{4,15}$/;

/**
 * Google attributes a Measurement Protocol event only when it arrives within
 * 63 days of the browser's last visit. Past that it would be sent for
 * nothing, so we don't send it. Counted from signup, the last visit we know of.
 */
export const REPORT_WINDOW_DAYS = 63;
const REPORT_TIMEOUT_MS = 2500;

export function serverEventsConfig(env: NodeJS.ProcessEnv = process.env): { measurementId: string; apiSecret: string } | null {
  const measurementId = env.GA4_MEASUREMENT_ID?.trim() ?? "";
  const apiSecret = env.GA4_API_SECRET?.trim() ?? "";
  if (!MEASUREMENT_ID_PATTERN.test(measurementId) || apiSecret === "") return null;
  return { measurementId, apiSecret };
}

/** The User columns signupAdSource fills (prisma/schema.prisma). */
export interface SourceFields {
  adGclid?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  landingPage?: string;
  gaClientId?: string;
}

/**
 * Fields for a new account: where it came from (the jpai_src cookie) and the
 * Google Analytics browser ID. Empty when the signup request carries an
 * opt-out (Global Privacy Control or the Your Privacy Choices cookie), or
 * comes from the EEA, the UK or Switzerland, so nothing is kept or later
 * reported for that account.
 */
export function signupAdSource(headers: Headers): SourceFields {
  if (requestAdOptOut(headers) || fromConsentRegion(headers)) return {};
  const cookieHeader = headers.get("cookie") ?? "";
  const source = decodeSource(readCookie(cookieHeader, SOURCE_COOKIE));
  const gaClientId = gaClientIdFrom(cookieHeader);
  return {
    ...(source?.gclid ? { adGclid: source.gclid } : {}),
    ...(source?.utm_source ? { utmSource: source.utm_source } : {}),
    ...(source?.utm_medium ? { utmMedium: source.utm_medium } : {}),
    ...(source?.utm_campaign ? { utmCampaign: source.utm_campaign } : {}),
    ...(source?.utm_term ? { utmTerm: source.utm_term } : {}),
    ...(source?.landing ? { landingPage: source.landing } : {}),
    ...(gaClientId ? { gaClientId } : {}),
  };
}

/** The session the signup happened in, so the sign_up event joins that visit in Google Analytics. */
export function signupSessionId(headers: Headers, env: NodeJS.ProcessEnv = process.env): string | null {
  const config = serverEventsConfig(env);
  if (!config || requestAdOptOut(headers) || fromConsentRegion(headers)) return null;
  return gaSessionIdFrom(headers.get("cookie"), config.measurementId);
}

/** The request body for one event (exported for tests). */
export function measurementBody(
  clientId: string,
  name: ServerEventName,
  params: ServerEventParams,
  sessionId?: string | null
): Record<string, unknown> {
  // Only the named details, whatever else a caller passes in.
  const eventParams: Record<string, string | number> = {};
  for (const key of ALLOWED_PARAMS) {
    const value: unknown = params[key];
    if (typeof value === "string" && value !== "") eventParams[key] = value.slice(0, 100);
    else if (typeof value === "number" && Number.isFinite(value)) eventParams[key] = value;
  }
  if (sessionId) {
    eventParams.session_id = sessionId;
    eventParams.engagement_time_msec = 100;
  }
  return {
    client_id: clientId,
    consent: { ad_user_data: "GRANTED", ad_personalization: "DENIED" },
    events: [{ name, params: eventParams }],
  };
}

export type ReportResult = "sent" | "skipped" | "failed";

/**
 * Tells Google Analytics that this account took a step. Skipped when not
 * configured, when the account has opted out, when it has no saved browser
 * ID, or past the reporting window.
 */
export async function reportServerEvent(
  userId: string,
  name: ServerEventName,
  params: ServerEventParams = {},
  opts: { sessionId?: string | null; now?: Date; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}
): Promise<ReportResult> {
  try {
    const config = serverEventsConfig(opts.env);
    if (!config) return "skipped";
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { adOptOutAt: true, gaClientId: true, createdAt: true },
    });
    if (!user || !user.gaClientId || !serverReportsAllowed(user)) return "skipped";
    const now = opts.now ?? new Date();
    if (now.getTime() - user.createdAt.getTime() > REPORT_WINDOW_DAYS * 86_400_000) return "skipped";

    const url = `${MP_ENDPOINT}?measurement_id=${encodeURIComponent(config.measurementId)}&api_secret=${encodeURIComponent(config.apiSecret)}`;
    const res = await (opts.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(measurementBody(user.gaClientId, name, params, opts.sessionId)),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
