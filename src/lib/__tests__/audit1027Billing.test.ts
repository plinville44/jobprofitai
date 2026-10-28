import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import bcrypt from "bcryptjs";
import { createFakePrisma, FakeModel, type FakePrisma } from "./support/fakePrisma";

// Fixes from the Oct 27, 2026 audit to billing, sign-in and team logins.
// One block per audit item, named as in the audit doc (B2, B3, B7, B9, Z2,
// Z3). The routes run for real against the in-memory database, with real
// zod, real bcrypt and real session cookies; Stripe, QuickBooks and email
// are stand-ins.

// --- Stand-ins ----------------------------------------------------------------

// vi.mock factories run before the rest of this file, so everything they
// use is made in vi.hoisted.
const fake = vi.hoisted(() => ({ client: {} as Record<string, any> }));

// Next.js's own request and response, as far as these routes use them, and
// `after`, which outside a real request would throw. Work passed to `after`
// is held until a test runs it, the way it runs only once the reply is sent.
const nextServer = vi.hoisted(() => {
  const afterTasks: (() => unknown)[] = [];
  class NextResponse extends Response {
    readonly cookies = { set: () => undefined, get: () => undefined, delete: () => undefined };
    static json(body: unknown, init?: ResponseInit) {
      const headers = new Headers(init?.headers);
      headers.set("content-type", "application/json");
      return new NextResponse(JSON.stringify(body), { ...init, headers });
    }
  }
  class NextRequest extends Request {
    readonly nextUrl: URL;
    constructor(input: string, init?: RequestInit) {
      super(input, init);
      this.nextUrl = new URL(input);
    }
  }
  const after = (task: () => unknown) => void afterTasks.push(task);
  /** Runs what routes left for after their reply, in order. */
  const runAfterTasks = async () => {
    while (afterTasks.length) await afterTasks.shift()!();
  };
  return { NextResponse, NextRequest, after, afterTasks, runAfterTasks };
});
vi.mock("next/server", () => ({ NextResponse: nextServer.NextResponse, NextRequest: nextServer.NextRequest, after: nextServer.after }));
const { NextRequest } = nextServer;

// Password reset emails, and what they were sent with.
const mail = vi.hoisted(() => ({
  resets: [] as { userId: string; email: string; token: string }[],
  throwWith: null as null | ((input: { email: string; token: string }) => Error),
  result: { ok: true } as { ok: boolean; error?: string; skipped?: boolean },
  payouts: [] as { partnerUserId: string; amountCents: number }[],
}));
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));

// The browser's cookies, for the real session code in auth.ts.
const browser = vi.hoisted(() => ({ jar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (browser.jar.has(name) ? { name, value: browser.jar.get(name) } : undefined),
    set: (name: string, value: string) => void browser.jar.set(name, value),
    delete: (name: string) => void browser.jar.delete(name),
  }),
  headers: async () => new Headers(),
}));

// What Stripe says about a login's own customer, as billing.ts asks it.
const stripe = vi.hoisted(() => ({
  asked: [] as string[],
  decision: { block: false, expireSessionIds: [] } as { block: boolean; message?: string; expireSessionIds?: string[] },
  down: false,
  open: [] as { id: string; customer: string }[],
  expired: [] as string[],
  // Subscriptions Stripe knows, by id, with their status there.
  subscriptions: new Map<string, string>(),
  retrieved: [] as string[],
  retrieveDown: false,
  // What a referred customer has paid, and account credits given.
  paidHistory: { revenueCents: 0, paidInvoices: 0, paidRenewals: 0 },
  credits: [] as { customerId: string; amountCents: number }[],
}));
vi.mock("@/lib/stripe/billing", () => ({
  checkoutDecisionFor: async (customerId: string) => {
    stripe.asked.push(customerId);
    if (stripe.down) throw new Error("An error occurred with our connection to Stripe.");
    return stripe.decision;
  },
  applyCustomerCredit: async (input: { customerId: string; amountCents: number }) => {
    stripe.credits.push({ customerId: input.customerId, amountCents: input.amountCents });
    return { id: `cbtxn_${stripe.credits.length}` };
  },
  findCreditByRewardId: async () => null,
  paidSubscriptionHistory: async () => stripe.paidHistory,
}));
vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    subscriptions: {
      retrieve: async (id: string) => {
        stripe.retrieved.push(id);
        if (stripe.retrieveDown) throw new Error("An error occurred with our connection to Stripe.");
        const status = stripe.subscriptions.get(id);
        if (!status) throw Object.assign(new Error(`No such subscription: '${id}'`), { code: "resource_missing" });
        return { id, status };
      },
    },
    checkout: {
      sessions: {
        list: async ({ customer }: { customer: string }) => ({ data: stripe.open.filter((s) => s.customer === customer) }),
        expire: async (id: string) => {
          stripe.expired.push(id);
        },
      },
    },
  }),
}));

const qbo = vi.hoisted(() => ({ reads: [] as string[] }));
vi.mock("@/lib/quickbooksSync", () => ({
  withAccessToken: async (connectionId: string) => {
    qbo.reads.push(connectionId);
    return {};
  },
}));
vi.mock("@/lib/quickbooks", () => ({ qboProfitAndLossForCustomer: async () => ({}) }));
vi.mock("@/lib/jobTypesServer", () => ({ getJobTypes: async () => [] }));
vi.mock("@/lib/intuitSignIn", () => ({
  readPendingIntuitIdentity: async () => ({ sub: "intuit-sub-1", connect: false }),
  clearPendingIntuitIdentity: async () => {},
}));
vi.mock("@/lib/email/lifecycle", () => ({
  sendEmailVerification: async () => ({ ok: true }),
  sendPasswordChanged: async () => ({ ok: true }),
  sendPartnerNewSignup: async () => ({ ok: true }),
  sendReferralSignup: async () => ({ ok: true }),
  sendPartnerPayoutRecorded: async (input: { partnerUserId: string; amountCents: number }) => {
    mail.payouts.push({ partnerUserId: input.partnerUserId, amountCents: input.amountCents });
    return { ok: true };
  },
  sendPasswordReset: async (input: { userId: string; email: string; token: string }) => {
    if (mail.throwWith) throw mail.throwWith(input);
    mail.resets.push({ userId: input.userId, email: input.email, token: input.token });
    return mail.result;
  },
}));
vi.mock("@/lib/email/client", () => ({ sendEmail: async () => ({ ok: true }) }));
vi.mock("@/lib/email/templates", () => ({ intuitLinkedEmail: () => ({ subject: "Linked", text: "Linked", html: "<p>Linked</p>" }) }));

import { createSession, hashPassword, verifyPassword } from "../auth";
import {
  acceptInvite,
  canSignInWith,
  createInvite,
  inviteAddressCantSignInMessage,
  OWN_PLAN_JOIN_MESSAGE,
  ownPlanStanding,
  UNUSABLE_INVITE_EMAIL_MESSAGE,
} from "../team";
import { completePasswordReset, hashToken } from "../passwordReset";
import { countPayingClients, getPartnerDashboardData, maybeGrantFreeFirmAccount, partnerPayout } from "../partners";
import {
  attributeReferral,
  CHECKED_AND_DISQUALIFIED_REASON,
  decideHeldReferral,
  HELD_FOR_CHECK_WHERE,
  getReferralHistory,
  getReferralSummary,
  isHeldForCheck,
  markReferralPaid,
  qualifyDueReferrals,
  retryPendingRewards,
  unprovenReferralNote,
  WITHOUT_CHECK_NOTE_WHERE,
} from "../referrals";
import { refusesCrossSiteChange } from "../sameOrigin";
import { PARTNER_FREE_ACCOUNT_THRESHOLD, TRIAL_DAYS } from "../plans";
import type { NextRequest as RouteRequest } from "next/server";
import { POST as login } from "../../app/api/auth/login/route";
import { POST as forgotPassword } from "../../app/api/auth/forgot-password/route";
import { POST as linkIntuit } from "../../app/api/auth/intuit/link/route";
import { POST as signup } from "../../app/api/auth/signup/route";
import { POST as resetPassword } from "../../app/api/auth/reset-password/route";
import { POST as acceptRoute } from "../../app/api/team/accept/route";
import { GET as jobsTemplate } from "../../app/api/jobs/template/route";
import { GET as categories } from "../../app/api/settings/categories/route";
import { GET as quickbooksCheck } from "../../app/api/jobs/[jobId]/quickbooks-check/route";
import { POST as decideReferralRoute } from "../../app/api/admin/referrals/route";
import { POST as markPaidRoute } from "../../app/api/admin/commissions/route";
import AdminPartnersPage from "../../app/dashboard/admin/partners/page";
import AdminReferralsPage from "../../app/dashboard/admin/referrals/page";
import AdminOverviewPage from "../../app/dashboard/admin/page";
import ReferralsPage from "../../app/dashboard/referrals/page";
import { AdminSection, StatGrid } from "../../components/dashboard/AdminTable";
import { MarkPaidButton } from "../../app/dashboard/admin/partners/PartnerAdminActions";
import { ReferralCheckActions } from "../../app/dashboard/admin/referrals/ReferralCheckActions";

const SRC = join(__dirname, "..", "..");
const flat = (rel: string) => readFileSync(join(SRC, rel), "utf8").replace(/\s+/g, " ");
const DAY = 86_400_000;
const NOW = new Date("2026-10-27T15:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const OWN_ACCOUNT_MESSAGE =
  "Your login has its own JobProfitAI account (a connected company, a paid plan or a team of its own), so it can't join another one. Ask to be invited at a different address, or email support and we'll help.";

function post(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  }) as unknown as RouteRequest;
}
const get = (path: string) => new NextRequest(`http://localhost${path}`) as unknown as RouteRequest;

beforeAll(() => {
  vi.stubEnv("AUTH_SECRET", "test-secret-for-audit-1027-billing-0123456789");
  vi.stubEnv("ADMIN_EMAILS", "");
});
afterAll(() => vi.unstubAllEnvs());

beforeEach(() => {
  const client: FakePrisma = createFakePrisma();
  client.loginAttempt = new FakeModel("loginAttempt", [], () => ({ createdAt: new Date() }));
  fake.client = client;
  browser.jar.clear();
  nextServer.afterTasks.length = 0;
  mail.resets = [];
  mail.throwWith = null;
  mail.result = { ok: true };
  stripe.asked = [];
  stripe.decision = { block: false, expireSessionIds: [] };
  stripe.down = false;
  stripe.open = [];
  stripe.expired = [];
  stripe.subscriptions = new Map();
  stripe.retrieved = [];
  stripe.retrieveDown = false;
  stripe.paidHistory = { revenueCents: 0, paidInvoices: 0, paidRenewals: 0 };
  stripe.credits = [];
  mail.payouts = [];
  qbo.reads = [];
});
afterEach(() => vi.restoreAllMocks());

async function seedOwner(subscription: Record<string, unknown> = {}) {
  await fake.client.user.create({
    data: { id: "owner", email: "owner@ortizbuilders.com", name: "Ana Ortiz", emailVerifiedAt: ago(60), sessionVersion: 0, passwordHash: "x" },
  });
  await fake.client.subscription.create({
    data: {
      userId: "owner",
      status: "active",
      plan: "profit_intelligence",
      stripeCustomerId: "cus_owner",
      stripeSubscriptionId: "sub_owner",
      trialEndsAt: ago(30),
      ...subscription,
    },
  });
}

// =============================================================================
describe("B2: a login that once paid and cancelled can accept an invitation", () => {
  async function invitePm(subscription: Record<string, unknown> | null) {
    await seedOwner();
    const invite = await createInvite("owner", "pm@ortizbuilders.com", NOW);
    if (!invite.ok) throw new Error(invite.error);
    await fake.client.user.create({ data: { id: "pm", email: "pm@ortizbuilders.com", emailVerifiedAt: ago(200), sessionVersion: 0 } });
    if (subscription) await fake.client.subscription.create({ data: { userId: "pm", ...subscription } });
    return invite.token;
  }

  it("joins a contractor whose own subscription was cancelled, after asking Stripe, and keeps the row", async () => {
    const token = await invitePm({ status: "canceled", stripeSubscriptionId: "sub_pm_old", stripeCustomerId: "cus_pm", canceledAt: ago(90) });
    stripe.open = [{ id: "cs_left_open", customer: "cus_pm" }];

    const result = await acceptInvite(token, "pm", NOW);

    expect(result).toEqual({ ok: true, ownerUserId: "owner" });
    expect(stripe.asked).toEqual(["cus_pm"]);
    // The history stays, and is how the webhook still finds this login.
    expect(await fake.client.subscription.findUnique({ where: { userId: "pm" } })).toMatchObject({
      status: "canceled",
      stripeSubscriptionId: "sub_pm_old",
      stripeCustomerId: "cus_pm",
    });
    // A checkout left open from resubscribing can't be paid now.
    expect(stripe.expired).toEqual(["cs_left_open"]);
    expect(await fake.client.teamMember.findFirst({ where: { memberUserId: "pm" } })).toMatchObject({ acceptedAt: NOW });
  });

  it("still refuses when Stripe says the cancelled login has just subscribed again", async () => {
    const token = await invitePm({ status: "canceled", stripeSubscriptionId: "sub_pm_old", stripeCustomerId: "cus_pm" });
    stripe.decision = { block: true, message: "already subscribed" };
    expect(await acceptInvite(token, "pm", NOW)).toEqual({ ok: false, error: OWN_PLAN_JOIN_MESSAGE, status: 409 });
    expect(await fake.client.teamMember.findFirst({ where: { memberUserId: "pm" } })).toBeNull();
  });

  it("says try again when Stripe can't be asked, rather than guessing", async () => {
    const token = await invitePm({ status: "incomplete_expired", stripeSubscriptionId: "sub_pm_old", stripeCustomerId: "cus_pm" });
    stripe.down = true;
    expect(await acceptInvite(token, "pm", NOW)).toMatchObject({ ok: false, status: 503 });
  });

  it.each(["active", "past_due", "unpaid", "trialing", "trial_expired"])(
    "refuses a login whose own subscription is stored as %s, without asking Stripe",
    async (status) => {
      const token = await invitePm({ status, stripeSubscriptionId: "sub_pm", stripeCustomerId: "cus_pm", trialEndsAt: ago(5) });
      expect(await acceptInvite(token, "pm", NOW)).toEqual({ ok: false, error: OWN_ACCOUNT_MESSAGE, status: 409 });
      expect(stripe.asked).toEqual([]);
    }
  );

  it("refuses one set to cancel at the end of the month: it still bills until then", async () => {
    const token = await invitePm({ status: "active", cancelAtPeriodEnd: true, stripeSubscriptionId: "sub_pm", stripeCustomerId: "cus_pm" });
    expect(await acceptInvite(token, "pm", NOW)).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses an uncertain one with no customer id", async () => {
    const token = await invitePm({ status: "paused", stripeSubscriptionId: "sub_pm" });
    expect(await acceptInvite(token, "pm", NOW)).toEqual({ ok: false, error: OWN_PLAN_JOIN_MESSAGE, status: 409 });
  });

  it("classifies what the stored row says", () => {
    expect(ownPlanStanding(null)).toBe("none");
    expect(ownPlanStanding({ stripeSubscriptionId: null, status: "trialing" })).toBe("none");
    expect(ownPlanStanding({ stripeSubscriptionId: "sub_1", status: "active" })).toBe("live");
    expect(ownPlanStanding({ stripeSubscriptionId: "sub_1", status: "trial_expired" })).toBe("live");
    expect(ownPlanStanding({ stripeSubscriptionId: "sub_1", status: "canceled" })).toBe("ended");
    expect(ownPlanStanding({ stripeSubscriptionId: "sub_1", status: "incomplete_expired" })).toBe("ended");
    expect(ownPlanStanding({ stripeSubscriptionId: "sub_1", status: "incomplete" })).toBe("uncertain");
    expect(ownPlanStanding({ stripeSubscriptionId: "sub_1", status: "something_new" })).toBe("uncertain");
  });
});

// =============================================================================
describe("B3: an address taken back by a password reset", () => {
  const TOKEN = "reset-token-for-the-real-owner-0001";

  /**
   * A partner signs up through their own link with a prospect's address,
   * 30 days ago. The prospect never confirmed it (they didn't sign up).
   */
  async function seedClaimed(opts: { verified?: boolean; subscription?: Record<string, unknown> } = {}) {
    await fake.client.user.create({ data: { id: "partner", email: "books@ledgerpros.com", emailVerifiedAt: ago(300), sessionVersion: 0 } });
    await fake.client.partner.create({ data: { id: "p1", userId: "partner", firmName: "Ledger Pros", contactName: "Lee", status: "approved" } });
    await fake.client.referralCode.create({ data: { id: "rc1", code: "LDGRPRS", kind: "partner", partnerId: "p1" } });
    await fake.client.user.create({
      data: {
        id: "acct",
        email: "sam@ortizbuilders.com",
        passwordHash: "x",
        sessionVersion: 0,
        emailVerifiedAt: opts.verified ? ago(29) : null,
        createdAt: ago(30),
      },
    });
    await fake.client.subscription.create({
      data: { userId: "acct", status: "trial_expired", trialStartedAt: ago(30), trialEndsAt: ago(16), ...opts.subscription },
    });
    const attributed = await attributeReferral("acct", "ldgrprs");
    if (!attributed.attributed) throw new Error(attributed.reason);
    await fake.client.passwordResetToken.create({
      data: { userId: "acct", tokenHash: hashToken(TOKEN), expiresAt: new Date(NOW.getTime() + 30 * 60_000), createdAt: ago(0) },
    });
    return attributed.referral;
  }
  const referral = () => fake.client.referral.findUnique({ where: { referredUserId: "acct" } });
  const subscription = () => fake.client.subscription.findUnique({ where: { userId: "acct" } });

  it("flags the referral for a person and starts the trial again from the day of the reset", async () => {
    await seedClaimed();
    expect((await completePasswordReset(TOKEN, "the-real-owners-password", NOW)).ok).toBe(true);

    // Nothing about the referral changes but the note (see "review: B3").
    expect(await referral()).toMatchObject({ status: "signed_up", disqualifiedAt: null, disqualifiedReason: unprovenReferralNote(NOW) });
    expect(await subscription()).toMatchObject({
      status: "trialing",
      trialStartedAt: NOW,
      trialEndsAt: new Date(NOW.getTime() + TRIAL_DAYS * DAY),
    });
    expect((await fake.client.user.findUnique({ where: { id: "acct" } })).emailVerifiedAt).toEqual(NOW);
    // A payment still moves it on; the note stays for whoever checks payouts.
    expect(await markReferralPaid("acct", NOW)).toMatchObject({ status: "paid", firstPaidAt: NOW, disqualifiedReason: unprovenReferralNote(NOW) });
  });

  it("still counts the restarted trial as the partner's client: the referral wasn't changed", async () => {
    await seedClaimed();
    await completePasswordReset(TOKEN, "the-real-owners-password", NOW);
    expect(await subscription()).toMatchObject({ status: "trialing" });
    expect((await getPartnerDashboardData("p1")).trialingClients).toBe(1);
  });

  it("doesn't count a disqualified referral's trial as the partner's client", async () => {
    await seedClaimed({ verified: true, subscription: { status: "trialing", trialEndsAt: new Date(NOW.getTime() + DAY) } });
    expect((await getPartnerDashboardData("p1")).trialingClients).toBe(1);
    await fake.client.referral.update({ where: { referredUserId: "acct" }, data: { status: "disqualified" } });
    expect((await getPartnerDashboardData("p1")).trialingClients).toBe(0);
  });

  it("changes nothing for an account whose address was already proven", async () => {
    await seedClaimed({ verified: true });
    expect((await completePasswordReset(TOKEN, "a-forgotten-password", NOW)).ok).toBe(true);
    expect(await referral()).toMatchObject({ status: "signed_up", disqualifiedAt: null, disqualifiedReason: null });
    expect(await subscription()).toMatchObject({ status: "trial_expired", trialStartedAt: ago(30), trialEndsAt: ago(16) });
  });

  it("flags a referral that commission was earned on too, without touching the commission", async () => {
    const ref = await seedClaimed();
    await fake.client.partnerCommission.create({
      data: { partnerId: "p1", referralId: ref.id, referredUserId: "acct", stripeInvoiceId: "in_1", subscriptionRevenueCents: 14900, commissionRateBps: 2000, commissionCents: 2980, monthNumber: 1 },
    });
    await completePasswordReset(TOKEN, "the-real-owners-password", NOW);
    expect(await referral()).toMatchObject({ status: "signed_up", disqualifiedReason: unprovenReferralNote(NOW) });
    expect(await fake.client.partnerCommission.findFirst({ where: { referralId: ref.id } })).toMatchObject({ status: "earned" });
  });

  it("flags a customer referral with a reward, without touching the reward", async () => {
    const ref = await seedClaimed();
    await fake.client.referral.update({ where: { id: ref.id }, data: { kind: "customer", partnerId: null, referrerUserId: "partner" } });
    await fake.client.referralReward.create({ data: { referralId: ref.id, referrerUserId: "partner", amountCents: 14900, plan: "profit_intelligence" } });
    await completePasswordReset(TOKEN, "the-real-owners-password", NOW);
    expect(await referral()).toMatchObject({ status: "signed_up", disqualifiedReason: unprovenReferralNote(NOW) });
    expect(await fake.client.referralReward.findFirst({ where: { referralId: ref.id } })).toMatchObject({ status: "pending" });
  });

  it("doesn't restart a trial that connected a QuickBooks company, even one disconnected since", async () => {
    await seedClaimed();
    await fake.client.quickBooksConnection.create({ data: { userId: "acct", realmIdHash: "r1", disconnectedAt: ago(10) } });
    await completePasswordReset(TOKEN, "the-real-owners-password", NOW);
    expect(await subscription()).toMatchObject({ status: "trial_expired", trialEndsAt: ago(16) });
    // The referral is still flagged.
    expect(await referral()).toMatchObject({ status: "signed_up", disqualifiedReason: unprovenReferralNote(NOW) });
  });

  it("doesn't restart one recorded as having connected QuickBooks", async () => {
    await seedClaimed({ subscription: { quickbooksConnectedAt: ago(25) } });
    await completePasswordReset(TOKEN, "the-real-owners-password", NOW);
    expect(await subscription()).toMatchObject({ status: "trial_expired", trialEndsAt: ago(16) });
  });

  it("doesn't touch a Stripe subscription or a no-plan login", async () => {
    await seedClaimed({ subscription: { status: "canceled", stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" } });
    await completePasswordReset(TOKEN, "the-real-owners-password", NOW);
    expect(await subscription()).toMatchObject({ status: "canceled", trialEndsAt: ago(16) });

    fake.client = createFakePrisma();
    await seedClaimed({ subscription: { status: "none", trialEndsAt: null } });
    await completePasswordReset(TOKEN, "the-real-owners-password", NOW);
    expect(await subscription()).toMatchObject({ status: "none", trialEndsAt: null });
  });
});

// =============================================================================
describe("B7: an unknown address takes as long to refuse as a wrong password", () => {
  // Typed by what it reads, so a spy on bcrypt.compare fits Vitest's own types.
  const roundsChecked = (spy: { mock: { calls: readonly (readonly unknown[])[] } }) =>
    spy.mock.calls.map((c) => bcrypt.getRounds(c[1] as string));

  it("checks a password against a stand-in hash at the same cost as real ones", async () => {
    const compare = vi.spyOn(bcrypt, "compare");
    expect(await verifyPassword("anything-at-all", null)).toBe(false);
    expect(bcrypt.getRounds(await hashPassword("a-real-password"))).toBe(12);
    expect(roundsChecked(compare)).toEqual([12]);
  });

  it("login does the check for an address with no account", async () => {
    const compare = vi.spyOn(bcrypt, "compare");
    const res = await login(post("/api/auth/login", { email: "nobody@ortizbuilders.com", password: "guess-123" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Incorrect email or password." });
    expect(roundsChecked(compare)).toEqual([12]);
  });

  it("login still checks a real account's own hash, and signs in", async () => {
    await fake.client.user.create({
      data: { id: "u1", email: "sam@ortizbuilders.com", passwordHash: bcrypt.hashSync("right-password", 4), sessionVersion: 0 },
    });
    const compare = vi.spyOn(bcrypt, "compare");
    expect((await login(post("/api/auth/login", { email: "sam@ortizbuilders.com", password: "wrong" }))).status).toBe(401);
    expect((await login(post("/api/auth/login", { email: "sam@ortizbuilders.com", password: "right-password" }))).status).toBe(200);
    expect(roundsChecked(compare)).toEqual([4, 4]);
  });

  it("the Sign in with Intuit link form does the check for an address with no account", async () => {
    const compare = vi.spyOn(bcrypt, "compare");
    const res = await linkIntuit(post("/api/auth/intuit/link", { email: "nobody@ortizbuilders.com", password: "guess-123" }));
    expect(res.status).toBe(401);
    expect(roundsChecked(compare)).toEqual([12]);
    expect(flat("app/api/auth/intuit/link/route.ts")).toContain("await finishLoginAttempt(attempt.attemptId, valid);");
  });
});

// =============================================================================
describe("B9: lapsed accounts and paused companies", () => {
  async function seedCompanies() {
    await fake.client.quickBooksConnection.create({
      data: { id: "c1", userId: "owner", realmIdHash: "r1", companyName: "Ortiz Builders", connectedAt: ago(200) },
    });
    // Connected second, past the 1 company Profit Intelligence covers.
    await fake.client.quickBooksConnection.create({
      data: { id: "c2", userId: "owner", realmIdHash: "r2", companyName: "Ortiz Remodeling", connectedAt: ago(20) },
    });
    for (const [id, connectionId] of [["j1", "c1"], ["j2", "c2"]]) {
      await fake.client.job.create({ data: { id, connectionId, qboId: `${id}-qbo`, name: `Job ${id}`, missingSince: null } });
    }
    // The route reads the job with its company (`include`), which the
    // in-memory database leaves to the caller.
    const jobs = fake.client.job as FakeModel;
    const plain = jobs.findUnique.bind(jobs);
    (jobs as any).findUnique = async (args: any) => {
      const job = await plain({ where: args.where });
      if (!job || !args.include?.connection) return job;
      return { ...job, connection: await fake.client.quickBooksConnection.findUnique({ where: { id: job.connectionId } }) };
    };
    fake.client.invoiceSummary = { aggregate: async () => ({ _sum: { amount: 0 } }) };
    fake.client.costEntry = { groupBy: async () => [] };
    fake.client.categoryMapping = new FakeModel("categoryMapping");
    fake.client.jobEstimate = new FakeModel("jobEstimate");
  }
  const lapsed = { status: "trial_expired", stripeSubscriptionId: null, stripeCustomerId: null, trialEndsAt: ago(3) };
  const check = (jobId: string) => quickbooksCheck(get(`/api/jobs/${jobId}/quickbooks-check`), { params: Promise.resolve({ jobId }) });

  it("the job budgets spreadsheet needs a live trial or plan", async () => {
    await seedOwner(lapsed);
    await seedCompanies();
    await createSession("owner");
    const res = await jobsTemplate(get("/api/jobs/template?connectionId=c1&all=1"));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "Your JobProfitAI trial has ended. Choose a plan to continue." });
  });

  it("and still downloads for a paying account", async () => {
    await seedOwner();
    await seedCompanies();
    await createSession("owner");
    const res = await jobsTemplate(get("/api/jobs/template?connectionId=c1&all=1"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Job j1");
  });

  it("the cost categories list needs a live trial or plan", async () => {
    await seedOwner({ status: "canceled", canceledAt: ago(40) });
    await seedCompanies();
    await createSession("owner");
    const res = await categories(get("/api/settings/categories?connectionId=c1"));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "Your subscription isn't active. Choose a plan on the Billing page to continue." });

    await fake.client.subscription.update({ where: { userId: "owner" }, data: { status: "active" } });
    expect((await categories(get("/api/settings/categories?connectionId=c1"))).status).toBe(200);
  });

  it("the QuickBooks check says why a lapsed account can't use it", async () => {
    await seedOwner(lapsed);
    await seedCompanies();
    await createSession("owner");
    const res = await check("j1");
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("Your JobProfitAI trial has ended. Choose a plan to continue.");
    expect(qbo.reads).toEqual([]);
  });

  it("the QuickBooks check doesn't read QuickBooks for a company paused past the plan's limit", async () => {
    await seedOwner();
    await seedCompanies();
    await createSession("owner");
    const res = await check("j2");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("company_paused");
    expect(body.error).toContain("Your plan covers 1 QuickBooks company. Ortiz Remodeling is paused");
    expect(qbo.reads).toEqual([]);

    // The company the plan covers is still checked.
    await check("j1");
    expect(qbo.reads).toEqual(["c1"]);
  });
});

// =============================================================================
describe("Z2: a password over 200 characters gets our own words", () => {
  const long = "x".repeat(201);
  const MESSAGE = "Passwords can be at most 200 characters.";

  it("at signup, where the form shows the password's first message", async () => {
    const res = await signup(post("/api/auth/signup", { email: "sam@ortizbuilders.com", password: long, acceptTerms: true }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.fieldErrors.password).toEqual([MESSAGE]);
  });

  it("when accepting an invitation with a new login", async () => {
    const res = await acceptRoute(post("/api/team/accept", { token: "t".repeat(43), password: long }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: MESSAGE });
    // The other rules there are in plain words too.
    const badLink = await acceptRoute(post("/api/team/accept", { token: "short", password: "long-enough-1" }));
    expect((await badLink.json()).error).toBe("This invitation link doesn't look right. Open it again from the email.");
    const longName = await acceptRoute(post("/api/team/accept", { token: "t".repeat(43), name: "n".repeat(121), password: "long-enough-1" }));
    expect((await longName.json()).error).toBe("Names can be at most 120 characters.");
  });

  it("when resetting, instead of calling the link wrong", async () => {
    const res = await resetPassword(post("/api/auth/reset-password", { token: "t".repeat(43), password: long }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: MESSAGE });
    const short = await resetPassword(post("/api/auth/reset-password", { token: "t".repeat(43), password: "short" }));
    expect(await short.json()).toEqual({ error: "Choose a password of at least 8 characters." });
  });

  it("and the password boxes stop at 200", () => {
    expect(flat("app/signup/SignupForm.tsx")).toContain('minLength={8} maxLength={200} autoComplete="new-password"');
    expect(flat("app/invite/[token]/AcceptInviteForm.tsx")).toContain("minLength={8} maxLength={200} value={password}");
    const reset = flat("app/reset-password/ResetPasswordForm.tsx");
    expect(reset).toContain("minLength={8} maxLength={200} value={password}");
    expect(reset).toContain("maxLength={200} value={confirm}");
  });
});

// =============================================================================
describe("Z3: nobody is invited at an address they couldn't sign in with", () => {
  it.each(["sam&co@ortizbuilders.com", "josé@ortizbuilders.com", "first..last@ortizbuilders.com", "sam@ortiz_builders.com"])(
    "refuses %s at invite time, saying why",
    async (address) => {
      await seedOwner();
      expect(await createInvite("owner", address, NOW)).toEqual({ ok: false, error: UNUSABLE_INVITE_EMAIL_MESSAGE, status: 400 });
      expect(await fake.client.teamMember.count()).toBe(0);
    }
  );

  it("still calls a typo a typo", async () => {
    await seedOwner();
    expect(await createInvite("owner", "sam.ortizbuilders.com", NOW)).toMatchObject({ error: "Enter a valid email address." });
  });

  it("invites ordinary addresses, which then sign in", async () => {
    await seedOwner();
    for (const address of ["o'neil@ortizbuilders.com", "  Sam.Ortiz+Jobs@OrtizBuilders.com "]) {
      const invite = await createInvite("owner", address, NOW);
      expect(invite.ok).toBe(true);
      if (!invite.ok) continue;
      await fake.client.user.create({ data: { email: invite.email, passwordHash: bcrypt.hashSync("right-password", 4), sessionVersion: 0 } });
      expect((await login(post("/api/auth/login", { email: invite.email, password: "right-password" }))).status).toBe(200);
    }
  });

  it("login answers an address it can't accept in plain words, not \"Invalid input.\"", async () => {
    const compare = vi.spyOn(bcrypt, "compare");
    const res = await login(post("/api/auth/login", { email: "sam&co@ortizbuilders.com", password: "right-password" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Incorrect email or password." });
    // Nothing was looked up, so there is nothing to time.
    expect((compare as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });
});

// =============================================================================
// Follow-ups from the independent review of the fixes above.
// =============================================================================

describe("review: B3, a reset flags the referral for a person and changes nothing about it", () => {
  const TOKEN = "reset-token-for-an-honest-customer-01";

  /** A contractor who signed up through a referral link 3 days ago and never clicked the verification email. */
  async function seedReferred(opts: { kind: "partner" | "customer"; subscription?: Record<string, unknown>; referral?: Record<string, unknown> }) {
    await fake.client.user.create({ data: { id: "ref", email: "books@ledgerpros.com", emailVerifiedAt: ago(300), sessionVersion: 0 } });
    if (opts.kind === "partner") {
      await fake.client.partner.create({ data: { id: "p1", userId: "ref", firmName: "Ledger Pros", contactName: "Lee", status: "approved" } });
      await fake.client.referralCode.create({ data: { id: "rc1", code: "LDGRPRS", kind: "partner", partnerId: "p1" } });
    } else {
      await fake.client.referralCode.create({ data: { id: "rc1", code: "LDGRPRS", kind: "customer", userId: "ref" } });
    }
    await fake.client.user.create({
      data: { id: "acct", email: "sam@ortizbuilders.com", passwordHash: "x", sessionVersion: 0, emailVerifiedAt: null, createdAt: ago(3) },
    });
    await fake.client.subscription.create({
      data: { userId: "acct", status: "trialing", trialStartedAt: ago(3), trialEndsAt: new Date(NOW.getTime() + 11 * DAY), ...opts.subscription },
    });
    const attributed = await attributeReferral("acct", "ldgrprs");
    if (!attributed.attributed) throw new Error(attributed.reason);
    if (opts.referral) await fake.client.referral.update({ where: { id: attributed.referral.id }, data: opts.referral });
    await fake.client.passwordResetToken.create({
      data: { userId: "acct", tokenHash: hashToken(TOKEN), expiresAt: new Date(NOW.getTime() + 30 * 60_000), createdAt: ago(0) },
    });
  }
  const referral = () => fake.client.referral.findUnique({ where: { referredUserId: "acct" } });

  it("keeps the partner's referral for an honest customer who connected QuickBooks, then forgot the password before verifying", async () => {
    await seedReferred({ kind: "partner", subscription: { quickbooksConnectedAt: ago(2) } });
    await fake.client.quickBooksConnection.create({ data: { userId: "acct", realmIdHash: "r1" } });
    expect((await completePasswordReset(TOKEN, "my-new-password", NOW)).ok).toBe(true);
    expect(await referral()).toMatchObject({ status: "signed_up", disqualifiedAt: null, disqualifiedReason: unprovenReferralNote(NOW) });
    // The trial they're using carries on as it was.
    expect(await fake.client.subscription.findUnique({ where: { userId: "acct" } })).toMatchObject({ trialStartedAt: ago(3) });
  });

  it("leaves a customer referral that has already paid as paid", async () => {
    await seedReferred({
      kind: "customer",
      subscription: { status: "active", stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1", firstPaidAt: ago(2) },
      referral: { status: "paid", firstPaidAt: ago(2) },
    });
    await completePasswordReset(TOKEN, "my-new-password", NOW);
    expect(await referral()).toMatchObject({ status: "paid", firstPaidAt: ago(2), disqualifiedAt: null, disqualifiedReason: unprovenReferralNote(NOW) });
  });

  it("says plainly that the referral is not disqualified and needs checking before any payout", () => {
    const note = unprovenReferralNote(NOW);
    expect(note).toBe(
      "Check by hand before paying: this account's email address was first proven by a password reset on Oct 27, 2026, so whoever signed up through this link may not have owned it. Nothing was changed."
    );
    expect(/[\u2013\u2014]/.test(note)).toBe(false);
  });

  it("keeps a reason already written", async () => {
    await seedReferred({ kind: "partner", referral: { disqualifiedReason: "Support: confirmed with the firm by phone." } });
    await completePasswordReset(TOKEN, "my-new-password", NOW);
    expect(await referral()).toMatchObject({ status: "signed_up", disqualifiedReason: "Support: confirmed with the firm by phone." });
  });

  it("leaves a disqualified referral and its reason alone", async () => {
    await seedReferred({ kind: "customer", referral: { status: "disqualified", disqualifiedAt: ago(1), disqualifiedReason: "Refunded in full." } });
    await completePasswordReset(TOKEN, "my-new-password", NOW);
    expect(await referral()).toMatchObject({ status: "disqualified", disqualifiedReason: "Refunded in full." });
  });

  it("known limit: an address first proven by the signup's verification link leaves no flag", async () => {
    await seedReferred({ kind: "partner" });
    await fake.client.user.update({ where: { id: "acct" }, data: { emailVerifiedAt: ago(1) } });
    await completePasswordReset(TOKEN, "my-new-password", NOW);
    expect(await referral()).toMatchObject({ status: "signed_up", disqualifiedReason: null });
  });
});

describe("review: B7, forgot-password replies before anything depends on the address", () => {
  const ask = (email: string) => forgotPassword(post("/api/auth/forgot-password", { email }));
  const seedSam = () =>
    fake.client.user.create({ data: { id: "u1", email: "sam@ortizbuilders.com", passwordHash: "x", sessionVersion: 0 } });

  it("answers an address with an account and one without the same way, having looked nothing up", async () => {
    await seedSam();
    const lookups = vi.spyOn(fake.client.user, "findUnique");
    const known = await ask("sam@ortizbuilders.com");
    const unknown = await ask("nobody@ortizbuilders.com");
    expect([known.status, unknown.status]).toEqual([200, 200]);
    expect(await known.json()).toEqual(await unknown.json());
    // The lookup, the reset and the email all wait until the reply has gone.
    expect(lookups.mock.calls).toHaveLength(0);
    expect(await fake.client.passwordResetToken.count()).toBe(0);
    expect(mail.resets).toEqual([]);
    expect(nextServer.afterTasks).toHaveLength(2);

    await nextServer.runAfterTasks();
    expect(mail.resets.map((r) => r.userId)).toEqual(["u1"]);
    expect(await fake.client.passwordResetToken.count({ where: { userId: "u1" } })).toBe(1);
  });

  it("still says a malformed address is malformed, and leaves nothing to run", async () => {
    const res = await ask("not-an-address");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Enter a valid email address." });
    expect(nextServer.afterTasks).toHaveLength(0);
  });

  it("catches a failure after the reply and logs it without the address or the link", async () => {
    await seedSam();
    let token = "";
    mail.throwWith = (input) => {
      token = input.token;
      return new Error(`Resend refused ${input.email}: https://jobprofitai.com/reset-password?token=${input.token}`);
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await ask("sam@ortizbuilders.com")).status).toBe(200);
    await nextServer.runAfterTasks();
    const text = logged.mock.calls.flat().join(" ");
    expect(token.length).toBeGreaterThan(20);
    expect(text).toContain("forgot-password");
    expect(text).not.toContain("sam@ortizbuilders.com");
    expect(text).not.toContain(token);
  });

  it("logs a refused send without the address", async () => {
    await seedSam();
    mail.result = { ok: false, error: "Invalid `to` field: sam@ortizbuilders.com" };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await ask("sam@ortizbuilders.com");
    await nextServer.runAfterTasks();
    const text = logged.mock.calls.flat().join(" ");
    expect(text).toContain("password reset email failed for user u1");
    expect(text).not.toContain("sam@ortizbuilders.com");
  });
});

describe("review: B2, a subscription that may still start billing refuses the join", () => {
  async function invitePm(subscription: Record<string, unknown>) {
    await seedOwner();
    const invite = await createInvite("owner", "pm@ortizbuilders.com", NOW);
    if (!invite.ok) throw new Error(invite.error);
    await fake.client.user.create({ data: { id: "pm", email: "pm@ortizbuilders.com", emailVerifiedAt: ago(200), sessionVersion: 0 } });
    await fake.client.subscription.create({ data: { userId: "pm", stripeSubscriptionId: "sub_pm", stripeCustomerId: "cus_pm", ...subscription } });
    return invite.token;
  }

  it.each(["paused", "incomplete"])("refuses a stored %s one that hasn't ended in Stripe either, even with nothing live on the customer", async (status) => {
    const token = await invitePm({ status });
    stripe.subscriptions.set("sub_pm", status);
    stripe.decision = { block: false, expireSessionIds: [] };
    expect(await acceptInvite(token, "pm", NOW)).toEqual({ ok: false, error: OWN_PLAN_JOIN_MESSAGE, status: 409 });
    expect(stripe.retrieved).toEqual(["sub_pm"]);
    expect(stripe.asked).toEqual([]);
    expect(await fake.client.teamMember.findFirst({ where: { memberUserId: "pm" } })).toBeNull();
  });

  it("lets the person join once it has ended", async () => {
    const token = await invitePm({ status: "incomplete_expired" });
    expect((await acceptInvite(token, "pm", NOW)).ok).toBe(true);
    expect(stripe.asked).toEqual(["cus_pm"]);
  });
});

describe("review: Z2, every signup field in plain words", () => {
  const signUp = (fields: Record<string, unknown>) =>
    signup(post("/api/auth/signup", { email: "sam@ortizbuilders.com", password: "long-enough-1", acceptTerms: true, ...fields }));

  it("a name over 120 characters", async () => {
    const res = await signUp({ name: "n".repeat(121) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.fieldErrors).toEqual({ name: ["Names can be at most 120 characters."] });
  });

  it("an address over 320 characters, or one that isn't an address", async () => {
    const long = await signUp({ email: `${"s".repeat(310)}@ortizbuilders.com` });
    expect((await long.json()).error.fieldErrors.email).toEqual(["Email addresses can be at most 320 characters."]);
    const bad = await signUp({ email: "sam&co@ortizbuilders.com" });
    expect((await bad.json()).error.fieldErrors.email).toEqual(["Enter a valid email address."]);
  });

  it("the form shows any field's message, and its boxes stop at the limits", () => {
    const form = flat("app/signup/SignupForm.tsx");
    expect(form).toContain("Object.values(fieldErrors).find((errors) => errors?.[0])?.[0]");
    expect(form).toContain('autoComplete="name" maxLength={120} value={name}');
    expect(form).toContain('autoComplete="email" maxLength={320} value={email}');
  });
});

describe("review: Z3, an invitation sent before the address check can't be accepted", () => {
  const TOKEN = "an-older-invitation-token-000000000001";
  async function seedOldInvite(email: string) {
    await seedOwner();
    await fake.client.teamMember.create({
      data: { ownerUserId: "owner", email, tokenHash: hashToken(TOKEN), invitedAt: ago(1), expiresAt: new Date(NOW.getTime() + 6 * DAY), role: "member" },
    });
  }
  const ADDRESS = "sam&co@ortizbuilders.com";
  const MESSAGE = inviteAddressCantSignInMessage({ email: ADDRESS, ownerName: "Ana Ortiz", ownerEmail: "owner@ortizbuilders.com" });

  it("asks the owner for a different address, in plain words", () => {
    expect(canSignInWith(ADDRESS)).toBe(false);
    expect(MESSAGE).toBe(
      "This invitation is for sam&co@ortizbuilders.com, an address JobProfitAI can't sign in with (addresses with characters such as & or accented letters don't work), so accepting it would leave you locked out. Ask Ana Ortiz to invite you at a different address."
    );
  });

  it("refuses a new login before making it", async () => {
    await seedOldInvite(ADDRESS);
    const res = await acceptRoute(post("/api/team/accept", { token: TOKEN, password: "long-enough-1" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: MESSAGE });
    expect(await fake.client.user.count()).toBe(1);
    expect(browser.jar.size).toBe(0);
  });

  it("refuses a signed-in login with that address", async () => {
    await seedOldInvite(ADDRESS);
    await fake.client.user.create({ data: { id: "sam", email: ADDRESS, passwordHash: "x", sessionVersion: 0 } });
    await createSession("sam");
    const res = await acceptRoute(post("/api/team/accept", { token: TOKEN }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: MESSAGE });
    expect(await fake.client.teamMember.findFirst({ where: { email: ADDRESS } })).toMatchObject({ acceptedAt: null, memberUserId: null });
  });

  it("still accepts an older invitation at an ordinary address", async () => {
    await seedOldInvite("sam@ortizbuilders.com");
    const res = await acceptRoute(post("/api/team/accept", { token: TOKEN, password: "long-enough-1" }));
    expect(res.status).toBe(200);
    expect(await fake.client.teamMember.findFirst({ where: { email: "sam@ortizbuilders.com" } })).toMatchObject({ acceptedAt: expect.anything() });
  });
});

describe("review: the B3 note shows where partner payouts are made", () => {
  it("starts every note with the words the partners page looks for", async () => {
    const { unprovenReferralNote, UNPROVEN_REFERRAL_NOTE_START } = await import("../referrals");
    expect(unprovenReferralNote(new Date("2026-10-27T15:00:00Z")).startsWith(UNPROVEN_REFERRAL_NOTE_START)).toBe(true);
  });

  it("lists flagged referrals beside the Mark paid button", () => {
    const page = readFileSync(join(process.cwd(), "src/app/dashboard/admin/partners/page.tsx"), "utf8");
    expect(page).toContain("disqualifiedReason: { startsWith: UNPROVEN_REFERRAL_NOTE_START }");
    expect(page).toContain("to check before paying");
  });
});

// =============================================================================
// Third round: the flag holds payouts until a person decides.
// =============================================================================

/** Props of every element of `type` in a rendered tree (server components are not expanded). */
function propsOf(node: unknown, type: unknown): Record<string, any>[] {
  const found: Record<string, any>[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object" && "props" in n) {
      const el = n as { type: unknown; props: Record<string, any> };
      if (el.type === type) found.push(el.props);
      walk(el.props?.children);
    }
  };
  walk(node);
  return found;
}

/** All the text in a rendered tree, in order. */
function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) return textOf((node as { props: { children?: unknown } }).props.children);
  return "";
}

const ADMIN_EMAIL = "admin@jobprofitai.com";
const CHANGED_MESSAGE =
  "Some of this commission can't be paid now: since the page was loaded, a referral was flagged for a check or disqualified, or a commission was voided. Nothing was recorded. Refresh the page and pay the amount it shows.";
/** The day the route runs (it uses the real clock), as REVIEW notes write it. */
const NOW_DAY = () => new Date().toISOString().slice(0, 10);
async function signInAsAdmin() {
  await fake.client.user.create({ data: { id: "admin", email: ADMIN_EMAIL, emailVerifiedAt: ago(100), sessionVersion: 0 } });
  await createSession("admin");
}
async function signInAsCustomer() {
  await fake.client.user.create({ data: { id: "someone", email: "someone@ortizbuilders.com", emailVerifiedAt: ago(100), sessionVersion: 0 } });
  await createSession("someone");
}

describe("review: B3 hold, a customer referral flagged for a check earns no reward until cleared", () => {
  /** A referred customer paying 40 days, through a referrer on Profit Intelligence. */
  async function seedPaidCustomerReferral(note: string | null) {
    await fake.client.user.create({ data: { id: "ref", email: "ana@ortizbuilders.com", emailVerifiedAt: ago(300), sessionVersion: 0 } });
    await fake.client.subscription.create({
      data: { userId: "ref", status: "active", plan: "profit_intelligence", stripeCustomerId: "cus_ref", stripeSubscriptionId: "sub_ref" },
    });
    await fake.client.referralCode.create({ data: { id: "rc1", code: "ANAORTZ", kind: "customer", userId: "ref" } });
    await fake.client.user.create({ data: { id: "acct", email: "sam@ortizbuilders.com", emailVerifiedAt: ago(5), sessionVersion: 0 } });
    await fake.client.subscription.create({
      data: { userId: "acct", status: "active", stripeCustomerId: "cus_acct", stripeSubscriptionId: "sub_acct", firstPaidAt: ago(40) },
    });
    await fake.client.referral.create({
      data: { id: "r1", referralCodeId: "rc1", kind: "customer", referrerUserId: "ref", referredUserId: "acct", status: "paid", firstPaidAt: ago(40), disqualifiedReason: note },
    });
    // Two months paid, the second a renewal: a reward is due.
    stripe.paidHistory = { revenueCents: 29800, paidInvoices: 2, paidRenewals: 1 };
  }
  const referral = () => fake.client.referral.findUnique({ where: { id: "r1" } });

  it("makes no reward and gives no credit while flagged, then qualifies once cleared", async () => {
    await seedPaidCustomerReferral(unprovenReferralNote(ago(5)));
    expect(await qualifyDueReferrals(NOW)).toEqual([]);
    expect(await fake.client.referralReward.count()).toBe(0);
    expect(stripe.credits).toEqual([]);
    expect(await referral()).toMatchObject({ status: "paid", qualifiedAt: null });

    expect(await decideHeldReferral("r1", "clear", NOW)).toEqual({ ok: true, decision: "cleared" });
    expect(await referral()).toMatchObject({ status: "paid", disqualifiedReason: null });
    const results = await qualifyDueReferrals(NOW);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ referralId: "r1", creditApplied: true });
    expect(stripe.credits).toEqual([{ customerId: "cus_ref", amountCents: results[0].amountCents }]);
  });

  it("still qualifies a referral whose note isn't a check (a support note, say)", async () => {
    await seedPaidCustomerReferral("Support: the customer called to say thanks.");
    expect(await qualifyDueReferrals(NOW)).toHaveLength(1);
  });

  it("holds the credit for a reward made before the flag, and gives it once cleared", async () => {
    await seedPaidCustomerReferral(unprovenReferralNote(ago(1)));
    await fake.client.referralReward.create({ data: { id: "rw1", referralId: "r1", referrerUserId: "ref", amountCents: 14900, plan: "profit_intelligence" } });
    expect(await retryPendingRewards()).toBe(0);
    expect(stripe.credits).toEqual([]);
    await decideHeldReferral("r1", "clear", NOW);
    expect(await retryPendingRewards()).toBe(1);
    expect(stripe.credits).toEqual([{ customerId: "cus_ref", amountCents: 14900 }]);
  });

  it("disqualifies by the usual path when a person decides so, voiding the reward", async () => {
    await seedPaidCustomerReferral(unprovenReferralNote(ago(1)));
    await fake.client.referralReward.create({ data: { id: "rw1", referralId: "r1", referrerUserId: "ref", amountCents: 14900, plan: "profit_intelligence" } });
    expect(await decideHeldReferral("r1", "disqualify", NOW)).toEqual({ ok: true, decision: "disqualified" });
    expect(await referral()).toMatchObject({ status: "disqualified", disqualifiedAt: NOW, disqualifiedReason: CHECKED_AND_DISQUALIFIED_REASON });
    expect(await fake.client.referralReward.findUnique({ where: { id: "rw1" } })).toMatchObject({ status: "voided", voidReason: CHECKED_AND_DISQUALIFIED_REASON });
    expect(await qualifyDueReferrals(NOW)).toEqual([]);
    expect(await retryPendingRewards()).toBe(0);
    expect(/[\u2013\u2014]/.test(CHECKED_AND_DISQUALIFIED_REASON)).toBe(false);
  });

  it("only decides a referral that is waiting for a check", async () => {
    await seedPaidCustomerReferral(null);
    expect(await decideHeldReferral("r1", "clear", NOW)).toMatchObject({ ok: false, status: 409 });
    expect(await decideHeldReferral("r1", "disqualify", NOW)).toMatchObject({ ok: false, status: 409 });
    expect(await referral()).toMatchObject({ status: "paid", disqualifiedReason: null });
    expect(await decideHeldReferral("nope", "clear", NOW)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("review: B3 hold, a partner referral flagged for a check is left out of Owed and Mark paid", () => {
  /**
   * Ledger Pros referred two clients. Sam's address was first proven by a
   * password reset (held); Jo's referral is ordinary. Each has earned commission.
   */
  async function seedPartner() {
    await fake.client.user.create({ data: { id: "puser", email: "books@ledgerpros.com", emailVerifiedAt: ago(300), sessionVersion: 0 } });
    await fake.client.partner.create({ data: { id: "p1", userId: "puser", firmName: "Ledger Pros", contactName: "Lee", status: "approved", createdAt: ago(300) } });
    await fake.client.referralCode.create({ data: { id: "rc1", code: "LDGRPRS", kind: "partner", partnerId: "p1" } });
    for (const [id, userId, email, note] of [
      ["held", "sam", "sam@ortizbuilders.com", unprovenReferralNote(ago(3))],
      ["plain", "jo", "jo@kimroofing.com", null],
    ] as const) {
      await fake.client.user.create({ data: { id: userId, email, emailVerifiedAt: ago(3), sessionVersion: 0 } });
      await fake.client.referral.create({
        data: { id, referralCodeId: "rc1", kind: "partner", partnerId: "p1", referredUserId: userId, status: "paid", firstPaidAt: ago(20), disqualifiedReason: note },
      });
    }
    const commission = (id: string, referralId: string, referredUserId: string, cents: number) =>
      fake.client.partnerCommission.create({
        data: { id, partnerId: "p1", referralId, referredUserId, stripeInvoiceId: `in_${id}`, subscriptionRevenueCents: cents * 5, commissionRateBps: 2000, commissionCents: cents, monthNumber: 1 },
      });
    await commission("c_held", "held", "sam", 2980);
    await commission("c_plain", "plain", "jo", 5980);
  }
  const commission = (id: string) => fake.client.partnerCommission.findUnique({ where: { id } });

  /** The partners page reads with `include`, which the in-memory database leaves to the caller. */
  function withPartnerIncludes() {
    const partners = fake.client.partner as FakeModel;
    const plain = partners.findMany.bind(partners);
    (partners as any).findMany = async (args: any) => {
      const rows = await plain({ where: args?.where });
      return Promise.all(
        rows.map(async (p: any) => ({
          ...p,
          user: await fake.client.user.findUnique({ where: { id: p.userId } }),
          referralCode: await fake.client.referralCode.findUnique({ where: { partnerId: p.id } }),
          commissions: await fake.client.partnerCommission.findMany({ where: { partnerId: p.id } }),
          _count: { referrals: await fake.client.referral.count({ where: { partnerId: p.id } }) },
          // The page's own filter for referrals to check.
          referrals: await Promise.all(
            (await fake.client.referral.findMany({ where: { partnerId: p.id, ...args.include.referrals.where } })).map(async (r: any) => ({
              ...r,
              referredUser: await fake.client.user.findUnique({ where: { id: r.referredUserId } }),
            }))
          ),
        }))
      );
    };
  }

  it("splits earned commission into what can be paid, what is held, and what isn't paid at all", async () => {
    const split = partnerPayout(
      [
        { id: "a", status: "earned", commissionCents: 2980, referralId: "held" },
        { id: "b", status: "earned", commissionCents: 5980, referralId: "plain" },
        { id: "c", status: "paid", commissionCents: 1000, referralId: "plain" },
        { id: "d", status: "voided", commissionCents: 700, referralId: "held" },
        // Recorded by an invoice's webhook just after a hand disqualification.
        { id: "e", status: "earned", commissionCents: 1500, referralId: "out" },
      ],
      { held: new Set(["held"]), disqualified: new Set(["out"]) }
    );
    expect(split).toEqual({ owedCents: 5980, payableIds: ["b"], heldCents: 2980 });
  });

  it("shows only the payable amount as Owed, offers only it to Mark paid, and shows what's held with the actions", async () => {
    await seedPartner();
    withPartnerIncludes();
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    await signInAsAdmin();
    const page = await AdminPartnersPage();
    expect(propsOf(page, MarkPaidButton)).toEqual([{ commissionIds: ["c_plain"], amountLabel: "$59.80" }]);
    expect(propsOf(page, ReferralCheckActions)).toEqual([{ referralId: "held" }]);
    const text = textOf(page);
    expect(text).toContain("$59.80$29.80 held: 1 referral to check before paying");
    expect(text).toContain("sam@ortizbuilders.com: Check by hand before paying:");
    // Still "earned": held, not taken away.
    expect(await commission("c_held")).toMatchObject({ status: "earned" });
  });

  it("Mark paid records nothing when the page sent a held commission", async () => {
    await seedPartner();
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    await signInAsAdmin();
    // A page drawn before Sam's referral was flagged offered both.
    const res = await markPaidRoute(post("/api/admin/commissions", { commissionIds: ["c_held", "c_plain"], note: "ACH 1042" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(CHANGED_MESSAGE);
    expect(await commission("c_held")).toMatchObject({ status: "earned", paidAt: null });
    expect(await commission("c_plain")).toMatchObject({ status: "earned", paidAt: null });
    expect(mail.payouts).toEqual([]);

    // What the page offers now is recorded, and the partner told of it.
    const fresh = await markPaidRoute(post("/api/admin/commissions", { commissionIds: ["c_plain"], note: "ACH 1042" }));
    expect(await fresh.json()).toEqual({ ok: true, updated: 1 });
    expect(await commission("c_plain")).toMatchObject({ status: "paid", paidNote: "ACH 1042" });
    expect(mail.payouts).toEqual([{ partnerUserId: "puser", amountCents: 5980 }]);
  });

  it("Looks fine clears the note, and the commission can be paid", async () => {
    await seedPartner();
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    await signInAsAdmin();
    const res = await decideReferralRoute(post("/api/admin/referrals", { referralId: "held", action: "clear" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, decision: "cleared" });
    expect(await fake.client.referral.findUnique({ where: { id: "held" } })).toMatchObject({ status: "paid", disqualifiedReason: null });
    expect((await markPaidRoute(post("/api/admin/commissions", { commissionIds: ["c_held"] }))).status).toBe(200);
    expect(await commission("c_held")).toMatchObject({ status: "paid" });
  });

  it("Disqualify disqualifies it and voids the commission the hold kept back", async () => {
    await seedPartner();
    await fake.client.partnerCommission.create({
      data: { id: "c_held_paid", partnerId: "p1", referralId: "held", referredUserId: "sam", stripeInvoiceId: "in_old", subscriptionRevenueCents: 14900, commissionRateBps: 2000, commissionCents: 2980, monthNumber: 1, status: "paid" },
    });
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    await signInAsAdmin();
    const res = await decideReferralRoute(post("/api/admin/referrals", { referralId: "held", action: "disqualify" }));
    expect(await res.json()).toEqual({ ok: true, decision: "disqualified" });
    expect(await fake.client.referral.findUnique({ where: { id: "held" } })).toMatchObject({
      status: "disqualified",
      disqualifiedReason: CHECKED_AND_DISQUALIFIED_REASON,
    });
    expect(await commission("c_held")).toMatchObject({ status: "voided", voidReason: CHECKED_AND_DISQUALIFIED_REASON });
    // Money already paid out stays paid, flagged for review as a refund flags it.
    expect(await commission("c_held_paid")).toMatchObject({
      status: "paid",
      paidNote: `REVIEW ${NOW_DAY()}: Referral disqualified by hand on a check after this commission was paid out.`,
    });
    // The other referral's commission is untouched.
    expect(await commission("c_plain")).toMatchObject({ status: "earned" });
  });

  it("refuses anyone who isn't an admin, changing nothing", async () => {
    await seedPartner();
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    // Signed out.
    expect((await decideReferralRoute(post("/api/admin/referrals", { referralId: "held", action: "clear" }))).status).toBe(403);
    // Signed in as a customer.
    await signInAsCustomer();
    for (const action of ["clear", "disqualify"]) {
      const res = await decideReferralRoute(post("/api/admin/referrals", { referralId: "held", action }));
      expect(res.status).toBe(403);
    }
    expect((await markPaidRoute(post("/api/admin/commissions", { commissionIds: ["c_plain"] }))).status).toBe(403);
    expect(await fake.client.referral.findUnique({ where: { id: "held" } })).toMatchObject({ status: "paid", disqualifiedReason: unprovenReferralNote(ago(3)) });
    expect(await commission("c_plain")).toMatchObject({ status: "earned" });
    // Next's notFound(): the digest Next 16 gives it.
    await expect(AdminPartnersPage()).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    await expect(AdminReferralsPage()).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });

  it("refuses a decision sent from another site before it reaches the route", () => {
    const crossSite = new Headers({ "sec-fetch-site": "cross-site" });
    expect(refusesCrossSiteChange("POST", "/api/admin/referrals", crossSite, "https://jobprofitai.com/api/admin/referrals")).toBe(true);
  });

  it("offers the actions on the Referrals tab for held referrals only", async () => {
    await seedPartner();
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    await signInAsAdmin();
    const referrals = fake.client.referral as FakeModel;
    const plain = referrals.findMany.bind(referrals);
    (referrals as any).findMany = async (args: any) =>
      (await plain({ where: args?.where })).map((r: any) => ({ ...r, referrer: null, referredUser: null, partner: { firmName: "Ledger Pros" }, reward: null }));
    const page = await AdminReferralsPage();
    expect(propsOf(page, ReferralCheckActions)).toEqual([{ referralId: "held" }]);
    expect(isHeldForCheck({ status: "disqualified", disqualifiedReason: unprovenReferralNote(NOW) })).toBe(false);
    expect(HELD_FOR_CHECK_WHERE.disqualifiedReason.startsWith).toBe("Check by hand before paying:");
  });

  afterEach(() => {
    process.env.ADMIN_EMAILS = "";
  });
});

describe("review: B2, a stored uncertain status is checked against Stripe", () => {
  async function invitePm(subscription: Record<string, unknown>) {
    await seedOwner();
    const invite = await createInvite("owner", "pm@ortizbuilders.com", NOW);
    if (!invite.ok) throw new Error(invite.error);
    await fake.client.user.create({ data: { id: "pm", email: "pm@ortizbuilders.com", emailVerifiedAt: ago(200), sessionVersion: 0 } });
    await fake.client.subscription.create({ data: { userId: "pm", status: "incomplete", stripeSubscriptionId: "sub_pm", stripeCustomerId: "cus_pm", ...subscription } });
    return invite.token;
  }
  const joined = () => fake.client.teamMember.findFirst({ where: { memberUserId: "pm" } });

  it.each(["incomplete_expired", "canceled"])("joins when Stripe says it is %s (its webhook was lost), after the customer check", async (status) => {
    const token = await invitePm({});
    stripe.subscriptions.set("sub_pm", status);
    stripe.open = [{ id: "cs_open", customer: "cus_pm" }];
    expect(await acceptInvite(token, "pm", NOW)).toEqual({ ok: true, ownerUserId: "owner" });
    expect(stripe.retrieved).toEqual(["sub_pm"]);
    expect(stripe.asked).toEqual(["cus_pm"]);
    expect(stripe.expired).toEqual(["cs_open"]);
  });

  it("still refuses when it ended but the customer check finds something live", async () => {
    const token = await invitePm({});
    stripe.subscriptions.set("sub_pm", "incomplete_expired");
    stripe.decision = { block: true, message: "already subscribed" };
    expect(await acceptInvite(token, "pm", NOW)).toEqual({ ok: false, error: OWN_PLAN_JOIN_MESSAGE, status: 409 });
    expect(await joined()).toBeNull();
  });

  it.each(["incomplete", "active", "past_due", "paused"])("refuses when Stripe says it is %s", async (status) => {
    const token = await invitePm({});
    stripe.subscriptions.set("sub_pm", status);
    expect(await acceptInvite(token, "pm", NOW)).toEqual({ ok: false, error: OWN_PLAN_JOIN_MESSAGE, status: 409 });
    expect(stripe.asked).toEqual([]);
    expect(await joined()).toBeNull();
  });

  it("says try again when Stripe can't be asked", async () => {
    const token = await invitePm({});
    stripe.retrieveDown = true;
    expect(await acceptInvite(token, "pm", NOW)).toEqual({
      ok: false,
      error: "We couldn't check your login's billing just now, so the invitation wasn't accepted. Please try again in a few minutes.",
      status: 503,
    });
    expect(await joined()).toBeNull();
  });

  it("treats one Stripe has no record of as ended, since it can't bill", async () => {
    const token = await invitePm({});
    expect((await acceptInvite(token, "pm", NOW)).ok).toBe(true);
    expect(stripe.retrieved).toEqual(["sub_pm"]);
    expect(stripe.asked).toEqual(["cus_pm"]);
  });

  it("refuses without asking when there's no customer id to check afterwards", async () => {
    const token = await invitePm({ stripeCustomerId: null });
    expect(await acceptInvite(token, "pm", NOW)).toEqual({ ok: false, error: OWN_PLAN_JOIN_MESSAGE, status: 409 });
    expect(stripe.retrieved).toEqual([]);
  });
});

// =============================================================================
// Fourth round: the edges of the hold.
// =============================================================================

/**
 * Ledger Pros referred Sam (held for a check) and Jo (ordinary), each with
 * earned commission; both are paying.
 */
async function seedLedgerPros() {
  await fake.client.user.create({ data: { id: "puser", email: "books@ledgerpros.com", emailVerifiedAt: ago(300), sessionVersion: 0 } });
  await fake.client.partner.create({ data: { id: "p1", userId: "puser", firmName: "Ledger Pros", contactName: "Lee", status: "approved", createdAt: ago(300) } });
  await fake.client.referralCode.create({ data: { id: "rc1", code: "LDGRPRS", kind: "partner", partnerId: "p1" } });
  await addPartnerClient("held", "sam", "sam@ortizbuilders.com", unprovenReferralNote(ago(3)));
  await addPartnerClient("plain", "jo", "jo@kimroofing.com", null);
  await addCommission("c_held", "held", "sam", 2980);
  await addCommission("c_plain", "plain", "jo", 5980);
}
async function addPartnerClient(referralId: string, userId: string, email: string, note: string | null) {
  await fake.client.user.create({ data: { id: userId, email, emailVerifiedAt: ago(3), sessionVersion: 0 } });
  await fake.client.subscription.create({ data: { userId, status: "active", plan: "profit_intelligence", firstPaidAt: ago(20), stripeCustomerId: `cus_${userId}` } });
  await fake.client.referral.create({
    data: { id: referralId, referralCodeId: "rc1", kind: "partner", partnerId: "p1", referredUserId: userId, status: "paid", firstPaidAt: ago(20), disqualifiedReason: note },
  });
}
function addCommission(id: string, referralId: string, referredUserId: string, cents: number, status = "earned") {
  return fake.client.partnerCommission.create({
    data: { id, partnerId: "p1", referralId, referredUserId, stripeInvoiceId: `in_${id}`, subscriptionRevenueCents: cents * 5, commissionRateBps: 2000, commissionCents: cents, monthNumber: 1, status },
  });
}
const commissionRow = (id: string) => fake.client.partnerCommission.findUnique({ where: { id } });

/** The partners page reads with `include`, which the in-memory database leaves to the caller. */
function partnersWithIncludes() {
  const partners = fake.client.partner as FakeModel;
  const plain = partners.findMany.bind(partners);
  (partners as any).findMany = async (args: any) =>
    Promise.all(
      (await plain({ where: args?.where })).map(async (p: any) => ({
        ...p,
        user: await fake.client.user.findUnique({ where: { id: p.userId } }),
        referralCode: await fake.client.referralCode.findUnique({ where: { partnerId: p.id } }),
        commissions: await fake.client.partnerCommission.findMany({ where: { partnerId: p.id } }),
        _count: { referrals: await fake.client.referral.count({ where: { partnerId: p.id } }) },
        referrals: await Promise.all(
          (await fake.client.referral.findMany({ where: { partnerId: p.id, ...args.include.referrals.where } })).map(async (r: any) => ({
            ...r,
            referredUser: await fake.client.user.findUnique({ where: { id: r.referredUserId } }),
          }))
        ),
      }))
    );
}

describe("review: B3, a stale Mark paid records nothing", () => {
  beforeEach(() => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  });
  afterEach(() => {
    process.env.ADMIN_EMAILS = "";
  });

  it("refuses the whole request, records nothing and says what to do, when a referral was flagged after the page was drawn", async () => {
    await seedLedgerPros();
    await fake.client.referral.update({ where: { id: "held" }, data: { disqualifiedReason: null } });
    await signInAsAdmin();
    partnersWithIncludes();
    // The page offers $89.60 for both...
    expect(propsOf(await AdminPartnersPage(), MarkPaidButton)).toEqual([{ commissionIds: ["c_held", "c_plain"], amountLabel: "$89.60" }]);
    // ...then Sam's address is first proven by a reset, and the $89.60 is paid by bank and recorded.
    await fake.client.referral.update({ where: { id: "held" }, data: { disqualifiedReason: unprovenReferralNote(NOW) } });
    const res = await markPaidRoute(post("/api/admin/commissions", { commissionIds: ["c_held", "c_plain"] }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: CHANGED_MESSAGE });
    expect([(await commissionRow("c_held")).status, (await commissionRow("c_plain")).status]).toEqual(["earned", "earned"]);
    expect(mail.payouts).toEqual([]);
  });

  it("refuses a request including a commission voided since", async () => {
    await seedLedgerPros();
    await addCommission("c_refunded", "plain", "jo", 1000, "voided");
    await signInAsAdmin();
    expect((await markPaidRoute(post("/api/admin/commissions", { commissionIds: ["c_plain", "c_refunded"] }))).status).toBe(409);
    expect(await commissionRow("c_plain")).toMatchObject({ status: "earned" });
  });

  it("still treats a second click as nothing left to do", async () => {
    await seedLedgerPros();
    await signInAsAdmin();
    expect((await markPaidRoute(post("/api/admin/commissions", { commissionIds: ["c_plain"] }))).status).toBe(200);
    const again = await markPaidRoute(post("/api/admin/commissions", { commissionIds: ["c_plain"] }));
    expect(await again.json()).toEqual({ ok: true, updated: 0, detail: "Nothing left to mark paid." });
  });

  it("the button shows the refusal (it shows any error the route sends)", () => {
    expect(flat("app/dashboard/admin/partners/PartnerAdminActions.tsx")).toContain('if (!res.ok) { setError(data.error ?? "Action failed.");');
  });
});

describe("review: B3, a held referral doesn't raise a partner's rate or count toward the free account", () => {
  it("leaves it out of the paying clients until cleared, keeping referrals with no note or another note", async () => {
    expect(PARTNER_FREE_ACCOUNT_THRESHOLD).toBe(3);
    await seedLedgerPros();
    await addPartnerClient("noted", "kim", "kim@kimbuilds.com", "Support: confirmed by phone.");
    expect(await countPayingClients("p1")).toBe(2);
    expect(await maybeGrantFreeFirmAccount("p1")).toBe(false);

    await decideHeldReferral("held", "clear", NOW);
    expect(await countPayingClients("p1")).toBe(3);
    expect(await maybeGrantFreeFirmAccount("p1")).toBe(true);
  });

  it("matches referrals with no note explicitly, since SQL leaves null out of a NOT", () => {
    expect(WITHOUT_CHECK_NOTE_WHERE.OR[0]).toEqual({ disqualifiedReason: null });
    expect(WITHOUT_CHECK_NOTE_WHERE.OR[1]).toEqual({ NOT: { disqualifiedReason: { startsWith: "Check by hand before paying:" } } });
  });
});

describe("review: B3, a hand disqualification applies only while held, and nothing after it is paid", () => {
  beforeEach(() => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  });
  afterEach(() => {
    process.env.ADMIN_EMAILS = "";
  });

  it("does nothing if Looks fine was chosen in another tab between reading and writing", async () => {
    await seedLedgerPros();
    await addCommission("c_held_paid", "held", "sam", 2980, "paid");
    const referrals = fake.client.referral as FakeModel;
    const read = referrals.findUnique.bind(referrals);
    (referrals as any).findUnique = async (args: any) => {
      const row = await read(args);
      // The other tab's "Looks fine" lands right after this read.
      await fake.client.referral.updateMany({ where: { id: "held" }, data: { disqualifiedReason: null } });
      return row;
    };
    expect(await decideHeldReferral("held", "disqualify", NOW)).toMatchObject({ ok: false, status: 409 });
    expect(await read({ where: { id: "held" } })).toMatchObject({ status: "paid", disqualifiedReason: null });
    expect(await commissionRow("c_held")).toMatchObject({ status: "earned" });
    expect((await commissionRow("c_held_paid")).paidNote ?? null).toBeNull();
  });

  it("doesn't pay commission an invoice records just after a hand disqualification", async () => {
    await seedLedgerPros();
    await signInAsAdmin();
    expect(await decideHeldReferral("held", "disqualify", NOW)).toEqual({ ok: true, decision: "disqualified" });
    // The webhook had read the referral before the disqualification landed.
    await addCommission("c_late", "held", "sam", 2980);
    partnersWithIncludes();
    const page = await AdminPartnersPage();
    expect(propsOf(page, MarkPaidButton)).toEqual([{ commissionIds: ["c_plain"], amountLabel: "$59.80" }]);
    expect((await markPaidRoute(post("/api/admin/commissions", { commissionIds: ["c_late"] }))).status).toBe(409);
    expect(await commissionRow("c_late")).toMatchObject({ status: "earned" });
    const owed = propsOf(await AdminOverviewPage(), StatGrid).flatMap((g) => g.stats).find((st: any) => st.label === "Commission owed");
    expect(owed).toEqual({ label: "Commission owed", value: "$59.80" });
  });

  it("flags commission already paid on it for review, and the Partners tab shows it", async () => {
    await seedLedgerPros();
    await addCommission("c_held_paid", "held", "sam", 2980, "paid");
    await fake.client.partnerCommission.update({ where: { id: "c_held_paid" }, data: { paidNote: "ACH 1001" } });
    await signInAsAdmin();
    await decideHeldReferral("held", "disqualify", NOW);
    expect((await commissionRow("c_held_paid")).paidNote).toBe(
      "ACH 1001\nREVIEW 2026-10-27: Referral disqualified by hand on a check after this commission was paid out."
    );
    partnersWithIncludes();
    expect(textOf(await AdminPartnersPage())).toContain("1 to review");
  });
});

describe("review: B3, what the referrer reads", () => {
  /** Ana referred three customers: one held with a reward waiting, one disqualified after a check, one ordinary with a reward waiting. */
  async function seedAna() {
    await fake.client.user.create({ data: { id: "ana", email: "ana@ortizbuilders.com", emailVerifiedAt: ago(300), sessionVersion: 0 } });
    await fake.client.subscription.create({ data: { userId: "ana", status: "active", plan: "profit_intelligence", stripeSubscriptionId: "sub_ana" } });
    await fake.client.referralCode.create({ data: { id: "rc_ana", code: "ANAORTZ", kind: "customer", userId: "ana" } });
    const add = async (id: string, status: string, note: string | null, reward: string) => {
      await fake.client.referral.create({
        data: { id, referralCodeId: "rc_ana", kind: "customer", referrerUserId: "ana", status, signedUpAt: ago(60), firstPaidAt: ago(50), disqualifiedReason: note },
      });
      await fake.client.referralReward.create({ data: { referralId: id, referrerUserId: "ana", amountCents: id === "r_plain" ? 9900 : 14900, plan: "profit_intelligence", status: reward } });
    };
    await add("r_held", "qualified", unprovenReferralNote(ago(2)), "pending");
    await add("r_out", "disqualified", CHECKED_AND_DISQUALIFIED_REASON, "voided");
    await add("r_plain", "qualified", null, "pending");
    await createSession("ana");
  }
  const rowFor = (history: Awaited<ReturnType<typeof getReferralHistory>>, id: string) => history.find((r) => r.id === id)!;

  it("tells which rows are being checked or were ruled out, without the reason", async () => {
    await seedAna();
    const history = await getReferralHistory("ana");
    expect(rowFor(history, "r_held")).toMatchObject({ beingChecked: true, disqualifiedAfterCheck: false });
    expect(rowFor(history, "r_out")).toMatchObject({ beingChecked: false, disqualifiedAfterCheck: true });
    expect(rowFor(history, "r_plain")).toMatchObject({ beingChecked: false, disqualifiedAfterCheck: false });
    expect(JSON.stringify(history)).not.toContain("password reset");
    // The held reward isn't promised as waiting.
    expect(await getReferralSummary("ana")).toMatchObject({ pendingRewardCents: 9900, totalEarnedCents: 9900 });
  });

  it("words both cases honestly on the page", async () => {
    await seedAna();
    const text = textOf(await ReferralsPage());
    expect(text).toContain("Being checked before it's applied.");
    expect(text).toContain("Being checked");
    expect(text).toContain("Not eligible for a referral credit.");
    expect(text).not.toContain("refunded");
    expect(text).not.toContain("Reversed");
    expect(text).not.toContain("password reset");
    // Only the ordinary credit is promised for the next invoice and counted as waiting.
    expect(text.split("Earned. It goes on as an account credit at your next invoice.").length - 1).toBe(1);
    expect(text).toContain("$99.00 in credit is waiting.");
  });
});

describe("review: B3, held referrals can't be stranded", () => {
  beforeEach(() => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  });
  afterEach(() => {
    process.env.ADMIN_EMAILS = "";
  });

  it("lists every held referral at the top of the Referrals tab, however old, with the decision buttons", async () => {
    await signInAsAdmin();
    await fake.client.user.create({ data: { id: "ana", email: "ana@ortizbuilders.com", emailVerifiedAt: ago(300), sessionVersion: 0 } });
    await fake.client.referralCode.create({ data: { id: "rc_ana", code: "ANAORTZ", kind: "customer", userId: "ana" } });
    await fake.client.referral.create({
      data: { id: "old_held", referralCodeId: "rc_ana", kind: "customer", referrerUserId: "ana", status: "paid", signedUpAt: ago(400), disqualifiedReason: unprovenReferralNote(ago(2)) },
    });
    for (let i = 0; i < 300; i++) {
      await fake.client.referral.create({ data: { id: `new_${i}`, referralCodeId: "rc_ana", kind: "customer", referrerUserId: "ana", status: "signed_up", signedUpAt: ago(1) } });
    }
    const referrals = fake.client.referral as FakeModel;
    const plain = referrals.findMany.bind(referrals);
    (referrals as any).findMany = async (args: any) =>
      (await plain({ where: args?.where, orderBy: args?.orderBy, take: args?.take })).map((r: any) => ({
        ...r,
        referrer: { email: "ana@ortizbuilders.com" },
        referredUser: null,
        partner: null,
        reward: null,
      }));
    const page = await AdminReferralsPage();
    expect(propsOf(page, ReferralCheckActions)).toEqual([{ referralId: "old_held" }]);
    expect(propsOf(page, AdminSection).map((section) => section.title)).toEqual(["Waiting for a check", "Referrals"]);
  });

  it("shows the held count on the overview, and Commission owed as the Partners tab counts it", async () => {
    await seedLedgerPros();
    await fake.client.user.create({ data: { id: "ana", email: "ana@ortizbuilders.com", emailVerifiedAt: ago(300), sessionVersion: 0 } });
    await fake.client.referralCode.create({ data: { id: "rc_ana", code: "ANAORTZ", kind: "customer", userId: "ana" } });
    await fake.client.referral.create({
      data: { id: "cust_held", referralCodeId: "rc_ana", kind: "customer", referrerUserId: "ana", status: "paid", disqualifiedReason: unprovenReferralNote(ago(2)) },
    });
    await signInAsAdmin();
    const page = await AdminOverviewPage();
    const stats = propsOf(page, StatGrid).flatMap((g) => g.stats);
    expect(stats).toContainEqual({ label: "Commission owed", value: "$59.80" });
    expect(stats).toContainEqual({ label: "Commission held", value: "$29.80" });
    expect(textOf(page)).toContain("2 referral(s) waiting for a check before any credit or commission is paid");
  });

  it("keeps held rewards out of the retry batch, so they can't keep others waiting", async () => {
    await fake.client.user.create({ data: { id: "ana", email: "ana@ortizbuilders.com", emailVerifiedAt: ago(300), sessionVersion: 0 } });
    await fake.client.subscription.create({ data: { userId: "ana", status: "active", stripeCustomerId: "cus_ana", stripeSubscriptionId: "sub_ana" } });
    await fake.client.referralCode.create({ data: { id: "rc_ana", code: "ANAORTZ", kind: "customer", userId: "ana" } });
    for (const [id, note] of [["r_held", unprovenReferralNote(ago(2))], ["r_plain", null]] as const) {
      await fake.client.referral.create({ data: { id, referralCodeId: "rc_ana", kind: "customer", referrerUserId: "ana", status: "qualified", disqualifiedReason: note } });
      await fake.client.referralReward.create({ data: { id: `w_${id}`, referralId: id, referrerUserId: "ana", amountCents: 14900, plan: "profit_intelligence" } });
    }
    // A batch of one: the held reward comes first and used to take the place.
    expect(await retryPendingRewards(1)).toBe(1);
    expect(await fake.client.referralReward.findUnique({ where: { id: "w_r_plain" } })).toMatchObject({ status: "applied" });
    expect(await fake.client.referralReward.findUnique({ where: { id: "w_r_held" } })).toMatchObject({ status: "pending" });
  });
});
