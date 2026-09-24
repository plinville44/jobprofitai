import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

process.env.AUTH_SECRET = "test-secret-for-intuit-sign-in-tests";
process.env.APP_URL = "https://app.example.com";

const fake: { client: FakePrisma } = { client: createFakePrisma() };
const jar = new Map<string, string>();
const calls = {
  sessions: [] as string[],
  attach: [] as { ownerId: string; realmId: string }[],
  attachResult: { ok: true, connectionId: "conn_1" } as any,
  userinfo: null as any,
  revoked: 0,
};

vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
}));
vi.mock("next/server", () => ({
  NextResponse: {
    redirect: (url: URL | string) => {
      const set: Record<string, string> = {};
      return { url: String(url), setCookies: set, cookies: { set: (n: string, v: string) => (set[n] = v) } };
    },
  },
}));
vi.mock("@/lib/auth", () => ({
  createSession: async (userId: string) => {
    calls.sessions.push(userId);
    return "token";
  },
  hashPassword: async (p: string) => `hashed:${p}`,
}));
vi.mock("@/lib/quickbooks", () => ({
  OPENID_SCOPES: "openid profile email",
  CONNECT_WITH_OPENID_SCOPES: "com.intuit.quickbooks.accounting openid profile email",
  buildAuthorizeUrl: async (state: string, scope: string) => `https://intuit.example/authorize?scope=${scope}&state=${state}`,
  exchangeCodeForTokens: async () => ({ access_token: "at", refresh_token: "rt", expires_in: 3600, x_refresh_token_expires_in: 8_640_000 }),
  fetchIntuitUserInfo: async () => calls.userinfo,
  revokeToken: async () => {
    calls.revoked++;
  },
}));
vi.mock("@/lib/connectCompany", () => ({
  attachCompany: async (input: { ownerId: string; realmId: string }) => {
    calls.attach.push({ ownerId: input.ownerId, realmId: input.realmId });
    return calls.attachResult;
  },
}));
vi.mock("@/lib/account", () => ({
  ACTIVE_COMPANY_COOKIE: "jpai_company",
  accountFor: async (userId: string) => ({ userId, ownerId: userId, role: "owner" }),
}));
vi.mock("@/lib/crypto", () => ({ hashRealmId: (r: string) => `hash:${r}`, legacyHashRealmId: (r: string) => `legacy:${r}` }));
vi.mock("@/lib/trial", () => ({ newTrialSubscriptionData: () => ({ status: "trialing" }) }));
vi.mock("@/lib/signupReferral", () => ({ attributeSignupReferral: async () => false }));
vi.mock("@/lib/referrals", () => ({ REFERRAL_COOKIE: "jpai_ref" }));

import {
  handleIntuitFlow,
  INTUIT_PENDING_COOKIE,
  OIDC_NONCE_COOKIE,
  readPendingIntuitIdentity,
  startIntuitFlow,
} from "../intuitSignIn";

const verified = { sub: "intuit-sub-1", email: "sam@builder.com", emailVerified: true, givenName: "Sam", familyName: "Builder" };

beforeEach(() => {
  fake.client = createFakePrisma();
  jar.clear();
  calls.sessions = [];
  calls.attach = [];
  calls.attachResult = { ok: true, connectionId: "conn_1" };
  calls.userinfo = { ...verified };
  calls.revoked = 0;
});

/** Starts a flow and moves its nonce cookie into the browser jar, like a real round trip. */
async function begin(intent: "signin" | "appstore") {
  const res: any = await startIntuitFlow(intent);
  jar.set(OIDC_NONCE_COOKIE, res.setCookies[OIDC_NONCE_COOKIE]);
  const state = decodeURIComponent(new URL(res.url).searchParams.get("state")!);
  const payload = JSON.parse(Buffer.from(state.split(".")[1], "base64url").toString());
  return { res, payload };
}

describe("startIntuitFlow", () => {
  it("asks for identity only when signing in, and QuickBooks access too from the App Store", async () => {
    const signin: any = await startIntuitFlow("signin");
    const appstore: any = await startIntuitFlow("appstore");
    expect(new URL(signin.url).searchParams.get("scope")).toBe("openid profile email");
    expect(new URL(appstore.url).searchParams.get("scope")).toContain("com.intuit.quickbooks.accounting");
    expect(signin.setCookies[OIDC_NONCE_COOKIE]).toBeTruthy();
  });
});

describe("handleIntuitFlow", () => {
  it("refuses a callback that didn't start in this browser", async () => {
    const { payload } = await begin("signin");
    jar.delete(OIDC_NONCE_COOKIE);
    const res: any = await handleIntuitFlow("intuit_signin", payload, "code", null);
    expect(res.url).toContain("notice=intuit_session");
    expect(calls.sessions).toEqual([]);
  });

  it("refuses an Intuit account whose email isn't verified", async () => {
    calls.userinfo = { ...verified, emailVerified: false };
    await fake.client.user.create({ data: { id: "u1", email: "sam@builder.com", intuitSub: "intuit-sub-1" } });
    const { payload } = await begin("signin");
    const res: any = await handleIntuitFlow("intuit_signin", payload, "code", null);
    expect(res.url).toContain("notice=intuit_unverified");
    expect(calls.sessions).toEqual([]);
  });

  it("signs in a known Intuit account by its sub, not its email", async () => {
    calls.userinfo = { ...verified, email: "changed@elsewhere.com" };
    await fake.client.user.create({ data: { id: "u1", email: "sam@builder.com", intuitSub: "intuit-sub-1" } });
    const { payload } = await begin("signin");
    const res: any = await handleIntuitFlow("intuit_signin", payload, "code", null);
    expect(calls.sessions).toEqual(["u1"]);
    expect(res.url).toBe("https://app.example.com/dashboard");
  });

  it("gives back an unused App Store grant only when nobody has the company connected", async () => {
    calls.userinfo = { ...verified, emailVerified: false };
    let { payload } = await begin("appstore");
    await handleIntuitFlow("intuit_appstore", payload, "code", "123");
    expect(calls.revoked).toBe(1);
    await fake.client.quickBooksConnection.create({ data: { userId: "someone", realmIdHash: "hash:123" } });
    ({ payload } = await begin("appstore"));
    await handleIntuitFlow("intuit_appstore", payload, "code", "123");
    expect(calls.revoked).toBe(1);
  });

  it("never signs into an existing login just because the email matches", async () => {
    await fake.client.user.create({ data: { id: "u1", email: "Sam@Builder.com" } });
    const { payload } = await begin("appstore");
    const res: any = await handleIntuitFlow("intuit_appstore", payload, "code", "123");
    expect(calls.sessions).toEqual([]);
    expect(calls.attach).toEqual([]);
    expect(res.url).toBe("https://app.example.com/login/intuit");
    jar.set(INTUIT_PENDING_COOKIE, res.setCookies[INTUIT_PENDING_COOKIE]);
    const pending = await readPendingIntuitIdentity();
    expect(pending).toMatchObject({ sub: "intuit-sub-1", email: "sam@builder.com", connect: true });
  });

  it("asks a new person who only signed in whether to create an account", async () => {
    const { payload } = await begin("signin");
    const res: any = await handleIntuitFlow("intuit_signin", payload, "code", null);
    expect(res.url).toBe("https://app.example.com/login/intuit");
    expect(await fake.client.user.count()).toBe(0);
  });

  it("gives a new App Store customer an account, a trial and the company, with no questions", async () => {
    const { payload } = await begin("appstore");
    const res: any = await handleIntuitFlow("intuit_appstore", payload, "code", "123");
    const user = await fake.client.user.findFirst({ where: { intuitSub: "intuit-sub-1" } });
    expect(user).toMatchObject({ email: "sam@builder.com", name: "Sam Builder" });
    expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(calls.sessions).toEqual([user!.id]);
    expect(calls.attach).toEqual([{ ownerId: user!.id, realmId: "123" }]);
    expect(res.url).toContain("/dashboard?qbo_connected=1");
    expect(res.setCookies.jpai_company).toBe("conn_1");
  });

  it("sends a refused company to the plan page", async () => {
    await fake.client.user.create({ data: { id: "u1", email: "sam@builder.com", intuitSub: "intuit-sub-1" } });
    calls.attachResult = { ok: false, code: "plan_limit", message: "No room." };
    const { payload } = await begin("appstore");
    const res: any = await handleIntuitFlow("intuit_appstore", payload, "code", "123");
    expect(res.url).toContain("/dashboard/billing?limit=");
  });

  it("rejects flows it doesn't know", async () => {
    const res: any = await handleIntuitFlow("something_else", {}, "code", null);
    expect(res.url).toContain("notice=invalid_state");
  });
});
