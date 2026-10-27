import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  DISCONNECTED_RETENTION_DAYS,
  LAPSED_DISCONNECT_DAYS,
  accessEndedAt,
  deletionDueAt,
  lapsedLongEnough,
} from "@/lib/dataRetention";
import { safeReturnPath } from "@/lib/termsAcceptance";
import { requestAdOptOut, signupAdOptOut } from "@/lib/adOptOut";
import { serverReportsAllowed } from "@/lib/tracking";
import { TIPS_EMAIL_TYPES, tipsUnsubscribeUrl, verifyTipsToken } from "@/lib/emailPreferences";
import * as T from "@/lib/email/templates";
import { ACCEPTANCE_VERSION, LEGAL_LAST_UPDATED, RETENTION_RULES_START } from "@/lib/legalVersion";

// What the October 2026 legal review asked for, held to the code: data
// kept only while a company is in use (Intuit's developer terms, 12.2), a
// record of every acceptance of the Terms, opt-outs that reach the server,
// AI kept in the US, an unsubscribe on tips emails, and the legal text that
// promises all of it.

const SRC = join(__dirname, "..", "..");
const ROOT = join(SRC, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const flat = (rel: string) => read(rel).replace(/\s+/g, " ");
const DAY = 86_400_000;

describe("how long QuickBooks data is kept", () => {
  // A day well after the rules took effect, so the start-date clamp doesn't apply.
  const now = new Date(new Date(`${RETENTION_RULES_START}T12:00:00Z`).getTime() + 10 * DAY);
  const base = { trialEndsAt: null, currentPeriodEnd: null, canceledAt: null, updatedAt: new Date("2026-06-01T00:00:00Z") };

  it("deletes a disconnected company's data 30 days after the disconnect", () => {
    expect(DISCONNECTED_RETENTION_DAYS).toBe(30);
    expect(deletionDueAt(now).getTime() - now.getTime()).toBe(30 * DAY);
  });

  it("starts no clock before the rules took effect, so nothing old is deleted on the first run", () => {
    const start = new Date(`${RETENTION_RULES_START}T00:00:00Z`);
    expect(deletionDueAt(new Date("2026-08-01T00:00:00Z")).getTime()).toBe(start.getTime() + 30 * DAY);
    expect(lapsedLongEnough(new Date("2026-05-01T00:00:00Z"), new Date(start.getTime() + 89 * DAY))).toBe(false);
    expect(lapsedLongEnough(new Date("2026-05-01T00:00:00Z"), new Date(start.getTime() + 90 * DAY))).toBe(true);
  });

  it("counts from launch day, recorded by the first run, for anything older", () => {
    const launch = new Date("2026-12-01T15:00:00Z");
    const old = new Date("2026-09-01T00:00:00Z");
    expect(deletionDueAt(old, launch).getTime()).toBe(launch.getTime() + 30 * DAY);
    expect(lapsedLongEnough(old, new Date(launch.getTime() + 89 * DAY), launch)).toBe(false);
    expect(lapsedLongEnough(old, new Date(launch.getTime() + 90 * DAY), launch)).toBe(true);
    // After launch, the full 30 days and no more.
    const later = new Date(launch.getTime() + 5 * DAY);
    expect(deletionDueAt(later, launch).getTime()).toBe(later.getTime() + 30 * DAY);
    const cron = flat("app/api/cron/lifecycle/route.ts");
    expect(cron).toContain("rulesStart = await retentionRulesStart(now);");
    expect(cron).toContain("await purgeDisconnectedCompanies(now, rulesStart)");
    expect(cron).toContain("await disconnectLapsedCompanies(now, rulesStart)");
    expect(flat("lib/companyData.ts")).toContain("create: { key: RULES_START_KEY, at: now },");
    expect(read("../prisma/schema.prisma")).toContain("model AppMilestone {");
  });

  it("counts an account as lapsed only once its trial or plan has ended", () => {
    expect(accessEndedAt({ ...base, status: "active" }, now, now)).toBeNull();
    expect(accessEndedAt({ ...base, status: "past_due" }, now, now)).toBeNull();
    expect(accessEndedAt({ ...base, status: "trialing", trialEndsAt: new Date(now.getTime() + DAY) }, now, now)).toBeNull();
    const ended = new Date("2026-07-01T00:00:00Z");
    expect(accessEndedAt({ ...base, status: "trialing", trialEndsAt: ended }, now, now)).toEqual(ended);
    expect(accessEndedAt({ ...base, status: "trial_expired", trialEndsAt: ended }, now, now)).toEqual(ended);
    expect(accessEndedAt({ ...base, status: "canceled", currentPeriodEnd: ended }, now, now)).toEqual(ended);
    expect(accessEndedAt({ ...base, status: "unpaid" }, now, now)).toEqual(base.updatedAt);
    expect(accessEndedAt(null, ended, now)).toEqual(ended);
  });

  it("disconnects after 90 days without a trial or plan, not before", () => {
    expect(LAPSED_DISCONNECT_DAYS).toBe(90);
    const later = new Date("2027-06-01T00:00:00Z");
    expect(lapsedLongEnough(new Date(later.getTime() - 89 * DAY), later)).toBe(false);
    expect(lapsedLongEnough(new Date(later.getTime() - 90 * DAY), later)).toBe(true);
    expect(lapsedLongEnough(null, later)).toBe(false);
  });

  it("runs the disconnects, the reminder and the deletion every hour", () => {
    const cron = read("app/api/cron/lifecycle/route.ts");
    for (const stage of ['"lapsed-disconnect"', '"revoked-grants"', '"deletion-reminders"', '"purge-disconnected"']) {
      expect(cron).toContain(stage);
    }
  });

  it("never deletes a company reconnected while the purge runs, and keeps the trial record", () => {
    const lib = flat("lib/companyData.ts");
    expect(lib).toContain("prisma.quickBooksConnection.deleteMany({ where: { id: c.id, disconnectedAt: { not: null, lte: cutoff } } })");
    expect(lib).toContain("await keepTrialRecord(c);");
    expect(lib).toContain("await keepTrialRecord(connection);");
    // Lapsed accounts are read without paying customers in the way.
    expect(lib).toContain('{ subscription: { status: { notIn: ["active", "past_due", "trialing"] } } }');
  });

  it("lets the owner delete one company's data, with the password and the word DELETE", () => {
    const route = flat("app/api/quickbooks/delete-company/route.ts");
    expect(route).toContain('account.role !== "owner"');
    expect(route).toContain("verifyPassword(parsed.data.password, owner.passwordHash)");
    expect(route).toContain('z.literal("DELETE"');
    expect(route).toContain("connection.userId !== account.ownerId");
    expect(read("app/dashboard/settings/ConnectionActions.tsx")).toContain("<DeleteCompanyForm");
    expect(read("app/dashboard/settings/page.tsx")).toContain("Disconnected companies");
    expect(flat("lib/companyData.ts")).toContain("prisma.quickBooksConnection.delete({ where: { id: connection.id } })");
  });

  it("tells customers about the deletion in the emails that used to say nothing is ever deleted", () => {
    expect(T.trialExpiredEmail().text).toContain(`${LAPSED_DISCONNECT_DAYS} days`);
    expect(T.subscriptionCanceledEmail(null).text).toContain(`${DISCONNECTED_RETENTION_DAYS} days later`);
    const lapsed = T.lapsedDisconnectedEmail(["Torres Builders"], new Date("2026-11-08T12:00:00Z"));
    expect(lapsed.subject).toContain("Torres Builders");
    expect(lapsed.text).toContain("deleted for good");
  });
});

describe("acceptance of the Terms", () => {
  // The accepted version moves only for a material change; the printed date
  // moves for every change (src/lib/legalVersion.ts).
  const printed = new Date(`${LEGAL_LAST_UPDATED} 12:00 UTC`).toISOString().slice(0, 10);

  it("has a version on or before the printed date", () => {
    expect(ACCEPTANCE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ACCEPTANCE_VERSION <= printed).toBe(true);
  });

  it("starts every agreement box unchecked and refuses a signup without it", () => {
    expect(read("app/signup/SignupForm.tsx")).toContain("const [agreed, setAgreed] = useState(false);");
    expect(read("app/login/intuit/IntuitLinkForm.tsx")).toContain("const [agreed, setAgreed] = useState(false);");
    expect(read("app/accept-terms/AcceptTermsForm.tsx")).toContain("const [agreed, setAgreed] = useState(false);");
    expect(flat("app/api/auth/signup/route.ts")).toContain("acceptTerms: z.literal(true");
    expect(flat("app/api/auth/signup/route.ts")).toContain('termsAcceptances: { create: acceptanceData("signup", req.headers) }');
    expect(flat("app/api/auth/intuit/create/route.ts")).toContain("if (body.acceptTerms !== true)");
    expect(flat("app/api/auth/intuit/create/route.ts")).toContain('acceptanceData("intuit_signup", req.headers)');
  });

  it("asks anyone without a record of the current version before the app opens", () => {
    expect(flat("app/dashboard/layout.tsx")).toContain('if (!(await hasAcceptedCurrentTerms(account.userId))) redirect("/accept-terms");');
    expect(flat("app/reports/wip/page.tsx")).toContain("hasAcceptedCurrentTerms(account.userId)");
    expect(safeReturnPath("/reports/wip")).toBe("/reports/wip");
    expect(safeReturnPath("https://evil.example")).toBe("/dashboard");
    expect(safeReturnPath("//evil.example")).toBe("/dashboard");
    expect(safeReturnPath("/pricing")).toBe("/dashboard");
  });

  it("requires the terms box at Stripe checkout and keeps the consent", () => {
    expect(flat("lib/stripe/billing.ts")).toContain('consent_collection: { terms_of_service: "required" }');
    expect(flat("lib/stripe/webhookHandlers.ts")).toContain('session.consent?.terms_of_service === "accepted"');
    expect(read("../prisma/schema.prisma")).toContain("model TermsAcceptance {");
  });

  it("keeps the text of the version people accept, and of the version on the site now", () => {
    for (const version of [ACCEPTANCE_VERSION, printed]) {
      for (const doc of ["terms", "privacy", "dpa", "privacy-choices"]) {
        const file = join(ROOT, "legal-archive", version, `${doc}.md`);
        expect({ version, doc, archived: existsSync(file) }).toEqual({ version, doc, archived: true });
      }
    }
  });
});

describe("opt-outs on the account", () => {
  it("reads a Global Privacy Control header or the Your Privacy Choices cookie", () => {
    expect(requestAdOptOut(new Headers({ "sec-gpc": "1" }))).toBe("gpc");
    expect(requestAdOptOut(new Headers({ cookie: "a=1; jpai_optout=1" }))).toBe("privacy_page");
    expect(requestAdOptOut(new Headers({}))).toBeNull();
    expect(signupAdOptOut({ headers: new Headers({ "sec-gpc": "1" }) }).adOptOutSource).toBe("gpc");
    expect(signupAdOptOut({ headers: new Headers({}) })).toEqual({});
  });

  it("turns the tags off in every browser the person signs in to", () => {
    expect(flat("app/api/auth/login/route.ts")).toContain("await carryAdOptOutToBrowser(user);");
    expect(flat("lib/intuitSignIn.ts")).toContain("await carryAdOptOutToBrowser(user);");
  });

  it("stops server-side reports once an account has opted out", () => {
    expect(serverReportsAllowed({ adOptOutAt: null })).toBe(true);
    expect(serverReportsAllowed({ adOptOutAt: new Date() })).toBe(false);
    expect(flat("app/dashboard/layout.tsx")).toContain("noteBrowserOptOut(account.userId, await headers())");
    expect(flat("app/api/auth/login/route.ts")).toContain("await noteBrowserOptOut(user.id, req.headers)");
    expect(read("components/marketing/PrivacyChoices.tsx")).toContain('fetch("/api/privacy/ad-opt-out"');
  });
});

describe("AI requests stay in the US", () => {
  it("sends every request through inUs()", () => {
    for (const f of ["lib/intelligence.ts", "lib/jobTypeSuggestions.ts", "lib/digest.ts"]) {
      expect({ f, wrapped: /messages\.create\(inUs\(\{/.test(read(f)) }).toEqual({ f, wrapped: true });
    }
    expect(flat("lib/ai.ts")).toContain('export const INFERENCE_GEO = "us" as const;');
    expect(flat("lib/ai.ts")).toContain("inference_geo: INFERENCE_GEO");
  });
});

describe("tips and reminders can be turned off", () => {
  it("signs the unsubscribe link for one login", () => {
    const url = new URL(tipsUnsubscribeUrl("user_1"));
    expect(verifyTipsToken("user_1", url.searchParams.get("t")!)).toBe(true);
    expect(verifyTipsToken("user_2", url.searchParams.get("t")!)).toBe(false);
  });

  it("covers the tips emails only, and adds the line to them", () => {
    expect([...TIPS_EMAIL_TYPES].sort()).toEqual(["report_guide", "setup_reminder", "testimonial_request", "trial_checkin", "trial_ending_offer"]);
    const plain = T.trialCheckInEmail("Sam");
    expect(plain.html).not.toContain("Unsubscribe");
    const tips = T.withUnsubscribe(plain, "https://jobprofitai.com/api/email/tips-off?u=x&t=y", "Don't want tips?");
    expect(tips.html).toContain("Unsubscribe</a>");
    expect(tips.text).toContain("Unsubscribe: https://jobprofitai.com/api/email/tips-off?u=x&t=y");
  });

  it("puts the renewal terms and how to cancel in the subscription email", () => {
    const email = T.subscriptionConfirmedEmail("Profit Intelligence", "$149/month");
    expect(email.text).toContain("renews automatically at $149/month");
    expect(email.text).toContain("Cancel anytime online");
  });
});

describe("what the legal pages now say", () => {
  const terms = flat("app/(marketing)/terms/page.tsx");
  const privacy = flat("app/(marketing)/privacy/page.tsx");
  const dpa = flat("app/(marketing)/dpa/page.tsx");

  it("Terms: acceptance, disconnect versus delete, confidentiality, the addendum, one combined cap, settlements", () => {
    for (const phrase of [
      "by checking the box that says you agree",
      "We keep a record of each acceptance",
      "not on Intuit&rsquo;s behalf",
      "{DISCONNECTED_RETENTION_DAYS} days after a disconnect",
      "delete a company&rsquo;s data at any time from Settings",
      'title="Confidentiality"',
      'href="/dpa"',
      "the &ldquo;PWL Parties&rdquo; are",
      "one combined limit for all claims against all of the PWL Parties",
      "You may not settle a claim without our prior written consent",
      "Except for the PWL Parties under Sections 12 and 14",
    ]) {
      expect({ phrase, found: terms.includes(phrase) }).toEqual({ phrase, found: true });
    }
  });

  it("Privacy: what ad measurement does and doesn't do, AI region and retention, where data is, later opt-outs, free text", () => {
    for (const phrase of [
      "We don&rsquo;t use remarketing",
      "in plain or hashed form",
      "marked as not to be used for ad personalization",
      "we send them only in the first 63 days after you sign up",
      "not on Intuit&rsquo;s behalf",
      "only on infrastructure in the United States",
      "such as its Files API",
      "When a company is disconnected:",
      "Handled elsewhere in some cases:",
      "including for steps that happen later",
      "don&rsquo;t ask for or deliberately extract",
      "Reports are set up to leave out QuickBooks figures",
    ]) {
      expect({ phrase, found: privacy.includes(phrase) }).toEqual({ phrase, found: true });
    }
    expect(privacy).not.toContain("we don&rsquo;t collect sensitive personal information");
    expect(privacy).not.toContain("can&rsquo;t be turned back into the address");
    // Launched without these; each needs its paragraph back before it's turned on.
    expect(privacy).not.toContain("LinkedIn Insight Tag");
    expect(privacy).not.toContain("Enhanced conversions:");
    // The demo video came back on October 26 with its paragraph ("Videos").
    expect(privacy).toContain('<LegalSub title="Videos">');
  });

  it("Addendum: instructions, service provider terms, subprocessors, incidents, deletion", () => {
    for (const phrase of [
      'title="3. Processing only on your instructions"',
      "We certify that we understand these restrictions",
      'title="6. Subprocessors"',
      "We have a written agreement with each Subprocessor",
      'title="8. Security incidents"',
      'title="10. Return and deletion"',
    ]) {
      expect({ phrase, found: dpa.includes(phrase) }).toEqual({ phrase, found: true });
    }
  });
});
