import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Intuit's security and technical requirements for the QuickBooks App Store
// (developer.intuit.com: go-live, publish app). These tests hold the code to
// the parts a pre-review check found worth pinning down: caching off and the
// usual security headers, a cross-site check on every API call that changes
// something, the OAuth callback answering only with 302 redirects, no
// QuickBooks data in log lines, and no internal error text in responses.

vi.mock("next/server", () => ({
  NextResponse: {
    next: () => ({ kind: "next" }),
    json: (body: unknown, init?: { status?: number }) => ({ kind: "json", body, status: init?.status ?? 200 }),
  },
}));

import { isCrossSite, refusesCrossSiteChange } from "../sameOrigin";
import { proxy, config as proxyConfig } from "../../proxy";
import { installLogScrubbing, scrubLogArg, scrubLogText } from "../logScrub";
import { publicErrorMessage } from "../publicError";
import { safeErrorText } from "../monitoring";
import { register } from "../../instrumentation";

const SRC = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const headers = (h: Record<string, string>) => new Headers(h);

describe("response headers (next.config.mjs)", () => {
  async function rules() {
    const config = (await import("../../../next.config.mjs")).default as {
      poweredByHeader?: boolean;
      headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]>;
    };
    return { config, list: await config.headers() };
  }
  const value = (rule: { headers: { key: string; value: string }[] }, key: string) =>
    rule.headers.find((h) => h.key === key)?.value;

  it("turns caching off with no-cache and no-store (not just private) on every page and response, not on static files", async () => {
    const { list } = await rules();
    const noStore = list.find((r) => value(r, "Cache-Control"));
    expect(noStore).toBeDefined();
    const cc = value(noStore!, "Cache-Control")!;
    expect(cc).toContain("no-store");
    expect(cc).toContain("no-cache");
    expect(cc).not.toContain("private");
    expect(value(noStore!, "Pragma")).toBe("no-cache");
    // The source is "/:path(<pattern>)": check the pattern the way the router reads it.
    const pattern = /^\/:path\((.*)\)$/.exec(noStore!.source)![1];
    const matches = (path: string) => new RegExp(`^/${pattern}$`).test(path);
    for (const path of ["/", "/login", "/reset-password", "/dashboard/jobs/abc", "/api/wip/export", "/api/brief/unsubscribe", "/lp/wip", "/invite/abc"]) {
      expect({ path, noStore: matches(path) }).toEqual({ path, noStore: true });
    }
    for (const path of ["/_next/static/chunks/app.js", "/_next/image", "/demo-video-poster.jpg", "/intuit/connect-to-quickbooks.png", "/favicon.ico", "/robots.txt", "/sitemap.xml"]) {
      expect({ path, noStore: matches(path) }).toEqual({ path, noStore: false });
    }
  });

  it("sends the security headers on every path, and no Referer from one-time-link pages", async () => {
    const { config, list } = await rules();
    expect(config.poweredByHeader).toBe(false);
    const all = list.find((r) => r.source === "/:path*")!;
    expect(value(all, "X-Content-Type-Options")).toBe("nosniff");
    expect(value(all, "X-Frame-Options")).toBe("DENY");
    expect(value(all, "Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(value(all, "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    const noReferrer = list.filter((r) => value(r, "Referrer-Policy") === "no-referrer").map((r) => r.source);
    for (const source of ["/reset-password", "/verify-email", "/invite/:path*", "/quickbooks/:path*", "/api/brief/unsubscribe", "/api/email/tips-off"]) {
      expect({ source, noReferrer: noReferrer.includes(source) }).toEqual({ source, noReferrer: true });
    }
    // Later rules win, so the no-referrer ones must come after the site-wide one.
    expect(list.indexOf(all)).toBeLessThan(list.findIndex((r) => value(r, "Referrer-Policy") === "no-referrer"));
  });
});

describe("cross-site request forgery check (src/proxy.ts)", () => {
  const url = "https://jobprofitai.com/api/quickbooks/disconnect";
  process.env.APP_URL = "https://jobprofitai.com";

  it("refuses a change a browser marks as coming from another site", () => {
    expect(refusesCrossSiteChange("POST", "/api/quickbooks/disconnect", headers({ "sec-fetch-site": "cross-site" }), url)).toBe(true);
    expect(refusesCrossSiteChange("DELETE", "/api/team/remove", headers({ "sec-fetch-site": "same-site" }), url)).toBe(true);
    expect(refusesCrossSiteChange("PATCH", "/api/jobs/bulk", headers({ origin: "https://evil.example" }), url)).toBe(true);
    expect(refusesCrossSiteChange("POST", "/api/account/delete", headers({ origin: "null" }), url)).toBe(true);
  });

  it("lets our own pages, typed addresses and other servers through", () => {
    expect(refusesCrossSiteChange("POST", "/api/quickbooks/disconnect", headers({ "sec-fetch-site": "same-origin" }), url)).toBe(false);
    expect(refusesCrossSiteChange("POST", "/api/quickbooks/disconnect", headers({ origin: "https://jobprofitai.com" }), url)).toBe(false);
    // A preview deployment's own address counts as ours too.
    const preview = "https://jobprofitai-git-x.vercel.app/api/jobs/bulk";
    expect(refusesCrossSiteChange("PATCH", "/api/jobs/bulk", headers({ origin: "https://jobprofitai-git-x.vercel.app" }), preview)).toBe(false);
    // No browser headers at all: a server calling, not a forged browser request.
    expect(refusesCrossSiteChange("POST", "/api/feedback", headers({}), url)).toBe(false);
  });

  it("never touches reading, the webhook, the scheduled jobs or one-click unsubscribe", () => {
    const evil = headers({ "sec-fetch-site": "cross-site" });
    expect(refusesCrossSiteChange("GET", "/api/wip/export", evil, url)).toBe(false);
    expect(refusesCrossSiteChange("HEAD", "/api/wip/export", evil, url)).toBe(false);
    expect(refusesCrossSiteChange("POST", "/api/stripe/webhook", evil, url)).toBe(false);
    expect(refusesCrossSiteChange("POST", "/api/brief/unsubscribe", evil, url)).toBe(false);
    expect(refusesCrossSiteChange("POST", "/api/email/tips-off", evil, url)).toBe(false);
    expect(refusesCrossSiteChange("GET", "/api/cron/nightly-sync", evil, url)).toBe(false);
  });

  it("is what the proxy runs, on every API route, before the route", () => {
    // Every API route, except requests our own pages make (they can't be cross-site).
    expect(proxyConfig.matcher).toEqual([
      { source: "/api/:path*", missing: [{ type: "header", key: "sec-fetch-site", value: "same-origin" }] },
    ]);
    const req = (method: string, h: Record<string, string>) =>
      ({ method, nextUrl: { pathname: "/api/quickbooks/disconnect" }, headers: headers(h), url }) as never;
    expect(proxy(req("POST", { "sec-fetch-site": "cross-site" }))).toEqual({
      kind: "json",
      body: { error: "Please use the JobProfitAI site to do this." },
      status: 403,
    });
    expect(proxy(req("POST", { "sec-fetch-site": "same-origin" }))).toEqual({ kind: "next" });
    expect(isCrossSite(headers({ "sec-fetch-site": "none" }), [])).toBe(false);
  });
});

describe("the OAuth callback answers only with 302 redirects", () => {
  it("in /api/quickbooks/callback", () => {
    const route = read("app/api/quickbooks/callback/route.ts");
    expect(route).toContain("const found = (path: string) => NextResponse.redirect(appUrl(path), 302);");
    // The only NextResponse.redirect is inside found().
    expect(route.split("NextResponse.redirect(").length - 1).toBe(1);
    expect(route).not.toMatch(/new NextResponse\(|NextResponse\.json\(/);
  });

  it("in the Sign in with Intuit and App Store flows it hands off to, and the Launch URL", () => {
    const flow = read("lib/intuitSignIn.ts");
    expect(flow).toContain("const found = (url: URL | string) => NextResponse.redirect(url, 302);");
    expect(flow.split("NextResponse.redirect(").length - 1).toBe(1);
    expect(read("app/api/auth/intuit/route.ts")).toContain('NextResponse.redirect(new URL("/dashboard", process.env.APP_URL), 302)');
    const handler = flow.slice(flow.indexOf("export async function handleIntuitFlow"));
    expect(handler).not.toContain("NextResponse.redirect(");
    expect(handler).not.toMatch(/new NextResponse\(|NextResponse\.json\(/);
  });
});

describe("log lines carry no QuickBooks data, credentials or personal details", () => {
  it("scrubs an email's subject, amounts, addresses and tokens, and keeps our IDs and intuit_tid", () => {
    const line = scrubLogText(
      'email: send failed for "Example Builders: $10,200 of new margin risk" to owner@example.com, connection cm2abcdefghijklmnopqrstuv, token AB11730000000000abcDEF1234567890XYZ, intuit_tid: 1-6543abc-99'
    );
    expect(line).not.toContain("Example Builders");
    expect(line).not.toContain("10,200");
    expect(line).not.toContain("owner@example.com");
    expect(line).not.toContain("AB11730000000000abcDEF1234567890XYZ");
    expect(line).toContain("cm2abcdefghijklmnopqrstuv");
    expect(line).toContain("intuit_tid: 1-6543abc-99");
  });

  it("logs a database error as its code and call only, and leaves objects out", () => {
    const dbError = Object.assign(new Error("Invalid `prisma.costEntry.create()` invocation: { amount: 4260, memo: \"Kitchen for Alvarez\" }"), {
      name: "PrismaClientValidationError",
    });
    const logged = String(scrubLogArg(dbError));
    expect(logged).toContain("Database error");
    expect(logged).toContain("prisma.costEntry.create()");
    expect(logged).not.toContain("Alvarez");
    expect(logged).not.toContain("4260");
    expect(scrubLogArg({ realmId: "9130350000000000", companyName: "Example Builders" })).toBe("[Object left out of the log]");
    expect(scrubLogArg(42)).toBe(42);
    // Our own record IDs survive in an error's message, and Next.js's digest is kept.
    const withId = Object.assign(new Error("Connection cm2abcdefghijklmnopqrstuv not found"), { digest: "2345678901" });
    const line = String(scrubLogArg(withId));
    expect(line).toContain("Error: Connection cm2abcdefghijklmnopqrstuv not found (digest: 2345678901)");
    expect(safeErrorText(new TypeError("x is not a function"))).toBe("TypeError: x is not a function");
  });

  it("cuts a long line without leaving half an ID placeholder, and stays quick on hostile text", () => {
    const cut = scrubLogText("x ".repeat(997) + "cm2abcdefghijklmnopqrstuv end");
    expect(cut).not.toMatch(/[\u0000]|ID\d/);
    expect(cut.length).toBeLessThanOrEqual(2000);
    const started = Date.now();
    scrubLogText("a".repeat(25000) + "@" + "b".repeat(25000));
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("puts every console method through the scrub, once", () => {
    const seen: unknown[][] = [];
    const fake = {
      log: (...a: unknown[]) => seen.push(a),
      info: (...a: unknown[]) => seen.push(a),
      warn: (...a: unknown[]) => seen.push(a),
      error: (...a: unknown[]) => seen.push(a),
      debug: (...a: unknown[]) => seen.push(a),
    } as unknown as Console;
    installLogScrubbing(fake);
    installLogScrubbing(fake);
    fake.error('digest: "Torres Bath Remodel" lost $2,708');
    fake.log({ token: "secret" });
    expect(seen).toEqual([['digest: "[redacted]" lost [amount]'], ["[Object left out of the log]"]]);
  });

  it("is installed at server start in production only, not during a build or in tests", () => {
    const before = console.error;
    register();
    expect(console.error).toBe(before);
    const src = read("instrumentation.ts");
    expect(src).toContain('process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build"');
    expect(src).toContain("installLogScrubbing();");
  });
});

describe("routes don't send internal error text to the browser", () => {
  it("passes on messages written for people and nothing else", () => {
    const friendly = new Error("Your QuickBooks connection has expired or was disconnected on Intuit's side. Use Reconnect QuickBooks to restore it.");
    expect(publicErrorMessage(friendly, "Sync failed.")).toBe(friendly.message);
    const db = Object.assign(new Error("Unique constraint failed on the fields: (`id`)"), { name: "PrismaClientKnownRequestError" });
    expect(publicErrorMessage(db, "Sync failed.")).toBe("Sync failed.");
    expect(publicErrorMessage(new TypeError("Cannot read properties of undefined (reading 'id')"), "Sync failed.")).toBe("Sync failed.");
    expect(publicErrorMessage(new Error("Couldn't email owner@example.com"), "Sync failed.")).toBe("Sync failed.");
    expect(publicErrorMessage("boom", "Sync failed.")).toBe("Sync failed.");
    // Setting names, system and library messages stay out, even when nothing in them would be scrubbed.
    for (const message of [
      "TOKEN_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32`.",
      "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.",
      "Unsupported state or unable to authenticate data",
      "discovery document fetch failed: 503",
      "Intuit userinfo had no sub",
      "getaddrinfo ENOTFOUND oauth.platform.intuit.com",
      "QuickBooks API request failed with status 400.",
    ]) {
      expect({ message, shown: publicErrorMessage(new Error(message), "Sync failed.") }).toEqual({ message, shown: "Sync failed." });
    }
    // The app's own sentences for people, and its customer error classes, still get through.
    const sentence = "Couldn't read your QuickBooks chart of accounts, so nothing was changed. The next sync will try again.";
    expect(publicErrorMessage(new Error(sentence), "Sync failed.")).toBe(sentence);
    const busy = Object.assign(new Error("QuickBooks was temporarily unavailable (status 429, intuit_tid: 1-abc). It will be read again on the next sync."), {
      name: "QboTemporarilyUnavailableError",
    });
    expect(publicErrorMessage(busy, "Sync failed.")).toBe(busy.message);
  });

  it("is used by every route that used to answer with err.message", () => {
    for (const route of [
      "app/api/jobs/bulk/route.ts",
      "app/api/feedback/route.ts",
      "app/api/digest/generate/route.ts",
      "app/api/quickbooks/disconnect/route.ts",
      "app/api/quickbooks/sync/route.ts",
      "app/api/settings/profile/route.ts",
      "app/api/analysis/refresh/route.ts",
      "app/api/jobs/[jobId]/quickbooks-check/route.ts",
    ]) {
      const src = read(route);
      expect({ route, uses: src.includes("publicErrorMessage(err,") }).toEqual({ route, uses: true });
      expect({ route, raw: /error: err instanceof Error \? err\.message/.test(src) }).toEqual({ route, raw: false });
    }
  });
});

describe("house style", () => {
  it("uses no em or en dashes in the new files", () => {
    const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    for (const f of ["proxy.ts", "lib/logScrub.ts", "lib/publicError.ts", "lib/sameOrigin.ts", "lib/scrub.ts", "lib/__tests__/intuitReview.test.ts"]) {
      expect({ f, dash: DASHES.test(read(f)) }).toEqual({ f, dash: false });
    }
    expect(DASHES.test(readFileSync(join(SRC, "..", "next.config.mjs"), "utf8"))).toBe(false);
  });
});
