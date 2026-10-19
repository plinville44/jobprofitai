import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// The one table reportServerEvent reads, by user ID.
const users: Record<string, { adOptOutAt: Date | null; gaClientId: string | null; createdAt: Date }> = {};
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return {
      user: {
        findUnique: async ({ where }: { where: { id: string } }) => users[where.id] ?? null,
      },
    };
  },
}));

import {
  decodeSource,
  encodeSource,
  gaClientIdFrom,
  gaSessionIdFrom,
  sourceFromUrl,
  sourceLabel,
} from "@/lib/adSource";
import {
  REPORT_WINDOW_DAYS,
  measurementBody,
  reportServerEvent,
  serverEventsConfig,
  signupAdSource,
  signupSessionId,
} from "@/lib/serverEvents";
import { europeanTimeZone, gtmBootstrap } from "@/lib/tracking";

// Ad measurement at launch: Google Analytics on public pages, our jpai_src
// cookie, and the steps the server reports (sign_up, qbo_connected,
// begin_checkout, purchase). Held to what the Privacy Policy, section 2, says.

const SRC = join(__dirname, "..", "..");
const flat = (rel: string) => readFileSync(join(SRC, rel), "utf8").replace(/\s+/g, " ");
const DAY = 86_400_000;
const ENV = { GA4_MEASUREMENT_ID: "G-ABC123XYZ9", GA4_API_SECRET: "secret_1" } as unknown as NodeJS.ProcessEnv;

describe("where a visitor came from", () => {
  it("keeps the click ID, campaign tags and landing page from an ad link, and nothing from a plain one", () => {
    const s = sourceFromUrl(new URL("https://jobprofitai.com/lp/wip?gclid=Cj0KCQ_abc-123&utm_source=google&utm_medium=cpc&utm_campaign=1234&utm_term=wip%20report&other=x"));
    expect(s).toEqual({
      gclid: "Cj0KCQ_abc-123",
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "1234",
      utm_term: "wip report",
      landing: "/lp/wip",
    });
    expect(sourceFromUrl(new URL("https://jobprofitai.com/pricing?ref=abc"))).toBeNull();
  });

  it("drops values that don't look like tags, and cuts long ones", () => {
    const s = sourceFromUrl(new URL(`https://jobprofitai.com/?utm_source=${encodeURIComponent("<script>")}&utm_campaign=${"a".repeat(400)}`));
    expect(s?.utm_source).toBeUndefined();
    expect(s?.utm_campaign).toHaveLength(150);
  });

  it("reads back only what it wrote", () => {
    const s = { gclid: "abc", utm_source: "google", landing: "/pricing" };
    expect(decodeSource(encodeSource(s))).toEqual(s);
    expect(decodeSource(encodeURIComponent(JSON.stringify({ email: "a@b.com", utm_source: "x" })))).toEqual({ utm_source: "x" });
    expect(decodeSource("not json")).toBeNull();
    expect(decodeSource(encodeURIComponent(JSON.stringify({ landing: "//evil.example" })))).toBeNull();
  });

  it("labels the source for the admin page", () => {
    expect(sourceLabel({ adGclid: "x", utmCampaign: "1234", utmTerm: "wip report" })).toBe("Google ad: 1234 / wip report");
    expect(sourceLabel({ utmSource: "newsletter", utmMedium: "email" })).toBe("newsletter / email");
    expect(sourceLabel({})).toBeNull();
  });
});

describe("the Google Analytics IDs", () => {
  it("reads the browser ID from the _ga cookie", () => {
    expect(gaClientIdFrom("a=1; _ga=GA1.1.123456789.1700000000; b=2")).toBe("123456789.1700000000");
    expect(gaClientIdFrom("_ga=garbage")).toBeNull();
    expect(gaClientIdFrom("")).toBeNull();
  });

  it("reads the session ID from the stream's cookie, old and new formats", () => {
    expect(gaSessionIdFrom("_ga_ABC123XYZ9=GS1.1.1700000000.3.1.1700000100.0.0.0", "G-ABC123XYZ9")).toBe("1700000000");
    expect(gaSessionIdFrom("_ga_ABC123XYZ9=GS2.1.s1760400000$o3$g1$t1760400100$j60$l0$h0", "G-ABC123XYZ9")).toBe("1760400000");
    expect(gaSessionIdFrom("_ga_OTHER=GS1.1.1700000000.3", "G-ABC123XYZ9")).toBeNull();
  });
});

describe("what a signup keeps", () => {
  const cookie = `_ga=GA1.1.123456789.1700000000; jpai_src=${encodeSource({ gclid: "abc", utm_campaign: "1234", landing: "/lp/wip" })}`;

  it("copies the source and browser ID onto the account", () => {
    expect(signupAdSource(new Headers({ cookie }))).toEqual({
      adGclid: "abc",
      utmCampaign: "1234",
      landingPage: "/lp/wip",
      gaClientId: "123456789.1700000000",
    });
  });

  it("keeps nothing for a signup from the EEA, the UK or Switzerland", () => {
    expect(signupAdSource(new Headers({ cookie, "x-vercel-ip-country": "DE" }))).toEqual({});
    expect(signupAdSource(new Headers({ cookie, "x-vercel-ip-country": "gb" }))).toEqual({});
    expect(signupAdSource(new Headers({ cookie, "x-vercel-ip-country": "US" })).gaClientId).toBe("123456789.1700000000");
  });

  it("keeps nothing when the signup carries Global Privacy Control or the opt-out cookie", () => {
    expect(signupAdSource(new Headers({ cookie, "sec-gpc": "1" }))).toEqual({});
    expect(signupAdSource(new Headers({ cookie: `${cookie}; jpai_optout=1` }))).toEqual({});
    expect(signupSessionId(new Headers({ cookie: "_ga_ABC123XYZ9=GS1.1.1700000000.3", "sec-gpc": "1" }), ENV)).toBeNull();
    expect(signupSessionId(new Headers({ cookie: "_ga_ABC123XYZ9=GS1.1.1700000000.3" }), ENV)).toBe("1700000000");
  });
});

describe("steps reported from the server", () => {
  const sent: { url: string; body: any }[] = [];
  const fakeFetch = (async (url: string, init: { body: string }) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true } as Response;
  }) as unknown as typeof fetch;
  const now = new Date("2026-11-10T12:00:00Z");

  beforeEach(() => {
    sent.length = 0;
    for (const k of Object.keys(users)) delete users[k];
    users.u1 = { adOptOutAt: null, gaClientId: "123.456", createdAt: new Date(now.getTime() - DAY) };
  });

  it("sends nothing until both settings are present", async () => {
    expect(serverEventsConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(serverEventsConfig({ GA4_MEASUREMENT_ID: "UA-1", GA4_API_SECRET: "x" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(await reportServerEvent("u1", "sign_up", {}, { env: {} as NodeJS.ProcessEnv, fetchImpl: fakeFetch, now })).toBe("skipped");
    expect(sent).toHaveLength(0);
  });

  it("sends the event with the browser ID, the allowed details and ad personalization denied", async () => {
    expect(
      await reportServerEvent("u1", "purchase", { transaction_id: "cs_1", value: 149, currency: "USD", plan: "profit_intelligence" }, { env: ENV, fetchImpl: fakeFetch, now })
    ).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain("measurement_id=G-ABC123XYZ9");
    expect(sent[0].url).toContain("api_secret=secret_1");
    expect(sent[0].body).toEqual({
      client_id: "123.456",
      consent: { ad_user_data: "GRANTED", ad_personalization: "DENIED" },
      events: [{ name: "purchase", params: { transaction_id: "cs_1", value: 149, currency: "USD", plan: "profit_intelligence" } }],
    });
  });

  it("sends nothing for an opted-out account, one without a browser ID, or past the window", async () => {
    users.u1.adOptOutAt = new Date();
    expect(await reportServerEvent("u1", "qbo_connected", {}, { env: ENV, fetchImpl: fakeFetch, now })).toBe("skipped");
    users.u1.adOptOutAt = null;
    users.u1.gaClientId = null;
    expect(await reportServerEvent("u1", "qbo_connected", {}, { env: ENV, fetchImpl: fakeFetch, now })).toBe("skipped");
    users.u1.gaClientId = "123.456";
    users.u1.createdAt = new Date(now.getTime() - (REPORT_WINDOW_DAYS + 1) * DAY);
    expect(await reportServerEvent("u1", "purchase", {}, { env: ENV, fetchImpl: fakeFetch, now })).toBe("skipped");
    expect(await reportServerEvent("nobody", "purchase", {}, { env: ENV, fetchImpl: fakeFetch, now })).toBe("skipped");
    expect(sent).toHaveLength(0);
  });

  it("never throws when Google can't be reached", async () => {
    const broken = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await reportServerEvent("u1", "sign_up", { method: "email" }, { env: ENV, fetchImpl: broken, now })).toBe("failed");
  });

  it("carries only the named details, never anything else passed in", () => {
    const body = measurementBody("1.2", "sign_up", { method: "email", ...({ email: "pat@firm.com", name: "Pat" } as object) }, "1700000000");
    expect(JSON.stringify(body)).not.toContain("pat@firm.com");
    expect(body.events).toEqual([{ name: "sign_up", params: { method: "email", session_id: "1700000000", engagement_time_msec: 100 } }]);
  });
});

describe("where the steps are reported", () => {
  it("reports signups from both signup routes, and keeps the source only without an opt-out", () => {
    const email = flat("app/api/auth/signup/route.ts");
    expect(email).toContain("...signupAdSource(req.headers),");
    expect(email).toContain('await reportServerEvent(user.id, "sign_up", { method: "email" }');
    const intuit = flat("app/api/auth/intuit/create/route.ts");
    expect(intuit).toContain("...signupAdSource(req.headers),");
    expect(intuit).toContain('await reportServerEvent(userId, "sign_up", { method: "intuit" }');
    // An App Store arrival never passed our pages, so nothing is kept or
    // reported for it; the button on /signup is measured like the email form.
    const intuitFlow = flat("lib/intuitSignIn.ts");
    expect(intuitFlow).toContain("const fromSignupPage = connecting && payload.signup === true;");
    expect(intuitFlow).toContain("fromSignupPage ? { ...signupAdOptOut({ headers: reqHeaders }), ...signupAdSource(reqHeaders) } : {}");
    expect(intuitFlow).toContain('await reportServerEvent(user.id, "sign_up", { method: "intuit" }');
    expect(flat("app/signup/SignupForm.tsx")).toContain('<SignInWithIntuitButton intent="signup" />');
  });

  it("reports the first QuickBooks connection, checkout and the subscription", () => {
    expect(flat("lib/trial.ts")).toContain('if (await markQuickBooksConnected(userId)) await reportServerEvent(userId, "qbo_connected");');
    expect(flat("app/api/billing/checkout/route.ts")).toContain('await reportServerEvent(account.ownerId, "begin_checkout", { plan });');
    expect(flat("lib/stripe/webhookHandlers.ts")).toContain('await reportServerEvent(userId, "purchase", {');
  });

  it("sets jpai_src only on tagged pages, only when tracking is allowed, and not in European time zones", () => {
    const loader = flat("components/MarketingTags.tsx");
    expect(loader).toContain("if (allowedHere && trackingAllowed({ gpc, cookieHeader: document.cookie })) rememberAdSource();");
    expect(loader).toContain("if (europeanTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)) return;");
    expect(europeanTimeZone("Europe/Berlin")).toBe(true);
    expect(europeanTimeZone("Asia/Nicosia")).toBe(true);
    expect(europeanTimeZone("Atlantic/Canary")).toBe(true);
    expect(europeanTimeZone("America/Indiana/Indianapolis")).toBe(false);
  });

  it("starts Google's tags with ad personalization denied everywhere", () => {
    const script = gtmBootstrap("GTM-ABC1234")!;
    expect(script).not.toContain("ad_personalization:'granted'");
    expect(script).toContain("ad_storage:'granted',ad_user_data:'granted',ad_personalization:'denied',analytics_storage:'granted'");
  });

  it("saves a browser opt-out onto the account at sign-in and on app pages", () => {
    expect(flat("lib/adOptOut.ts")).toContain("const source = requestAdOptOut(headers); if (source) await recordAdOptOut(userId, source);");
    expect(flat("app/dashboard/layout.tsx")).toContain("await noteBrowserOptOut(account.userId, await headers())");
    expect(flat("lib/tracking.ts")).toContain("No remarketing, no enhanced conversions and no LinkedIn Insight Tag");
  });
});
