import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// The October 27, 2026 audit of the website, the emails' words and the
// legal pages (findings W1 to W7, W11 and W12), held to the code.

const sent: { emailType: string; subject: string; text: string; html: string }[] = [];

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: async () => ({ email: "owner@example.com", name: "Sam Rivera" }) },
    quickBooksConnection: { findFirst: async () => null },
  },
}));
vi.mock("@/lib/email/client", () => ({
  SUPPORT_EMAIL: "support@jobprofitai.com",
  sendEmail: async () => ({ ok: true }),
  sendLifecycleEmailOncePerKey: async () => ({ alreadySent: [], sentNow: [] }),
  sendLifecycleEmail: async (input: { emailType: string; subject: string; text: string; html: string }) => {
    sent.push(input);
    return { ok: true };
  },
}));

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PLANS, RECOMMENDED_PLAN_BADGE, TRIAL_DAYS, TRIAL_LIMITS, monthlyPriceCents, planPriceText } from "@/lib/plans";
import { PLAN_FEATURES } from "@/lib/entitlements";
import { subscriptionConfirmedEmail, subscriptionPriceText } from "@/lib/email/templates";
import { sendSubscriptionConfirmed } from "@/lib/email/lifecycle";
import { TRADEMARK_NOTICE } from "@/components/marketing/trademark";
import { DEMO_VIDEO, youtubeWatchUrl } from "@/lib/demoVideo";
import {
  ACCEPTANCE_VERSION,
  LEGAL_LAST_UPDATED,
  LEGAL_UPDATED,
  legalDateKey,
  legalDatePrinted,
  newestLegalUpdate,
  type LegalDocument,
} from "@/lib/legalVersion";
import PlanGuide from "@/components/marketing/PlanGuide";
import PricingCards from "@/components/marketing/PricingCards";
import DemoVideo from "@/components/marketing/DemoVideo";
import TermsPage from "@/app/(marketing)/terms/page";
import PrivacyPage from "@/app/(marketing)/privacy/page";
import DpaPage from "@/app/(marketing)/dpa/page";
import PrivacyChoicesPage from "@/app/(marketing)/privacy-choices/page";

const SRC = join(__dirname, "..", "..");
const ROOT = join(SRC, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const flat = (rel: string) => read(rel).replace(/\s+/g, " ");
/** A rendered page as the words a reader sees. */
const words = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("W1. the Firm subscription email states the minimum and the least it costs", () => {
  const min = PLANS.firm.perCompany!.minCompanies;
  const least = `$${monthlyPriceCents("firm") / 100}`;
  const firmPrice = `${PLANS.firm.priceLabel} per connected QuickBooks company a month, with a ${min}-company minimum (${least} a month at least)`;

  it("builds the Firm price from the plan catalog", () => {
    expect(least).toBe("$316");
    expect(subscriptionPriceText("firm")).toBe(firmPrice);
    expect(firmPrice).toBe("$79 per connected QuickBooks company a month, with a 4-company minimum ($316 a month at least)");
  });

  it("says it in the opening line and in the renewal terms, in the HTML and the text", async () => {
    sent.length = 0;
    await sendSubscriptionConfirmed("user_1", "firm", "sub_1");
    expect(sent).toHaveLength(1);
    const email = sent[0];
    expect(email.emailType).toBe("subscription_confirmed");
    for (const body of [email.text, words(email.html)]) {
      expect(body).toContain(`You're now on Firm at ${firmPrice}.`);
      expect(body).toContain(`Your subscription renews automatically at ${firmPrice}, plus any applicable tax, until you cancel.`);
      // As checkout says: the amount follows the companies connected.
      expect(body).toContain("The amount is adjusted as you connect or disconnect companies.");
      expect(body).not.toContain("per company/month");
    }
  });

  it("leaves the contractor plans' email as it was", async () => {
    for (const plan of ["profit_intelligence", "profit_intelligence_pro"] as const) {
      expect(subscriptionPriceText(plan)).toBe(planPriceText(plan));
      sent.length = 0;
      await sendSubscriptionConfirmed("user_1", plan, "sub_1");
      const { text } = sent[0];
      expect(text).toContain(`You're now on ${PLANS[plan].name} at ${PLANS[plan].priceLabel}/month.`);
      expect(text).toContain(`Your subscription renews automatically at ${PLANS[plan].priceLabel}/month, plus any applicable tax, until you cancel.`);
      expect(text).not.toContain("adjusted as you connect");
    }
    expect(subscriptionConfirmedEmail("Profit Intelligence", "$149/month").text).toContain("renews automatically at $149/month, plus");
  });

  it("matches what checkout tells a Firm customer", () => {
    const billing = flat("lib/stripe/billing.ts");
    expect(billing).toContain("per connected QuickBooks company (${PLANS.firm.perCompany!.minCompanies} minimum;");
    expect(billing).toContain("adjusted as you connect or disconnect companies");
  });
});

describe("W2. pages without the site footer that name QuickBooks show the trademark notice", () => {
  for (const f of ["app/signup/page.tsx", "app/login/page.tsx", "app/quickbooks/disconnected/page.tsx"]) {
    it(`${f} renders TRADEMARK_NOTICE`, () => {
      const text = flat(f);
      expect(text).toContain('import { TRADEMARK_NOTICE } from "@/components/marketing/trademark";');
      expect(text).toMatch(/<p className="[^"]*text-center text-xs[^"]*">\{TRADEMARK_NOTICE\}<\/p>/);
    });
  }

  it("puts it under the main card on the signup and disconnect pages", () => {
    const signup = flat("app/signup/page.tsx");
    expect(signup.indexOf("</Suspense> </div>")).toBeLessThan(signup.indexOf("{TRADEMARK_NOTICE}"));
    const disconnected = flat("app/quickbooks/disconnected/page.tsx");
    expect(disconnected.indexOf("support@jobprofitai.com </a> . </p> </div>")).toBeLessThan(disconnected.indexOf("{TRADEMARK_NOTICE}"));
  });

  it("is Intuit's wording, unchanged", () => {
    expect(TRADEMARK_NOTICE).toBe(
      "Intuit and QuickBooks are registered trademarks of Intuit Inc. Used with permission. JobProfitAI is an independent product and is not endorsed or sponsored by Intuit Inc."
    );
  });
});

describe("W3. the demo video player", () => {
  const html = renderToStaticMarkup(createElement(DemoVideo));

  it("shows our picture as the video's poster, and still downloads nothing until play", () => {
    expect(html).toMatch(/<video[^>]*preload="none"/);
    expect(html).toMatch(new RegExp(`<video[^>]*poster="${DEMO_VIDEO.poster}"`));
    expect(html).not.toMatch(/iframe|youtube/i);
  });

  it("says when the video can't load, with a retry and a plain link to YouTube", () => {
    const player = flat("components/marketing/DemoVideo.tsx");
    expect(player).toContain("onError={couldNotPlay}");
    expect(player).toContain('if ((err as { name?: string } | null)?.name !== "AbortError") couldNotPlay();');
    expect(player).toContain("The video couldn&apos;t load.");
    expect(player).toContain("Try again");
    expect(player).toContain("watch it on YouTube");
    expect(player).toContain("href={youtubeWatchUrl(video.youtubeId)}");
    expect(player).toContain('<div aria-live="polite">');
    // A link to YouTube's own page, never an embed.
    expect(youtubeWatchUrl(DEMO_VIDEO.youtubeId)).toBe("https://www.youtube.com/watch?v=WUFhwPolxaI");
    expect(player).not.toMatch(/iframe|youtube\.com\/embed|youtube-nocookie/i);
  });
});

describe("W4. the plan guide's prices can wrap on a phone", () => {
  const html = renderToStaticMarkup(createElement(PlanGuide));

  it("keeps only the plan names on one line", () => {
    expect(html).not.toMatch(/<td[^>]*whitespace-nowrap/);
    for (const name of [PLANS.profit_intelligence.name, PLANS.profit_intelligence_pro.name, PLANS.firm.name]) {
      expect(html).toContain(`<p class="whitespace-nowrap font-semibold text-jp-ink">${name}</p>`);
    }
  });

  it("puts the Firm minimum on its own line, and the other prices as before", () => {
    expect(html).toContain(`<p class="text-jp-muted">${PLANS.firm.priceLabel} per company/month</p>`);
    expect(html).toContain(`<p class="text-jp-muted">${PLANS.firm.perCompany!.minCompanies}-company minimum</p>`);
    expect(html).toContain('<p class="text-jp-muted">$149/month</p>');
    expect(html).toContain('<p class="text-jp-muted">$299/month</p>');
  });
});

describe("W5. the recommended plan's badge", () => {
  it("doesn't claim popularity before there are sales", () => {
    expect(RECOMMENDED_PLAN_BADGE).toBe("Best for most contractors");
    const html = renderToStaticMarkup(createElement(PricingCards));
    expect(html).not.toMatch(/most popular/i);
    expect(html.split(RECOMMENDED_PLAN_BADGE)).toHaveLength(2);
    // One line, on the plan marked mostPopular.
    expect(html).toMatch(/<span class="[^"]*whitespace-nowrap[^"]*">Best for most contractors<\/span><h3[^>]*>Profit Intelligence<\/h3>/);
    expect(flat("components/marketing/PricingCards.tsx")).not.toContain("Most Popular");
  });
});

describe("W6. the Privacy Policy says which videos our emails link to", () => {
  const sentence =
    "Some of our emails link to our videos on YouTube, a Google service, including a setup video that isn&rsquo;t on our website. If a video can&rsquo;t load on our website, the player offers a link to watch it on YouTube instead.";

  it("on the page and in its archived copy", () => {
    const privacy = flat("app/(marketing)/privacy/page.tsx");
    expect(privacy).toContain(sentence);
    expect(privacy).not.toContain("link to the same videos");
    const archived = readFileSync(join(ROOT, "legal-archive", legalDateKey(LEGAL_UPDATED.privacy), "privacy.md"), "utf8");
    expect(archived).toContain(sentence.replace(/&rsquo;/g, "’"));
    expect(archived).not.toContain("link to the same videos");
  });

  it("is not a material change", () => {
    expect(LEGAL_UPDATED.privacy).toBe("October 28, 2026");
    expect(ACCEPTANCE_VERSION).toBe("2026-10-14");
  });
});

describe("W7. each legal page prints the date its own text last changed", () => {
  const pages: Record<LegalDocument, () => ReactElement> = {
    terms: TermsPage,
    privacy: PrivacyPage,
    dpa: DpaPage,
    "privacy-choices": PrivacyChoicesPage,
  };

  it("moves the Terms, the Addendum and Your Privacy Choices back to October 14", () => {
    expect(LEGAL_UPDATED).toEqual({
      terms: "October 14, 2026",
      privacy: "October 28, 2026",
      dpa: "October 14, 2026",
      "privacy-choices": "October 14, 2026",
    });
    expect(LEGAL_LAST_UPDATED).toBe("October 28, 2026");
    expect(newestLegalUpdate(["terms", "dpa"])).toBe("October 14, 2026");
    expect(legalDateKey("October 8, 2026")).toBe("2026-10-08");
  });

  for (const doc of Object.keys(pages) as LegalDocument[]) {
    it(`/${doc} prints what its newest archived copy says`, () => {
      const html = renderToStaticMarkup(createElement(pages[doc]));
      expect(html).toContain(`<p class="mt-2 text-sm text-jp-muted">Last updated: ${LEGAL_UPDATED[doc]}</p>`);
      // Line endings as git gives them on Windows (CRLF) or elsewhere (LF).
      const copy = readFileSync(join(ROOT, "legal-archive", legalDateKey(LEGAL_LAST_UPDATED), `${doc}.md`), "utf8").replace(/\r\n/g, "\n");
      expect(copy).toContain(`\nLast updated: ${LEGAL_UPDATED[doc]}\n`);
    });
  }

  it("asks for a new acceptance with the date of the version being agreed to", () => {
    // Review: the Privacy Policy's October 28 change didn't need agreeing to again.
    expect(flat("app/accept-terms/page.tsx")).toContain("changed on ${legalDatePrinted(ACCEPTANCE_VERSION)}");
    expect(legalDatePrinted(ACCEPTANCE_VERSION)).toBe("October 14, 2026");
    expect(legalDatePrinted(ACCEPTANCE_VERSION)).toBe(LEGAL_UPDATED.terms);
  });

  it("puts the trademark notice on the Intuit sign-in page too", () => {
    expect(flat("app/login/intuit/page.tsx")).toContain("{TRADEMARK_NOTICE}");
  });
});

describe("W11. the home page FAQ states the trial's limits", () => {
  it("says what the trial includes, as the code grants it", () => {
    const home = flat("app/(marketing)/page.tsx");
    expect(home).toContain(
      "Yes, {TRIAL_DAYS} days with everything in Pro, plus the {PLANS.firm.name} plan&rsquo;s client logins, for up to {TRIAL_LIMITS.maxConnections} QuickBooks companies."
    );
    expect(home).not.toContain("full access to everything");
    expect(TRIAL_DAYS).toBe(14);
    expect(TRIAL_LIMITS.maxConnections).toBe(3);
    expect(TRIAL_LIMITS).toEqual(PLANS.profit_intelligence_pro.limits);
    // The trial's features are Firm's: everything in Pro plus client logins.
    expect(flat("lib/entitlements.ts")).toContain("const TRIAL_FEATURES: Feature[] = FIRM_FEATURES;");
    expect(PLAN_FEATURES.firm).toEqual([...PLAN_FEATURES.profit_intelligence_pro, "client_logins"]);
  });
});

describe("W12. grammar on the pricing page", () => {
  it("says an $80,000 contract", () => {
    const pricing = flat("app/(marketing)/pricing/page.tsx");
    expect(pricing).toContain("on an $80,000 contract");
    expect(pricing).not.toContain("a $80,000");
  });
});

describe("house style in the files this audit changed", () => {
  it("has no en or em dashes", () => {
    for (const f of [
      "lib/email/templates.ts",
      "lib/email/lifecycle.ts",
      "lib/legalVersion.ts",
      "lib/demoVideo.ts",
      "lib/plans.ts",
      "app/signup/page.tsx",
      "app/login/page.tsx",
      "app/quickbooks/disconnected/page.tsx",
      "app/accept-terms/page.tsx",
      "app/(marketing)/page.tsx",
      "app/(marketing)/pricing/page.tsx",
      "app/(marketing)/privacy/page.tsx",
      "app/(marketing)/terms/page.tsx",
      "app/(marketing)/dpa/page.tsx",
      "app/(marketing)/privacy-choices/page.tsx",
      "components/marketing/DemoVideo.tsx",
      "components/marketing/PlanGuide.tsx",
      "components/marketing/PricingCards.tsx",
      "components/marketing/Legal.tsx",
      "components/marketing/trademark.ts",
      "../legal-archive/README.md",
      "../legal-archive/2026-10-28/privacy.md",
    ]) {
      expect({ f, dashes: /[–—]/.test(read(f)) }).toEqual({ f, dashes: false });
    }
    expect(existsSync(join(ROOT, "legal-archive", "2026-10-28", "terms.md"))).toBe(true);
  });
});
