import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { createFakePrisma, FakeModel, type FakePrisma } from "./support/fakePrisma";

// Fixes from the 2026-10-19 audit: billing, team logins, sign-in and signup,
// and ad measurement. One block per audit item, numbered as in the audit.
// The Stripe SDK is replaced by a small stand-in with state, and our own
// client.ts runs for real against it, so the options it is built with can
// be checked too.

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));

type Obj = Record<string, any>;
// vi.mock factories run before the rest of this file, so the Stripe stand-in
// and its state are made in vi.hoisted, which runs before them too. A class
// declared at the top level isn't there yet when the factory needs it
// ("Cannot access 'FakeStripe' before initialization" under Vitest).
const { stripeState, missing, FakeStripe } = vi.hoisted(() => {
  const copy = <T>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const stripeState = {
    options: [] as Obj[],
    subscriptions: new Map<string, Obj>(),
    charges: new Map<string, Obj>(),
    invoices: new Map<string, Obj>(),
    sessions: new Map<string, Obj>(),
    expired: [] as string[],
    cancelError: null as unknown,
  };
  const missing = (what: string, id: string) =>
    Object.assign(new Error(`No such ${what}: '${id}'`), { code: "resource_missing", statusCode: 404 });
  class FakeStripe {
    constructor(_key: string, options: Obj) {
      stripeState.options.push(options);
    }
    subscriptions = {
      retrieve: async (id: string) => {
        const s = stripeState.subscriptions.get(id);
        if (!s) throw missing("subscription", id);
        if (s.retrieveError) throw Object.assign(new Error("An error occurred with our connection to Stripe."), { type: "StripeConnectionError" });
        return copy(s);
      },
      list: async ({ customer }: Obj) => ({
        data: Array.from(stripeState.subscriptions.values()).filter((s) => s.customer === customer).map(copy),
      }),
      update: async (id: string) => copy(stripeState.subscriptions.get(id)),
      cancel: async (id: string) => {
        if (stripeState.cancelError) throw stripeState.cancelError;
        const s = stripeState.subscriptions.get(id);
        if (!s) throw missing("subscription", id);
        if (s.cancelFails) throw new Error("Stripe couldn't cancel this one");
        s.status = "canceled";
        return copy(s);
      },
    };
    charges = { retrieve: async (id: string) => copy(stripeState.charges.get(id)) };
    invoices = { retrieve: async (id: string) => copy(stripeState.invoices.get(id)), voidInvoice: async () => ({}) };
    refunds = { create: async () => ({ id: "re_1", amount: 0 }), list: async () => ({ data: [] }) };
    customers = { create: async () => ({ id: "cus_created" }) };
    checkout = {
      sessions: {
        list: async ({ customer, status }: Obj) => ({
          data: Array.from(stripeState.sessions.values())
            .filter((s) => s.customer === customer && (!status || s.status === status))
            .map(copy),
        }),
        expire: async (id: string) => {
          stripeState.sessions.get(id)!.status = "expired";
          stripeState.expired.push(id);
        },
        retrieve: async (id: string) => copy(stripeState.sessions.get(id)),
        create: async () => ({ id: "cs_new", url: "https://checkout.stripe.test/cs_new" }),
      },
    };
  }
  return { stripeState, missing, FakeStripe };
});
vi.mock("stripe", () => ({ __esModule: true, default: FakeStripe }));

// zod is only a type stub in this sandbox. The few schema pieces the routes
// under test use, with the same results shape.
vi.mock("zod", () => {
  type Result = { ok: true; value: unknown } | { ok: false; message: string; code: string };
  type Check = (v: any) => Result;
  const pass = (value: unknown): Result => ({ ok: true, value });
  const fail = (message: string, code: string): Result => ({ ok: false, message, code });
  class ZType {
    checks: Check[];
    isOptional = false;
    constructor(base: Check) {
      this.checks = [base];
    }
    add(c: Check) {
      this.checks.push(c);
      return this;
    }
    optional() {
      this.isOptional = true;
      return this;
    }
    run(v: unknown): Result {
      if (v === undefined && this.isOptional) return pass(undefined);
      let value = v;
      for (const c of this.checks) {
        const r = c(value);
        if (!r.ok) return r;
        value = r.value;
      }
      return pass(value);
    }
    min(n: number, m?: string) {
      return this.add((v) => (v.length >= n ? pass(v) : fail(m ?? `At least ${n}`, "too_small")));
    }
    max(n: number, m?: string) {
      return this.add((v) => (v.length <= n ? pass(v) : fail(m ?? `At most ${n}`, "too_big")));
    }
    email() {
      return this.add((v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? pass(v) : fail("Invalid email", "invalid_string")));
    }
    trim() {
      return this.add((v) => pass(String(v).trim()));
    }
  }
  const z = {
    string: () => new ZType((v) => (typeof v === "string" ? pass(v) : fail("Expected string", "invalid_type"))),
    literal: (lit: unknown, opts?: { errorMap?: () => { message: string } }) =>
      new ZType((v) => (v === lit ? pass(v) : fail(opts?.errorMap?.().message ?? "Invalid literal", "invalid_literal"))),
    object: (shape: Record<string, ZType>) => ({
      safeParse: (input: unknown) => {
        const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
        const data: Record<string, unknown> = {};
        const issues: { path: string[]; message: string; code: string }[] = [];
        for (const [key, type] of Object.entries(shape)) {
          const r = type.run(obj[key]);
          if (r.ok) {
            if (r.value !== undefined) data[key] = r.value;
          } else issues.push({ path: [key], message: r.message, code: r.code });
        }
        return issues.length
          ? { success: false, error: { issues, flatten: () => ({ fieldErrors: Object.fromEntries(issues.map((i) => [i.path[0], [i.message]])) }) } }
          : { success: true, data };
      },
    }),
  };
  return { z };
});

// The browser: its cookies, and the headers of the request being handled.
const jar = new Map<string, string>();
const browser = { headers: new Headers() };
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
  headers: async () => browser.headers,
}));
vi.mock("next/server", () => {
  const make = (extra: Obj) => {
    const setCookies: Record<string, string> = {};
    return { ...extra, setCookies, cookies: { set: (n: string, v: string) => (setCookies[n] = v) } };
  };
  return {
    NextResponse: {
      redirect: (url: URL | string) => make({ url: String(url), status: 307 }),
      json: (body: unknown, init?: { status?: number }) => make({ body, status: init?.status ?? 200 }),
    },
  };
});

const auth = {
  session: null as null | { userId: string },
  created: [] as string[],
  // The session version each session was issued under (createSession reads it).
  versions: [] as number[],
  revoked: [] as string[],
  passwordChecks: 0,
};
vi.mock("@/lib/auth", () => ({
  createSession: async (userId: string) => {
    auth.created.push(userId);
    auth.session = { userId };
    const user = await fake.client.user.findUnique({ where: { id: userId } });
    auth.versions.push(Number(user?.sessionVersion ?? 0));
    return "token";
  },
  getSession: async () => auth.session,
  hashPassword: async (p: string) => `hashed:${p}`,
  verifyPassword: async (p: string, hash: string) => {
    auth.passwordChecks++;
    return hash === `hashed:${p}`;
  },
  clearSession: async () => {
    auth.session = null;
  },
  revokeAllSessions: async (userId: string) => {
    auth.revoked.push(userId);
  },
}));

// Google Analytics, as reportServerEvent sends to it.
const sent: { name: string; params: Obj }[] = [];
// The order things happened in, across collaborators.
const timeline: string[] = [];

const intuit = { userinfo: null as Obj | null, revoked: 0 };
vi.mock("@/lib/quickbooks", () => ({
  OPENID_SCOPES: "openid profile email",
  CONNECT_WITH_OPENID_SCOPES: "com.intuit.quickbooks.accounting openid profile email",
  buildAuthorizeUrl: async (state: string, scope: string) => `https://intuit.example/authorize?scope=${scope}&state=${state}`,
  exchangeCodeForTokens: async () => ({ access_token: "at", refresh_token: "rt", expires_in: 3600, x_refresh_token_expires_in: 8_640_000 }),
  fetchIntuitUserInfo: async () => intuit.userinfo,
  revokeToken: async () => {
    intuit.revoked++;
    timeline.push("qbo_revoke");
  },
}));
const attached: { ownerId: string; optedOut: boolean }[] = [];
vi.mock("@/lib/connectCompany", () => ({
  OWNER_ONLY_CONNECT_NOTICE: "owner_only_connect",
  attachCompany: async (input: { ownerId: string }) => {
    const owner = await fake.client.user.findUnique({ where: { id: input.ownerId } });
    attached.push({ ownerId: input.ownerId, optedOut: owner?.adOptOutAt != null });
    timeline.push("attach");
    return { ok: true, connectionId: "conn_1" };
  },
}));
vi.mock("@/lib/crypto", () => ({
  hashRealmId: (r: string) => `hash:${r}`,
  legacyHashRealmId: (r: string) => `legacy:${r}`,
  decryptToken: (t: string) => t,
}));
vi.mock("@/lib/signupReferral", () => ({ attributeSignupReferral: async () => false }));

const money = { voided: [] as string[], commissions: [] as string[], disqualified: [] as string[] };
vi.mock("@/lib/referrals", () => ({
  REFERRAL_COOKIE: "jpai_ref",
  applyPendingRewardsForUser: async () => 0,
  disqualifyReferral: async (userId: string) => {
    money.disqualified.push(userId);
  },
  markReferralPaid: async () => null,
}));
vi.mock("@/lib/partners", () => ({
  countPayingClients: async () => 0,
  recordCommissionForInvoice: async ({ invoice }: Obj) => {
    money.commissions.push(invoice.id);
    return null;
  },
  voidCommissionForInvoice: async (invoiceId: string) => {
    money.voided.push(invoiceId);
    return true;
  },
  flagPaidCommissionsForReview: async () => 0,
}));
const emails: string[] = [];
vi.mock("@/lib/email/lifecycle", () => {
  const record = (name: string) => async () => {
    emails.push(name);
    return { ok: true };
  };
  return {
    sendPartnerCommissionEarned: record("partner_commission"),
    sendPartnerNewPayingClient: record("partner_new_paying"),
    sendPartnerTierUpgrade: record("partner_tier"),
    sendPaymentFailed: record("payment_failed"),
    sendReferralConverted: record("referral_converted"),
    sendSubscriptionCanceled: record("subscription_canceled"),
    sendSubscriptionConfirmed: record("subscription_confirmed"),
    sendPasswordChanged: record("password_changed"),
    sendTrialWelcome: record("trial_welcome"),
    sendEmailVerification: record("email_verification"),
    sendPasswordReset: record("password_reset"),
  };
});
vi.mock("@/lib/email/client", () => ({
  SUPPORT_EMAIL: "support@jobprofitai.com",
  sendLifecycleEmail: async () => ({ ok: true }),
  sendEmail: async () => ({ ok: true }),
}));
vi.mock("@/lib/email/templates", () => ({ intuitLinkedEmail: () => ({ subject: "Linked", text: "Linked", html: "<p>Linked</p>" }) }));
const reported: unknown[] = [];
vi.mock("@/lib/monitoring", () => ({
  reportError: async (err: unknown) => {
    reported.push(err);
    return { sent: false, reason: "no_dsn" };
  },
}));

import { encodeSource } from "../adSource";
import { getStripe } from "../stripe/client";
import { CLAIM_IN_PROGRESS_PREFIX, EventInProgressError, processStripeEvent, storedStatusFor } from "../stripe/webhookHandlers";
import { UNPAID_SUBSCRIPTION_MESSAGE, isLiveSubscriptionStatus, secondCheckoutDecision } from "../stripe/duplicateSubscription";
import { accountFor, pausedLoginNoticeFor } from "../account";
import { acceptInvite, createInvite, listTeam, OWN_PLAN_JOIN_MESSAGE, teamLoginsInUse } from "../team";
import { planFit, teamLoginsMisfit } from "../planLimits";
import { canConnectAnotherCompany, getEntitlements, PAUSED_LOGIN_MESSAGE, pausedTeamLoginIds } from "../entitlements";
import { computeTrialState, expireFinishedTrials } from "../trial";
import { clearFailedLogins, emailKey, findLoginByEmail, isLockedOut, SIGNUPS_PER_IP_PER_HOUR, signupKey } from "../loginThrottle";
import { hashToken } from "../passwordReset";
import { handleIntuitFlow, INTUIT_PENDING_COOKIE, OIDC_NONCE_COOKIE, startIntuitFlow } from "../intuitSignIn";
import { europeanTimeZone } from "../tracking";
import { PLANS } from "../plans";
import { GET as intuitStart } from "../../app/api/auth/intuit/route";
import { POST as deleteAccount } from "../../app/api/account/delete/route";
import { POST as checkout } from "../../app/api/billing/checkout/route";
import { POST as login } from "../../app/api/auth/login/route";
import { POST as linkIntuit } from "../../app/api/auth/intuit/link/route";
import { POST as resetPassword } from "../../app/api/auth/reset-password/route";
import { POST as signup } from "../../app/api/auth/signup/route";
import { POST as forgotPassword } from "../../app/api/auth/forgot-password/route";

const SRC = join(__dirname, "..", "..");
const flat = (rel: string) => readFileSync(join(SRC, rel), "utf8").replace(/\s+/g, " ");
const DAY = 86_400_000;
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A JSON POST from our own site, as the routes see it. */
function post(body: unknown, headers: Record<string, string> = {}) {
  return {
    headers: new Headers({ "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers }),
    json: async () => body,
  } as never;
}

const ENV: Record<string, string> = {
  AUTH_SECRET: "test-secret-for-audit-1019",
  APP_URL: "https://app.example.com",
  STRIPE_SECRET_KEY: "sk_test_audit",
  STRIPE_PRICE_PROFIT_INTELLIGENCE_MONTHLY: "price_149",
  STRIPE_PRICE_PROFIT_INTELLIGENCE_PRO_MONTHLY: "price_299",
  GA4_MEASUREMENT_ID: "G-ABC123XYZ9",
  GA4_API_SECRET: "secret_1",
};
const savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

function stripeSubscription(id: string, overrides: Obj = {}) {
  return {
    id,
    customer: "cus_1",
    status: "active",
    created: nowSeconds() - 60,
    cancel_at_period_end: false,
    canceled_at: null,
    items: { data: [{ price: { id: "price_149" }, quantity: 1, current_period_end: nowSeconds() + 30 * 86_400 }] },
    metadata: { jobprofitaiUserId: "u1" },
    ...overrides,
  };
}

function subscriptionEvent(id: string, object: Obj, created = nowSeconds()) {
  return { id, type: "customer.subscription.updated", created, api_version: "2026-08-26.dahlia", data: { object } } as never;
}

async function seedPayer(subscription: Obj = {}, user: Obj = {}) {
  await fake.client.user.create({
    data: { id: "u1", email: "owner@example.com", name: "Sam Builder", emailVerifiedAt: new Date(), passwordHash: "hashed:right-password", ...user },
  });
  await fake.client.subscription.create({
    data: { userId: "u1", status: "trialing", plan: "profit_intelligence", stripeCustomerId: "cus_1", trialEndsAt: new Date(Date.now() + 10 * DAY), ...subscription },
  });
}

describe("audit 2026-10-19: billing, team logins, sign-in, ad measurement", () => {
  beforeAll(() => {
    for (const [k, v] of Object.entries(ENV)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      sent.push({ name: body.events[0].name, params: body.events[0].params });
      timeline.push(`ga:${body.events[0].name}`);
      return { ok: true } as Response;
    }) as unknown as typeof fetch;
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    globalThis.fetch = realFetch;
  });

  beforeEach(() => {
    fake.client = createFakePrisma();
    fake.client.loginAttempt = new FakeModel("loginAttempt", [], () => ({ createdAt: new Date() }));
    fake.client.termsAcceptance = new FakeModel("termsAcceptance", [], () => ({ acceptedAt: new Date() }));
    // The account delete route reads the login with its companies and plan.
    const findUser = fake.client.user.findUnique.bind(fake.client.user);
    fake.client.user.findUnique = async (args: Obj) => {
      const row = await findUser(args);
      if (row && args.include) {
        row.connections = await fake.client.quickBooksConnection.findMany({ where: { userId: row.id } });
        row.subscription = await fake.client.subscription.findUnique({ where: { userId: row.id } });
      }
      return row;
    };
    stripeState.subscriptions.clear();
    stripeState.charges.clear();
    stripeState.invoices.clear();
    stripeState.sessions.clear();
    stripeState.expired = [];
    stripeState.cancelError = null;
    jar.clear();
    browser.headers = new Headers();
    auth.session = null;
    auth.created = [];
    auth.revoked = [];
    auth.versions = [];
    auth.passwordChecks = 0;
    sent.length = 0;
    timeline.length = 0;
    attached.length = 0;
    intuit.userinfo = { sub: "intuit-sub-1", email: "sam@builder.com", emailVerified: true, givenName: "Sam", familyName: "Builder" };
    intuit.revoked = 0;
    money.voided = [];
    money.commissions = [];
    money.disqualified = [];
    emails.length = 0;
    reported.length = 0;
  });

  // -------------------------------------------------------------------------
  describe("1. the Sign in with Intuit button on /signup", () => {
    const fromAd = {
      cookie: `_ga=GA1.1.111.222; _ga_ABC123XYZ9=GS1.1.1700000000.3; jpai_src=${encodeSource({ gclid: "abc", utm_campaign: "1234", landing: "/lp/wip" })}`,
    };

    /** Starts a flow the way the button does and brings back Intuit's callback state. */
    async function begin(intent: "signin" | "appstore" | "signup") {
      const res: any = await startIntuitFlow(intent);
      jar.set(OIDC_NONCE_COOKIE, res.setCookies[OIDC_NONCE_COOKIE]);
      const state = new URL(res.url).searchParams.get("state")!;
      return { res, payload: JSON.parse(Buffer.from(state.split(".")[1], "base64url").toString()) };
    }

    it("has its own intent, carried in the signed state, with QuickBooks access in the same step", async () => {
      const res: any = await intuitStart({ url: "https://app.example.com/api/auth/intuit?intent=signup" } as never);
      const state = new URL(res.url).searchParams.get("state")!;
      const payload = JSON.parse(Buffer.from(state.split(".")[1], "base64url").toString());
      expect(payload).toMatchObject({ flow: "intuit_appstore", signup: true });
      expect(new URL(res.url).searchParams.get("scope")).toContain("com.intuit.quickbooks.accounting");
      expect((await begin("appstore")).payload.signup).toBeUndefined();
      expect(flat("app/signup/SignupForm.tsx")).toContain('<SignInWithIntuitButton intent="signup" />');
    });

    it("measures a new account like an email signup: source kept, sign_up reported before the company, jpai_src cleared", async () => {
      const { payload } = await begin("signup");
      const res: any = await handleIntuitFlow("intuit_appstore", payload, "code", "123", new Headers(fromAd));
      const user = await fake.client.user.findFirst({ where: { intuitSub: "intuit-sub-1" } });
      expect(user).toMatchObject({ adGclid: "abc", utmCampaign: "1234", landingPage: "/lp/wip", gaClientId: "111.222" });
      expect(user.adOptOutAt ?? null).toBeNull();
      expect(sent).toEqual([{ name: "sign_up", params: { method: "intuit", session_id: "1700000000", engagement_time_msec: 100 } }]);
      expect(timeline).toEqual(["ga:sign_up", "attach"]);
      expect(res.setCookies.jpai_src).toBe("");
      // Not agreed to the Terms yet: by /accept-terms, keeping the address it was headed for.
      expect(res.url).toBe("https://app.example.com/accept-terms?next=%2Fdashboard%3Fqbo_connected%3D1");
    });

    it("keeps nothing and reports nothing when that browser has opted out, and saves the opt-out", async () => {
      const { payload } = await begin("signup");
      await handleIntuitFlow("intuit_appstore", payload, "code", "123", new Headers({ ...fromAd, "sec-gpc": "1" }));
      const user = await fake.client.user.findFirst({ where: { intuitSub: "intuit-sub-1" } });
      expect(user.gaClientId ?? null).toBeNull();
      expect(user.adOptOutSource).toBe("gpc");
      expect(sent).toEqual([]);
    });

    it("still keeps and reports nothing for a real App Store arrival, which also goes by /accept-terms", async () => {
      const { payload } = await begin("appstore");
      const res: any = await handleIntuitFlow("intuit_appstore", payload, "code", "123", new Headers(fromAd));
      const user = await fake.client.user.findFirst({ where: { intuitSub: "intuit-sub-1" } });
      expect(user.gaClientId ?? null).toBeNull();
      expect(user.adGclid ?? null).toBeNull();
      expect(sent).toEqual([]);
      expect(res.setCookies.jpai_src).toBeUndefined();
      expect(res.url).toBe("https://app.example.com/accept-terms?next=%2Fdashboard%3Fqbo_connected%3D1");
    });

    it("reads the callback's own request headers when the caller doesn't pass them", async () => {
      // The QuickBooks callback route calls handleIntuitFlow with four arguments.
      browser.headers = new Headers(fromAd);
      const { payload } = await begin("signup");
      await handleIntuitFlow("intuit_appstore", payload, "code", "123");
      const user = await fake.client.user.findFirst({ where: { intuitSub: "intuit-sub-1" } });
      expect(user.gaClientId).toBe("111.222");
      expect(sent.map((e) => e.name)).toEqual(["sign_up"]);
    });

    it("doesn't send someone who already has an account by /accept-terms", async () => {
      await fake.client.user.create({ data: { id: "u9", email: "sam@builder.com", intuitSub: "intuit-sub-1" } });
      const { payload } = await begin("signup");
      const res: any = await handleIntuitFlow("intuit_appstore", payload, "code", "123", new Headers(fromAd));
      expect(res.url).toBe("https://app.example.com/dashboard?qbo_connected=1");
      expect(sent).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe("2. team logins past the plan's limit", () => {
    async function seedTeam(ownerSub: Obj, members: number, pending = 0) {
      await fake.client.user.create({ data: { id: "owner", email: "owner@example.com", name: "Sam Builder", emailVerifiedAt: new Date() } });
      await fake.client.subscription.create({ data: { userId: "owner", plan: "profit_intelligence", ...ownerSub } });
      for (let i = 1; i <= members; i++) {
        await fake.client.user.create({ data: { id: `m${i}`, email: `m${i}@example.com` } });
        await fake.client.teamMember.create({
          data: {
            ownerUserId: "owner",
            email: `m${i}@example.com`,
            memberUserId: `m${i}`,
            tokenHash: `t${i}`,
            acceptedAt: new Date(Date.now() - (100 - i) * 60_000),
            expiresAt: new Date(Date.now() - DAY),
          },
        });
      }
      for (let i = 1; i <= pending; i++) {
        await fake.client.teamMember.create({
          data: { ownerUserId: "owner", email: `p${i}@example.com`, tokenHash: `pt${i}`, expiresAt: new Date(Date.now() + DAY) },
        });
      }
    }

    it("covers the logins that joined first", () => {
      const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 0, m));
      const paused = pausedTeamLoginIds(
        [
          { id: "a", memberUserId: "late", acceptedAt: at(9) },
          { id: "b", memberUserId: "first", acceptedAt: at(1) },
          { id: "c", memberUserId: "second", acceptedAt: at(2) },
        ],
        2
      );
      expect(Array.from(paused)).toEqual(["late"]);
    });

    it("pauses the members a smaller plan doesn't cover, and says so", async () => {
      await seedTeam({ status: "active", stripeSubscriptionId: "sub_o" }, 4);
      expect(await accountFor("m1")).toEqual({ userId: "m1", ownerId: "owner", role: "member", connectionId: null });
      expect(await accountFor("m3")).toMatchObject({ ownerId: "owner", role: "member" });
      // The $149 plan has 3 logins: the fourth to join gets an empty account
      // of its own, marked paused.
      expect(await accountFor("m4")).toEqual({ userId: "m4", ownerId: "m4", role: "owner", connectionId: null, paused: true });
      expect(await pausedLoginNoticeFor("m4")).toEqual({ ownerName: "Sam Builder", ownerEmail: "owner@example.com", maxTeamMembers: 3 });
      expect(await pausedLoginNoticeFor("m1")).toBeNull();
      const layout = flat("app/dashboard/layout.tsx");
      expect(layout).toContain("account.paused ? pausedLoginNoticeFor(account.userId) : null");
      expect(layout).toContain("<PausedLoginNotice");
    });

    it("shows the owner who is paused, by the same ranking", async () => {
      await seedTeam({ status: "active", stripeSubscriptionId: "sub_o" }, 4, 1);
      const team = await listTeam("owner");
      expect(team.filter((r) => r.paused).map((r) => r.email)).toEqual(["m4@example.com"]);
      // Agrees with accountFor for every member.
      for (const r of team.filter((row) => row.status === "active")) {
        const id = r.email.split("@")[0];
        expect(Boolean((await accountFor(id)).paused)).toBe(r.paused);
      }
      expect(flat("app/dashboard/settings/TeamSection.tsx")).toContain("Paused: over your plan's ${entitlements.limits.maxTeamMembers} logins");
      expect(flat("app/dashboard/settings/TeamManager.tsx")).toContain("{row.pausedNote}");
      const billing = flat("app/dashboard/billing/page.tsx");
      expect(billing).toContain('title="Some team logins are paused"');
      expect(billing).toContain("const pausedLogins = joinedLogins.filter((r) => r.paused);");
      // The Pro to $149 warning counts logins as well as companies.
      expect(billing).toContain("(downgradePauses > 0 || downgradeLoginPauses > 0)");
    });

    it("won't let a paused login check out, connect a company or invite people", async () => {
      await seedTeam({ status: "active", stripeSubscriptionId: "sub_o" }, 4);
      await fake.client.user.update({ where: { id: "m4" }, data: { emailVerifiedAt: new Date() } });
      auth.session = { userId: "m4" };
      const res: any = await checkout(post({ plan: "profit_intelligence" }));
      expect(res.status).toBe(403);
      expect(res.body.error).toBe(PAUSED_LOGIN_MESSAGE);
      expect(await canConnectAnotherCompany("m4")).toMatchObject({ allowed: false, reason: PAUSED_LOGIN_MESSAGE });
      expect(await createInvite("m4", "friend@example.com")).toEqual({ ok: false, error: PAUSED_LOGIN_MESSAGE, status: 403 });
      expect(PAUSED_LOGIN_MESSAGE).toBe(
        "Your login is paused because the account you joined is over its plan's login limit. Ask the owner to free a seat or move up a plan."
      );
      // A member inside the limit is unaffected.
      expect((await canConnectAnotherCompany("m1")).reason).not.toBe(PAUSED_LOGIN_MESSAGE);
    });

    it("lets everyone in on a plan (or trial) that covers them", async () => {
      await seedTeam({ status: "trialing", trialEndsAt: new Date(Date.now() + 5 * DAY) }, 4);
      expect(await accountFor("m4")).toMatchObject({ ownerId: "owner", role: "member" });
    });

    it("refuses checkout to a plan with fewer logins than are in use or invited, saying how many to remove", async () => {
      await seedTeam({ status: "trialing", trialEndsAt: new Date(Date.now() + 5 * DAY) }, 4, 1);
      expect(await teamLoginsInUse("owner")).toBe(5);
      auth.session = { userId: "owner" };
      const refused: any = await checkout(post({ plan: "profit_intelligence" }));
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe(
        "Profit Intelligence includes 3 team logins and you have 5 (in use or invited). Remove 2 in Settings first, or choose a plan that includes them all."
      );
      const pro: any = await checkout(post({ plan: "profit_intelligence_pro" }));
      expect(pro.status).toBe(200);
      expect(pro.body.url).toContain("checkout.stripe.test");
    });

    it("rules the plan out on Billing too", () => {
      const usage = { connections: 1, activeJobs: 2, teamLogins: 5 };
      expect(planFit(PLANS.profit_intelligence, usage)).toMatchObject({ fits: false });
      expect(planFit(PLANS.profit_intelligence, usage).reason).toContain("Remove 2 in Settings");
      expect(planFit(PLANS.profit_intelligence_pro, usage)).toMatchObject({ fits: true, reason: null });
      expect(teamLoginsMisfit("X", 3, 3)).toBeNull();
      expect(flat("app/dashboard/billing/page.tsx")).toContain("const fit = planFit(plan, fitUsage);");
    });

    it("won't let an invitation be accepted into a team that's already full", async () => {
      await seedTeam({ status: "trialing", trialEndsAt: new Date(Date.now() + 5 * DAY) }, 2);
      const invite = await createInvite("owner", "late@example.com");
      expect(invite.ok).toBe(true);
      if (!invite.ok) return;
      // The owner then moves to the $149 plan (3 logins) and a third person
      // joins on another invitation, so none is left for this one.
      await fake.client.subscription.update({ where: { userId: "owner" }, data: { status: "active", stripeSubscriptionId: "sub_o", trialEndsAt: null } });
      await fake.client.teamMember.create({
        data: { ownerUserId: "owner", email: "m3@example.com", memberUserId: "m3x", tokenHash: "t3x", acceptedAt: new Date(), expiresAt: new Date() },
      });
      await fake.client.user.create({ data: { id: "late", email: "late@example.com" } });
      const result = await acceptInvite(invite.token, "late");
      expect(result).toMatchObject({ ok: false, status: 409 });
      if (!result.ok) expect(result.error).toContain("Sam Builder's plan has no team login free right now");
    });
  });

  // -------------------------------------------------------------------------
  describe("3. refunds in the webhook's current payload shape", () => {
    it("finds a refunded charge's invoice through the SDK and voids its commission", async () => {
      await seedPayer({ status: "active", stripeSubscriptionId: "sub_1" });
      stripeState.charges.set("ch_9", { id: "ch_9", invoice: "in_9", customer: "cus_1", amount: 14_900, amount_refunded: 14_900, refunded: true });
      const result = await processStripeEvent({
        id: "evt_refund_new",
        type: "charge.refunded",
        // 2025+ shape: no `invoice` on the charge.
        data: { object: { id: "ch_9", customer: "cus_1", amount: 14_900, amount_refunded: 14_900, refunded: true } },
      } as never);
      expect(money.voided).toEqual(["in_9"]);
      expect(result.detail).toContain("voided partner commission");
    });

    it("checks a paid invoice's charge through the SDK, since the event's invoice has none", async () => {
      await seedPayer({ status: "active", stripeSubscriptionId: "sub_1" });
      stripeState.subscriptions.set("sub_1", stripeSubscription("sub_1"));
      const invoicePaid = (id: string) =>
        ({
          id: `evt_${id}`,
          type: "invoice.paid",
          data: {
            object: {
              id,
              customer: "cus_1",
              parent: { subscription_details: { subscription: "sub_1", metadata: { jobprofitaiUserId: "u1" } } },
              amount_paid: 14_900,
              status_transitions: { paid_at: nowSeconds() },
              lines: { data: [] },
            },
          },
        }) as never;
      stripeState.invoices.set("in_back", { id: "in_back", charge: { id: "ch_b", amount: 14_900, amount_refunded: 14_900, refunded: true } });
      stripeState.invoices.set("in_kept", { id: "in_kept", charge: "ch_k" });
      stripeState.charges.set("ch_k", { id: "ch_k", amount: 14_900, amount_refunded: 0, refunded: false });
      expect((await processStripeEvent(invoicePaid("in_back"))).detail).toContain("its payment was refunded");
      expect((await processStripeEvent(invoicePaid("in_kept"))).detail).not.toContain("refunded");
      expect(flat("lib/stripe/webhookHandlers.ts")).toContain('await stripe.invoices.retrieve(invoice.id, { expand: ["charge"] })');
    });
  });

  // -------------------------------------------------------------------------
  describe("4. deleting an account whose subscription can't be cancelled", () => {
    async function seedDeletable() {
      await seedPayer({ status: "active", stripeSubscriptionId: "sub_live" });
      await fake.client.quickBooksConnection.create({ data: { id: "c1", userId: "u1", realmIdHash: "h1", refreshToken: "rt" } });
      stripeState.subscriptions.set("sub_live", stripeSubscription("sub_live"));
      auth.session = { userId: "u1" };
    }
    const confirm = () => post({ password: "right-password", confirm: "DELETE" });

    it("keeps the account and says so when Stripe fails, before anything else is touched", async () => {
      await seedDeletable();
      stripeState.cancelError = Object.assign(new Error("An error occurred with our connection to Stripe."), { type: "StripeConnectionError" });
      const res: any = await deleteAccount(confirm());
      expect(res.status).toBe(502);
      expect(res.body.error).toContain("your account hasn't been deleted");
      expect(await fake.client.user.count()).toBe(1);
      expect(intuit.revoked).toBe(0);
      expect(reported).toHaveLength(1);
    });

    it("goes ahead when Stripe says the subscription doesn't exist", async () => {
      await seedDeletable();
      stripeState.subscriptions.delete("sub_live");
      stripeState.cancelError = missing("subscription", "sub_live");
      expect(((await deleteAccount(confirm())) as any).status).toBe(200);
      expect(await fake.client.user.count()).toBe(0);
      expect(reported).toHaveLength(0);
    });

    it.each(["canceled", "incomplete_expired"])("goes ahead when Stripe says the subscription is %s", async (status: string) => {
      await seedDeletable();
      stripeState.subscriptions.get("sub_live")!.status = status;
      stripeState.cancelError = new Error("Something went wrong");
      expect(((await deleteAccount(confirm())) as any).status).toBe(200);
      expect(await fake.client.user.count()).toBe(0);
    });

    it.each(["canceled", "unpaid", "incomplete", "paused", "trial_expired", "past_due"])(
      "asks Stripe whatever the stored status (%s), and refuses while it may still charge",
      async (stored: string) => {
        await seedDeletable();
        // The row says one thing; Stripe says the subscription is still live.
        await fake.client.subscription.update({ where: { userId: "u1" }, data: { status: stored } });
        stripeState.subscriptions.get("sub_live")!.status =
          stored === "canceled" ? "active" : stored === "trial_expired" ? "trialing" : stored;
        stripeState.cancelError = new Error("This subscription can't be cancelled right now.");
        const res: any = await deleteAccount(confirm());
        expect(res.status).toBe(502);
        expect(await fake.client.user.count()).toBe(1);
      }
    );

    describe("review 2, item 3: everything on the Stripe customer", () => {
      function seedMore() {
        // Paid moments ago; the webhook hasn't put it on file yet.
        stripeState.subscriptions.set("sub_new", stripeSubscription("sub_new"));
        stripeState.subscriptions.set("sub_old", stripeSubscription("sub_old", { status: "canceled" }));
        stripeState.subscriptions.set("sub_elsewhere", stripeSubscription("sub_elsewhere", { customer: "cus_other" }));
        stripeState.sessions.set("cs_o", { id: "cs_o", customer: "cus_1", status: "open", created: nowSeconds() - 60 });
      }

      it("cancels every live subscription on the customer, not only the one on file, and closes open checkouts", async () => {
        await seedDeletable();
        seedMore();
        const res: any = await deleteAccount(confirm());
        expect(res.status).toBe(200);
        expect(stripeState.subscriptions.get("sub_live")!.status).toBe("canceled");
        expect(stripeState.subscriptions.get("sub_new")!.status).toBe("canceled");
        expect(stripeState.subscriptions.get("sub_elsewhere")!.status).toBe("active");
        expect(stripeState.expired).toEqual(["cs_o"]);
        expect(await fake.client.user.count()).toBe(0);
      });

      it("deletes nothing when any one of them can't be stopped", async () => {
        await seedDeletable();
        seedMore();
        stripeState.subscriptions.get("sub_new")!.cancelFails = true;
        const res: any = await deleteAccount(confirm());
        expect(res.status).toBe(502);
        expect(await fake.client.user.count()).toBe(1);
        expect(intuit.revoked).toBe(0);
        expect(reported).toHaveLength(1);
      });

      it("deletes nothing when Stripe can't list them", async () => {
        await seedDeletable();
        const stripe: any = getStripe();
        const real = stripe.subscriptions.list;
        stripe.subscriptions.list = async () => {
          throw new Error("Stripe is down");
        };
        try {
          expect(((await deleteAccount(confirm())) as any).status).toBe(502);
          expect(await fake.client.user.count()).toBe(1);
        } finally {
          stripe.subscriptions.list = real;
        }
      });

      it("still cancels the one on file when the account has no Stripe customer on its row", async () => {
        await seedDeletable();
        await fake.client.subscription.update({ where: { userId: "u1" }, data: { stripeCustomerId: null } });
        expect(((await deleteAccount(confirm())) as any).status).toBe(200);
        expect(stripeState.subscriptions.get("sub_live")!.status).toBe("canceled");
      });
    });

    it("refuses when Stripe can't be reached to check", async () => {
      await seedDeletable();
      stripeState.cancelError = new Error("timeout");
      stripeState.subscriptions.get("sub_live")!.retrieveError = true;
      const res: any = await deleteAccount(confirm());
      expect(res.status).toBe(502);
    });
  });

  // -------------------------------------------------------------------------
  describe("5. a trial set in Stripe on a paid subscription", () => {
    it("is stored as active, so the paying customer keeps the plan they bought", async () => {
      await seedPayer();
      const result = await processStripeEvent(
        subscriptionEvent("evt_trial", stripeSubscription("sub_t", { status: "trialing", trial_end: nowSeconds() + 7 * 86_400 }))
      );
      const sub = await fake.client.subscription.findUnique({ where: { userId: "u1" } });
      expect(sub.status).toBe("active");
      expect(result.detail).toContain("active (Stripe: trialing)");
      const ent = await getEntitlements("u1");
      expect(ent.access).toBe("active");
      expect(ent.has("forecast_at_completion")).toBe(false); // the $149 plan, not trial features
      expect(storedStatusFor("past_due")).toBe("past_due");
    });

    it("reads older rows that stored Stripe's trialing (or had it expired) as the paid plan", async () => {
      await seedPayer({ status: "trialing", stripeSubscriptionId: "sub_t", plan: "profit_intelligence_pro", trialEndsAt: new Date(Date.now() - 20 * DAY) });
      expect((await getEntitlements("u1")).access).toBe("active");
      await fake.client.subscription.update({ where: { userId: "u1" }, data: { status: "trial_expired" } });
      const ent = await getEntitlements("u1");
      expect(ent.access).toBe("active");
      expect(ent.has("forecast_at_completion")).toBe(true);
    });

    it("gives such older rows no trial banner, trial emails or extension offer", async () => {
      await seedPayer({ status: "trialing", stripeSubscriptionId: "sub_t", trialEndsAt: new Date(Date.now() + 3 * DAY), activatedAt: new Date() });
      const state = computeTrialState(await fake.client.subscription.findUnique({ where: { userId: "u1" } }));
      expect(state).toMatchObject({ onTrial: false, expired: false, extensionOffered: false });
      // Our own trial is unchanged.
      const own = computeTrialState({ ...(await fake.client.subscription.findUnique({ where: { userId: "u1" } })), stripeSubscriptionId: null });
      expect(own.onTrial).toBe(true);
    });

    it("never expires a row with a Stripe subscription; our own trials still expire", async () => {
      await seedPayer({ status: "trialing", stripeSubscriptionId: "sub_t", trialEndsAt: new Date(Date.now() - DAY) });
      await fake.client.subscription.create({ data: { userId: "u2", status: "trialing", trialEndsAt: new Date(Date.now() - DAY) } });
      expect(await expireFinishedTrials()).toBe(1);
      expect((await fake.client.subscription.findUnique({ where: { userId: "u1" } })).status).toBe("trialing");
      expect((await fake.client.subscription.findUnique({ where: { userId: "u2" } })).status).toBe("trial_expired");
    });
  });

  // -------------------------------------------------------------------------
  describe("6. a webhook run that never finished", () => {
    const event = () => subscriptionEvent("evt_claim", stripeSubscription("sub_c"));

    it("builds the Stripe client with a 15 second timeout and one retry", () => {
      getStripe();
      expect(stripeState.options.at(-1)).toMatchObject({ timeout: 15_000, maxNetworkRetries: 1, apiVersion: "2024-06-20" });
    });

    it("marks a claim finished only once the work is done", async () => {
      await seedPayer();
      await processStripeEvent(event());
      expect((await fake.client.stripeEvent.findUnique({ where: { id: "evt_claim" } })).type).toBe("customer.subscription.updated");
      expect((await processStripeEvent(event())).duplicate).toBe(true);
    });

    it("re-runs an event whose claim is over two minutes old and never finished", async () => {
      await seedPayer();
      await fake.client.stripeEvent.create({
        data: { id: "evt_claim", type: `${CLAIM_IN_PROGRESS_PREFIX}customer.subscription.updated`, processedAt: new Date(Date.now() - 3 * 60_000) },
      });
      const result = await processStripeEvent(event());
      expect(result.duplicate).toBeUndefined();
      expect((await fake.client.subscription.findUnique({ where: { userId: "u1" } })).status).toBe("active");
      expect((await fake.client.stripeEvent.findUnique({ where: { id: "evt_claim" } })).type).toBe("customer.subscription.updated");
    });

    it("asks Stripe to come back while the first delivery may still be running, without releasing its claim", async () => {
      await seedPayer();
      await fake.client.stripeEvent.create({
        data: { id: "evt_claim", type: `${CLAIM_IN_PROGRESS_PREFIX}customer.subscription.updated`, processedAt: new Date(Date.now() - 30_000) },
      });
      await expect(processStripeEvent(event())).rejects.toBeInstanceOf(EventInProgressError);
      expect(await fake.client.stripeEvent.count()).toBe(1);
      expect((await fake.client.subscription.findUnique({ where: { userId: "u1" } })).status).toBe("trialing");
    });
  });

  // -------------------------------------------------------------------------
  describe("7. signups per network address", () => {
    const form = (i: number, ip: string) =>
      post({ email: `person${i}@example.com`, password: "long-enough-1", acceptTerms: true }, { "x-forwarded-for": `${ip}, 10.0.0.1` });

    it(`allows ${SIGNUPS_PER_IP_PER_HOUR} an hour from one address, and counts nothing toward sign-in lockouts`, async () => {
      for (let i = 1; i <= SIGNUPS_PER_IP_PER_HOUR; i++) {
        expect(((await signup(form(i, "9.9.9.9"))) as any).status).toBe(200);
      }
      const refused: any = await signup(form(99, "9.9.9.9"));
      expect(refused.status).toBe(429);
      expect(await fake.client.user.findFirst({ where: { email: "person99@example.com" } })).toBeNull();
      expect(emails.filter((e) => e === "email_verification")).toHaveLength(SIGNUPS_PER_IP_PER_HOUR);
      expect(((await signup(form(100, "8.8.8.8"))) as any).status).toBe(200);
      expect(await isLockedOut("person1@example.com", "9.9.9.9")).toBe(false);
    });

    it("can't be got round by sending signups at once", async () => {
      // Started a moment apart, so their steps interleave every which way.
      const results: any[] = await Promise.all(
        Array.from({ length: 25 }, async (_, i) => {
          for (let k = 0; k < i * 3; k++) await null;
          return signup(form(200 + i, "7.7.7.7"));
        })
      );
      const created = results.filter((r) => r.status === 200).length;
      expect(created).toBeGreaterThan(0);
      expect(created).toBeLessThanOrEqual(SIGNUPS_PER_IP_PER_HOUR);
      expect(results.filter((r) => r.status === 429).length).toBe(25 - created);
      expect(emails.filter((e) => e === "email_verification")).toHaveLength(created);
      // Refused ones give their place back, so only real signups are counted.
      expect(await fake.client.loginAttempt.count({ where: { emailHash: signupKey("7.7.7.7") } })).toBe(created);
    });

    it("gives the place back when no account is created", async () => {
      await fake.client.user.create({ data: { id: "taken", email: "person1@example.com" } });
      for (let i = 0; i < SIGNUPS_PER_IP_PER_HOUR + 2; i++) {
        expect(((await signup(form(1, "6.6.6.6"))) as any).status).toBe(409);
      }
      expect(((await signup(form(2, "6.6.6.6"))) as any).status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  describe("8. a login that joins a team with its own checkout still open", () => {
    it("keeps its billing row, with no plan or trial, and closes the open checkout", async () => {
      await fake.client.user.create({ data: { id: "owner", email: "owner@example.com", name: "Sam Builder", emailVerifiedAt: new Date() } });
      await fake.client.subscription.create({ data: { userId: "owner", status: "trialing", trialEndsAt: new Date(Date.now() + 5 * DAY) } });
      await fake.client.user.create({ data: { id: "pm", email: "pm@example.com" } });
      await fake.client.subscription.create({
        data: { userId: "pm", status: "trialing", stripeCustomerId: "cus_pm", trialEndsAt: new Date(Date.now() + 9 * DAY) },
      });
      stripeState.sessions.set("cs_open", { id: "cs_open", customer: "cus_pm", status: "open", created: nowSeconds() - 600 });
      // A checkout finished two hours ago whose subscription has since ended.
      stripeState.sessions.set("cs_done", { id: "cs_done", customer: "cus_pm", status: "complete", created: nowSeconds() - 7200 });
      const invite = await createInvite("owner", "pm@example.com");
      if (!invite.ok) throw new Error(invite.error);
      expect((await acceptInvite(invite.token, "pm")).ok).toBe(true);
      const row = await fake.client.subscription.findUnique({ where: { userId: "pm" } });
      expect(row).toMatchObject({ status: "none", stripeCustomerId: "cus_pm", trialEndsAt: null });
      expect(stripeState.expired).toEqual(["cs_open"]);
    });

    describe("6 (review). a login that has just paid for its own plan", () => {
      async function seedJoiner() {
        await fake.client.user.create({ data: { id: "owner", email: "owner@example.com", name: "Sam Builder", emailVerifiedAt: new Date() } });
        await fake.client.subscription.create({ data: { userId: "owner", status: "trialing", trialEndsAt: new Date(Date.now() + 5 * DAY) } });
        await fake.client.user.create({ data: { id: "pm", email: "pm@example.com" } });
        // Our row hasn't heard from the webhook yet: still the trial.
        await fake.client.subscription.create({
          data: { userId: "pm", status: "trialing", stripeCustomerId: "cus_pm", trialEndsAt: new Date(Date.now() + 9 * DAY) },
        });
        const invite = await createInvite("owner", "pm@example.com");
        if (!invite.ok) throw new Error(invite.error);
        return invite.token;
      }

      it("can't join while Stripe has a live subscription for it", async () => {
        const token = await seedJoiner();
        stripeState.subscriptions.set("sub_pm", stripeSubscription("sub_pm", { customer: "cus_pm" }));
        expect(await acceptInvite(token, "pm")).toEqual({ ok: false, error: OWN_PLAN_JOIN_MESSAGE, status: 409 });
        expect(await fake.client.teamMember.findFirst({ where: { memberUserId: "pm" } })).toBeNull();
        // Its own billing row is left as it was.
        expect((await fake.client.subscription.findUnique({ where: { userId: "pm" } })).status).toBe("trialing");
      });

      it("can't join while a checkout it completed in the last hour is still going through", async () => {
        const token = await seedJoiner();
        stripeState.sessions.set("cs_paid", { id: "cs_paid", customer: "cus_pm", status: "complete", created: nowSeconds() - 60, subscription: "sub_new" });
        expect(await acceptInvite(token, "pm")).toMatchObject({ ok: false, status: 409 });
      });

      it("isn't let in when Stripe can't be asked", async () => {
        const token = await seedJoiner();
        const stripe: any = getStripe();
        const real = stripe.subscriptions.list;
        stripe.subscriptions.list = async () => {
          throw new Error("Stripe is down");
        };
        try {
          expect(await acceptInvite(token, "pm")).toMatchObject({ ok: false, status: 503 });
        } finally {
          stripe.subscriptions.list = real;
        }
      });
    });

    it("still drops the trial row of a login that never started a checkout", async () => {
      await fake.client.user.create({ data: { id: "owner", email: "owner@example.com", emailVerifiedAt: new Date() } });
      await fake.client.subscription.create({ data: { userId: "owner", status: "trialing", trialEndsAt: new Date(Date.now() + 5 * DAY) } });
      await fake.client.user.create({ data: { id: "pm", email: "pm@example.com" } });
      await fake.client.subscription.create({ data: { userId: "pm", status: "trialing", trialEndsAt: new Date(Date.now() + 9 * DAY) } });
      const invite = await createInvite("owner", "pm@example.com");
      if (!invite.ok) throw new Error(invite.error);
      await acceptInvite(invite.token, "pm");
      expect(await fake.client.subscription.findUnique({ where: { userId: "pm" } })).toBeNull();
    });

    it("creates the billing row from the webhook when it's missing, instead of failing every retry", async () => {
      await fake.client.user.create({ data: { id: "u7", email: "seven@example.com" } });
      await processStripeEvent(
        subscriptionEvent("evt_missing_row", stripeSubscription("sub_7", { customer: "cus_7", metadata: { jobprofitaiUserId: "u7" } }))
      );
      const row = await fake.client.subscription.findUnique({ where: { userId: "u7" } });
      expect(row).toMatchObject({ status: "active", stripeCustomerId: "cus_7", stripeSubscriptionId: "sub_7", plan: "profit_intelligence" });
    });
  });

  // -------------------------------------------------------------------------
  describe("9. an unpaid subscription", () => {
    it("counts as live in Stripe, so no second subscription can start beside it", async () => {
      expect(isLiveSubscriptionStatus("unpaid")).toBe(true);
      const decision = secondCheckoutDecision([{ id: "sub_u", status: "unpaid", created: 1 }], [], 2);
      expect(decision).toEqual({ block: true, message: UNPAID_SUBSCRIPTION_MESSAGE });
      await seedPayer({ status: "unpaid", stripeSubscriptionId: "sub_u" });
      stripeState.subscriptions.set("sub_u", stripeSubscription("sub_u", { status: "unpaid" }));
      auth.session = { userId: "u1" };
      const res: any = await checkout(post({ plan: "profit_intelligence" }));
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(UNPAID_SUBSCRIPTION_MESSAGE);
    });

    it("doesn't trust a stale stored 'unpaid': one Stripe has canceled can check out", async () => {
      await seedPayer({ status: "unpaid", stripeSubscriptionId: "sub_u" });
      stripeState.subscriptions.set("sub_u", stripeSubscription("sub_u", { status: "canceled" }));
      auth.session = { userId: "u1" };
      const res: any = await checkout(post({ plan: "profit_intelligence" }));
      expect(res.status).toBe(200);
      expect(res.body.url).toContain("checkout.stripe.test");
      expect(flat("app/dashboard/billing/page.tsx")).not.toContain("unpaidReason");
    });
  });

  // -------------------------------------------------------------------------
  describe("10. someone else's wrong passwords", () => {
    const attempt = (password: string, ip: string) => login(post({ email: "owner@example.com", password }, { "x-forwarded-for": ip })) as Promise<any>;

    it("lock the address for every network address after 8, checked before the password", async () => {
      await seedPayer();
      for (let i = 0; i < 8; i++) expect((await attempt("wrong", `1.1.1.${i}`)).status).toBe(401);
      expect(auth.passwordChecks).toBe(8);
      // Strict: even the right password from an address with no failures waits.
      expect((await attempt("right-password", "2.2.2.2")).status).toBe(429);
      expect(auth.passwordChecks).toBe(8);
      expect(auth.created).toEqual([]);
      expect(await isLockedOut("owner@example.com", "2.2.2.2")).toBe(true);
    });

    it("can't be got round by sending guesses at once", async () => {
      await seedPayer();
      const results: any[] = await Promise.all(
        Array.from({ length: 20 }, async (_, i) => {
          for (let k = 0; k < i * 3; k++) await null;
          return attempt("wrong", `3.3.${i}.1`);
        })
      );
      expect(auth.passwordChecks).toBeGreaterThan(0);
      expect(auth.passwordChecks).toBeLessThanOrEqual(8);
      expect(results.filter((r) => r.status === 401).length).toBe(auth.passwordChecks);
      // Refused requests aren't counted as guesses.
      expect(await fake.client.loginAttempt.count({ where: { emailHash: emailKey("owner@example.com"), success: false } })).toBe(
        auth.passwordChecks
      );
    });

    it("count a right password as a success, not a failure", async () => {
      await seedPayer();
      for (let i = 0; i < 7; i++) await attempt("wrong", "4.4.4.4");
      expect((await attempt("right-password", "4.4.4.4")).status).toBe(200);
      expect(await isLockedOut("owner@example.com", "4.4.4.4")).toBe(false);
    });

    it("are forgotten after a password reset, the customer's way back in", async () => {
      await seedPayer();
      for (let i = 0; i < 8; i++) await attempt("wrong", "1.1.1.1");
      expect((await attempt("right-password", "1.1.1.1")).status).toBe(429);
      await fake.client.passwordResetToken.create({
        data: { userId: "u1", tokenHash: hashToken("reset-token-123"), expiresAt: new Date(Date.now() + 3_600_000) },
      });
      const res: any = await resetPassword(post({ token: "reset-token-123", password: "new-password-1" }));
      expect(res.body).toEqual({ ok: true, signedIn: true });
      expect(await isLockedOut("owner@example.com", "1.1.1.1")).toBe(false);
      expect((await attempt("new-password-1", "1.1.1.1")).status).toBe(200);
      await clearFailedLogins("nobody@example.com"); // harmless for an address with none
    });

    describe("review 2, item 1: the reset email is always a way in", () => {
      async function resetLink(token: string) {
        await fake.client.passwordResetToken.create({
          data: { userId: "u1", tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3_600_000) },
        });
      }

      it("signs the customer in, under the new session version, while a stranger keeps the form locked", async () => {
        await seedPayer({}, { sessionVersion: 0 });
        await resetLink("reset-token-456");
        for (let i = 0; i < 8; i++) await attempt("wrong", "9.8.7.6");
        // The stranger locks the address again straight after the reset.
        const res: any = await resetPassword(post({ token: "reset-token-456", password: "new-password-2" }));
        for (let i = 0; i < 8; i++) await attempt("wrong", "9.8.7.6");
        expect(res.body).toEqual({ ok: true, signedIn: true });
        expect((await attempt("new-password-2", "9.9.9.1")).status).toBe(429);
        // Still in: the reset gave this browser a session, issued after the
        // version moved on, so every older session has ended.
        expect(auth.session).toEqual({ userId: "u1" });
        expect(auth.versions).toEqual([1]);
        expect((await fake.client.user.findUnique({ where: { id: "u1" } })).sessionVersion).toBe(1);
      });

      it("refuses a reset sent from another site, since it now starts a session", async () => {
        await seedPayer();
        await resetLink("reset-token-789");
        const res: any = await resetPassword(
          post({ token: "reset-token-789", password: "new-password-3" }, { "sec-fetch-site": "cross-site" })
        );
        expect(res.status).toBe(403);
        expect(auth.created).toEqual([]);
      });
    });

    it("lock the Intuit link form the same way", async () => {
      const link = flat("app/api/auth/intuit/link/route.ts");
      expect(link).toContain("const attempt = await startLoginAttempt(email, ip); if (attempt.locked) {");
      expect(link).toContain("await finishLoginAttempt(attempt.attemptId, valid);");
      expect(link).not.toContain("correct_only");
      expect(flat("app/api/auth/login/route.ts")).not.toContain("correct_only");
    });
  });

  // -------------------------------------------------------------------------
  describe("review 2, item 2: looking a login up by its address", () => {
    /** Makes the fake answer case-insensitive `equals` the way ILIKE can: `_` and `%` as wildcards. */
    function likePostgresIlike() {
      const findMany = fake.client.user.findMany.bind(fake.client.user);
      const ilike = (pattern: string) =>
        new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, ".").replace(/%/g, ".*")}$`, "i");
      fake.client.user.findMany = async (args: Obj = {}) => {
        const cond = args.where?.email;
        if (cond && typeof cond === "object" && cond.mode === "insensitive") {
          const re = ilike(String(cond.equals));
          const all = await findMany({});
          return all.filter((u: Obj) => re.test(u.email)).slice(0, args.take ?? Infinity);
        }
        return findMany(args);
      };
      fake.client.user.findFirst = async (args: Obj = {}) => (await fake.client.user.findMany(args))[0] ?? null;
    }

    it("never finds another login through a wildcard in what was typed", async () => {
      likePostgresIlike();
      await seedPayer({}, { email: "john@example.com" });
      expect(await findLoginByEmail("j_hn@example.com")).toBeNull();
      expect(await findLoginByEmail("%@example.com")).toBeNull();
      expect((await findLoginByEmail(" John@Example.com "))?.id).toBe("u1");
    });

    it("still finds an older mixed-case address, exactly", async () => {
      likePostgresIlike();
      await fake.client.user.create({ data: { id: "old", email: "Mary.O_Neil@Example.com", passwordHash: "hashed:pw-12345" } });
      await fake.client.user.create({ data: { id: "other", email: "maryxo1neil@example.com", passwordHash: "hashed:pw-other" } });
      expect((await findLoginByEmail("mary.o_neil@example.com"))?.id).toBe("old");
    });

    it("can't spend another address's guesses on john's password", async () => {
      likePostgresIlike();
      await seedPayer({}, { email: "john@example.com" });
      const res: any = await login(post({ email: "j_hn@example.com", password: "right-password" }, { "x-forwarded-for": "1.2.3.4" }));
      expect(res.status).toBe(401);
      expect(auth.passwordChecks).toBe(0);
      expect(auth.created).toEqual([]);
      // Counted against exactly what was typed, lowercased.
      expect(await fake.client.loginAttempt.count({ where: { emailHash: emailKey("j_hn@example.com"), success: false } })).toBe(1);
      expect(await fake.client.loginAttempt.count({ where: { emailHash: emailKey("john@example.com") } })).toBe(0);
    });

    it("doesn't call a different address taken at signup, or send its owner a reset", async () => {
      likePostgresIlike();
      await seedPayer({}, { email: "john@example.com" });
      const res: any = await signup(post({ email: "j_hn@example.com", password: "long-enough-1", acceptTerms: true }, { "x-forwarded-for": "5.4.3.2" }));
      expect(res.status).toBe(200);
      await forgotPassword(post({ email: "jo%@example.com" }));
      expect(await fake.client.passwordResetToken.count({ where: { userId: "u1" } })).toBe(0);
      await forgotPassword(post({ email: "JOHN@example.com" }));
      expect(await fake.client.passwordResetToken.count({ where: { userId: "u1" } })).toBe(1);
    });

    it("is the one lookup every sign-in and signup path uses", () => {
      for (const file of [
        "app/api/auth/login/route.ts",
        "app/api/auth/intuit/link/route.ts",
        "app/api/auth/intuit/create/route.ts",
        "app/api/auth/signup/route.ts",
        "app/api/auth/forgot-password/route.ts",
        "app/api/team/accept/route.ts",
        "app/login/intuit/page.tsx",
        "app/invite/[token]/page.tsx",
        "lib/intuitSignIn.ts",
      ]) {
        const src = flat(file);
        expect(src).toContain("findLoginByEmail(");
        expect(src).not.toContain('mode: "insensitive"');
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("11. a browser's opt-out is saved before anything is reported", () => {
    it("on Sign in with Intuit, before the company is attached", async () => {
      await fake.client.user.create({ data: { id: "u1", email: "sam@builder.com", intuitSub: "intuit-sub-1", gaClientId: "1.2" } });
      const res: any = await startIntuitFlow("appstore");
      jar.set(OIDC_NONCE_COOKIE, res.setCookies[OIDC_NONCE_COOKIE]);
      const payload = JSON.parse(Buffer.from(new URL(res.url).searchParams.get("state")!.split(".")[1], "base64url").toString());
      await handleIntuitFlow("intuit_appstore", payload, "code", "123", new Headers({ "sec-gpc": "1" }));
      expect(attached).toEqual([{ ownerId: "u1", optedOut: true }]);
    });

    it("on linking an Intuit identity to a login, both ways", async () => {
      const { SignJWT } = await import("jose");
      const pending = await new SignJWT({ purpose: "intuit_pending", sub: "intuit-sub-2", email: "owner@example.com", name: null, connect: true })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("15m")
        .sign(new TextEncoder().encode(ENV.AUTH_SECRET));
      await seedPayer({}, { adOptOutAt: null });
      jar.set(INTUIT_PENDING_COOKIE, pending);
      const res: any = await linkIntuit(
        post({ email: "owner@example.com", password: "right-password" }, { cookie: "jpai_optout=1", "x-forwarded-for": "4.4.4.4" })
      );
      expect(res.body).toEqual({ ok: true, connect: true });
      const user = await fake.client.user.findUnique({ where: { id: "u1" } });
      expect(user).toMatchObject({ intuitSub: "intuit-sub-2", adOptOutSource: "privacy_page" });
      expect(flat("app/api/auth/intuit/link/route.ts")).toContain("await carryAdOptOutToBrowser(user);");
    });
  });

  // -------------------------------------------------------------------------
  describe("12. European time zones outside Europe/", () => {
    it.each([
      "Asia/Nicosia",
      "Asia/Famagusta",
      "Atlantic/Canary",
      "Atlantic/Madeira",
      "Atlantic/Azores",
      "Africa/Ceuta",
      "Arctic/Longyearbyen",
      "Indian/Reunion",
      "Indian/Mayotte",
      "America/Martinique",
      "America/Guadeloupe",
      "America/Cayenne",
      "America/Marigot",
      "America/St_Barthelemy",
      "Atlantic/Reykjavik",
      "Europe/Lisbon",
    ])("counts %s", (zone: string) => {
      expect(europeanTimeZone(zone)).toBe(true);
    });

    it("and not the Americas or Asia generally", () => {
      for (const zone of ["America/Chicago", "America/Puerto_Rico", "Asia/Tokyo", "Atlantic/Bermuda", undefined]) {
        expect(europeanTimeZone(zone)).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("13. a purchase is reported only once it's paid", () => {
    async function complete(id: string, paymentStatus: string, amount = 14_900) {
      return processStripeEvent({
        id,
        type: "checkout.session.completed",
        data: {
          object: {
            id: `cs_${id}`,
            customer: "cus_1",
            subscription: "sub_1",
            client_reference_id: "u1",
            metadata: { jobprofitaiUserId: "u1", plan: "profit_intelligence" },
            payment_status: paymentStatus,
            amount_total: amount,
            amount_subtotal: amount,
            total_details: { amount_tax: 0 },
            currency: "usd",
          },
        },
      } as never);
    }

    it("skips a bank debit still settling, and reports a paid card or a $0 first month", async () => {
      await seedPayer({}, { gaClientId: "111.222" });
      stripeState.subscriptions.set("sub_1", stripeSubscription("sub_1"));
      await complete("evt_unpaid", "unpaid");
      expect(sent).toEqual([]);
      await complete("evt_paid", "paid");
      expect(sent).toEqual([{ name: "purchase", params: { transaction_id: "cs_evt_paid", value: 149, currency: "USD", plan: "profit_intelligence" } }]);
      await complete("evt_free", "no_payment_required", 0);
      expect(sent[1]).toEqual({ name: "purchase", params: { transaction_id: "cs_evt_free", value: 0, currency: "USD", plan: "profit_intelligence" } });
    });
  });

  // -------------------------------------------------------------------------
  describe("14. a team member deleting their own login", () => {
    it("comes off the brief and alert lists of the account they belonged to", async () => {
      await fake.client.user.create({ data: { id: "owner", email: "owner@example.com" } });
      await fake.client.quickBooksConnection.create({
        data: { id: "c1", userId: "owner", realmIdHash: "h1", refreshToken: "rt", emailRecipients: ["owner@example.com", "PM@example.com"], emailEnabled: true },
      });
      await fake.client.quickBooksConnection.create({
        data: { id: "c2", userId: "owner", realmIdHash: "h2", refreshToken: "rt", emailRecipients: ["pm@example.com"], emailEnabled: true },
      });
      await fake.client.user.create({ data: { id: "pm", email: "pm@example.com", passwordHash: "hashed:pm-password" } });
      await fake.client.teamMember.create({
        data: { ownerUserId: "owner", email: "pm@example.com", memberUserId: "pm", tokenHash: "t", acceptedAt: new Date(), expiresAt: new Date() },
      });
      auth.session = { userId: "pm" };
      const res: any = await deleteAccount(post({ password: "pm-password", confirm: "DELETE" }));
      expect(res.status).toBe(200);
      const c1 = await fake.client.quickBooksConnection.findUnique({ where: { id: "c1" } });
      const c2 = await fake.client.quickBooksConnection.findUnique({ where: { id: "c2" } });
      expect(c1).toMatchObject({ emailRecipients: ["owner@example.com"], emailEnabled: true });
      // A list left empty turns the brief off, as when the owner removes someone.
      expect(c2).toMatchObject({ emailRecipients: [], emailEnabled: false });
      // The member's own login went; the owner's companies were not touched otherwise.
      expect(await fake.client.user.findUnique({ where: { id: "pm" } })).toBeNull();
      expect(intuit.revoked).toBe(0);
    });

    it("leaves another account's lists alone for a login that was removed from it, or never joined", async () => {
      await fake.client.user.create({ data: { id: "owner", email: "owner@example.com" } });
      // The owner added the address back to a brief by hand after removing the login.
      await fake.client.quickBooksConnection.create({
        data: { id: "c1", userId: "owner", realmIdHash: "h1", refreshToken: "rt", emailRecipients: ["pm@example.com"], emailEnabled: true },
      });
      await fake.client.user.create({ data: { id: "pm", email: "pm@example.com", passwordHash: "hashed:pm-password" } });
      await fake.client.teamMember.create({
        data: { ownerUserId: "owner", email: "pm@example.com", memberUserId: "pm", tokenHash: "t", role: "removed", acceptedAt: null, expiresAt: new Date() },
      });
      auth.session = { userId: "pm" };
      expect(((await deleteAccount(post({ password: "pm-password", confirm: "DELETE" }))) as any).status).toBe(200);
      expect(await fake.client.quickBooksConnection.findUnique({ where: { id: "c1" } })).toMatchObject({
        emailRecipients: ["pm@example.com"],
        emailEnabled: true,
      });
      expect(flat("app/api/account/delete/route.ts")).toContain(
        "if (membership?.acceptedAt && membership.role !== REMOVED_ROLE && membership.ownerUserId !== user.id) {"
      );
    });
  });
});
