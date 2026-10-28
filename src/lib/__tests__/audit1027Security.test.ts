import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { scrubText } from "../scrub";
import { scrubLogText } from "../logScrub";
import { aiErrorText } from "../ai";
import { SYNC_ERROR_FALLBACK, syncErrorForPeople } from "../syncProblem";
import { RECONNECT_REQUIRED_MESSAGE } from "../quickbooks";

/**
 * Made-up key-shaped strings, put together at run time so the file holds no
 * text a secret scanner reads as a real key (GitHub's push protection
 * refused one written out in full).
 */
const fakeKey = (...parts: string[]) => parts.join("");
const FAKE_STRIPE_SECRET = fakeKey("sk", "_live_", "51H", "abcdefghijklmnopqrstuvwxyz");
const FAKE_WEBHOOK_SECRET = fakeKey("wh", "sec_", "abcdefghijklmnopqrstuvwxyz123456");
const FAKE_RESTRICTED_KEY = fakeKey("rk", "_live_", "abcdefghijklmnopqrstuvwx");
const FAKE_RESEND_KEY = fakeKey("re", "_", "AbCdEfGhIjKlMnOpQrStUvWxYz123456");

// Fixes from the Oct 27, 2026 audit to what reaches logs, Sentry and the
// screen. One block per audit item, numbered as in the audit doc.

describe("SEC1: Settings shows a stored sync error only when it's written for people", () => {
  it("keeps the app's own messages, including the ones with the support address", () => {
    const tooLong =
      "Reading this company's QuickBooks history keeps running out of time, so some of its figures may be out of date. It's tried again once a day. If this hasn't cleared in a few days, email support@jobprofitai.com.";
    expect(syncErrorForPeople(tooLong)).toBe(tooLong);
    expect(syncErrorForPeople(RECONNECT_REQUIRED_MESSAGE)).toBe(RECONNECT_REQUIRED_MESSAGE);
    const classes = "Your jobs are set to come from QuickBooks Classes, but QuickBooks sent no classes. Nothing was changed.";
    expect(syncErrorForPeople(classes)).toBe(classes);
    const plain = "Couldn't read your QuickBooks chart of accounts, so nothing was changed. The next sync will try again.";
    expect(syncErrorForPeople(plain)).toBe(plain);
  });

  it("replaces database, library and key messages with a plain one", () => {
    for (const raw of [
      "Invalid `prisma.costEntry.upsert()` invocation:\n\nUnique constraint failed on the fields: (`id`)",
      "Unsupported state or unable to authenticate data",
      "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.",
      "QuickBooks API query failed with status 500",
      "Change Data Capture returned 1000 records, the most it sends",
      "getaddrinfo ENOTFOUND quickbooks.api.intuit.com",
    ]) {
      expect(syncErrorForPeople(raw)).toBe(SYNC_ERROR_FALLBACK);
    }
    expect(syncErrorForPeople(null)).toBeNull();
    expect(syncErrorForPeople("  ")).toBeNull();
  });
});

describe("SEC2 and E8: an AI failure says why, in words the scrub keeps", () => {
  const sdkError = (Cls: any, status: number, type: string, message: string) =>
    new Cls(status, { type: "error", error: { type, message } }, `${status} ${JSON.stringify({ type: "error", error: { type, message } })}`, {});

  it("reads status, Anthropic's error type and message from the SDK error, with no quotes", () => {
    const geo = sdkError(Anthropic.BadRequestError, 400, "invalid_request_error", "inference_geo is not supported for this model");
    expect(aiErrorText(geo)).toBe("400 invalid_request_error: inference_geo is not supported for this model");
    expect(scrubText(aiErrorText(geo))).toBe(aiErrorText(geo));
    const missing = sdkError(Anthropic.NotFoundError, 404, "not_found_error", 'model: "claude-old"');
    expect(aiErrorText(missing)).toBe("404 not_found_error: model: claude-old");
    // Before: the SDK's own message, whose JSON the scrub turned to "[redacted]".
    expect(scrubText(missing.message)).toContain("[redacted]");
  });

  it("keeps the type of an error that isn't the SDK's", () => {
    expect(aiErrorText(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(
      "TypeError: Cannot read properties of undefined (reading 'map')"
    );
    expect(aiErrorText(new Error("Claude did not return a text response for the digest (stop reason: refusal)."))).toBe(
      "Claude did not return a text response for the digest (stop reason: refusal)."
    );
    expect(aiErrorText("boom")).toBe("boom");
  });
});

describe("SEC3 to SEC5: the scrub stays quick, keeps what's needed to trace a failure, and leaks nothing at a cut", () => {
  it("stays quick on long runs of secret-like words (it took seconds)", () => {
    const started = Date.now();
    for (const hostile of ["key-".repeat(1000), "sig.".repeat(1000), "token_".repeat(700)]) {
      scrubText(hostile);
      scrubLogText(hostile);
    }
    expect(Date.now() - started).toBeLessThan(1000);
    expect(scrubText("api_key=abc123def and session_token=xyz")).toBe("api_key=[redacted] and session_token=[redacted]");
  });

  it("keeps Stripe's object IDs but still takes out keys", () => {
    const line = "stripe/webhook: processing customer.subscription.updated (evt_1QabcDEFghiJKLmn) failed for sub_1QabcDEFghiJKLmno";
    expect(scrubLogText(line)).toBe(line);
    expect(scrubText("Duplicate subscription sub_1QabcDEFghiJKLmno for cus_QabcDEF123")).toBe("Duplicate subscription sub_1QabcDEFghiJKLmno for cus_QabcDEF123");
    const keys = scrubText(`${FAKE_STRIPE_SECRET} ${FAKE_WEBHOOK_SECRET} ${FAKE_RESTRICTED_KEY}`);
    for (const k of [FAKE_STRIPE_SECRET, FAKE_WEBHOOK_SECRET, FAKE_RESTRICTED_KEY]) expect(keys).not.toContain(k.slice(0, 9));
  });

  it("leaves no half of a value at the cut", () => {
    // The text before the address shrinks when scrubbed (each amount becomes
    // "[amount]"... or longer), so a cut made before scrubbing used to leave
    // the first letters of the address, which no longer looked like one.
    // A long URL query (taken out whole) so that the cut, at four times the
    // length limit, falls inside the address that follows it.
    const query = "https://x.test/a?" + "q".repeat(1993 - 17);
    const text = `${query} by owner@example.com and key ${FAKE_STRIPE_SECRET}`;
    expect(text.slice(1994, 2000)).toBe("by own");
    const out = scrubText(text);
    expect(out).toBe("https://x.test/a by");
    expect(scrubLogText("y".repeat(10) + " " + "word ".repeat(1590) + "by owner@example.com")).not.toMatch(/\bow\b|owner/);
  });

  it("reduces a database error logged as text to the call that failed", () => {
    expect(scrubLogText("sync failed: Invalid `prisma.costEntry.upsert()` invocation:\n{ amount: 4200, memo: Smith }")).toBe(
      "sync failed: Database error in prisma.costEntry.upsert()"
    );
  });
});

describe("SEC2 follow-up: the AI routes keep Anthropic's reason in logs and Sentry", () => {
  it("rewrites an error Anthropic answered, and passes anything else through", async () => {
    const { aiErrorForReport } = await import("../ai");
    const { describeError } = await import("../scrub");
    class BadRequestError extends Error {
      status = 400;
      error = { type: "error", error: { type: "invalid_request_error", message: "inference_geo is not supported for this model" } };
      constructor() {
        super('400 {"type":"error","error":{"type":"invalid_request_error","message":"inference_geo is not supported for this model"}}');
        this.name = "BadRequestError";
      }
    }
    const reported = describeError(aiErrorForReport(new BadRequestError()));
    expect(reported.type).toBe("BadRequestError");
    expect(reported.value).toBe("400 invalid_request_error: inference_geo is not supported for this model");
    const db = Object.assign(new Error("Invalid `prisma.job.findMany()` invocation: something"), { name: "PrismaClientKnownRequestError", code: "P2002" });
    expect(aiErrorForReport(db)).toBe(db);
    expect(describeError(aiErrorForReport(db)).value).toBe("Database error P2002 in prisma.job.findMany()");
  });

  it("is used by the AI routes for the log line and the report", () => {
    for (const f of ["src/app/api/analysis/refresh/route.ts", "src/app/api/jobs/suggest-types/route.ts", "src/app/api/digest/generate/route.ts"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src).toContain("aiErrorText(err)");
      expect(src).toContain("reportError(aiErrorForReport(err)");
    }
  });
});

describe("E2 follow-up: the on-hold notice for a re-read still under way", () => {
  it("says nothing failed and nothing needs doing", async () => {
    const { briefOnHoldEmail } = await import("../email/templates");
    const waiting = briefOnHoldEmail("Acme", null, "https://x/settings", { failing: false });
    expect(waiting.text).toContain("hasn't finished yet");
    expect(waiting.text).toContain("There's nothing you need to do.");
    expect(waiting.text).not.toContain("couldn't bring");
    expect(waiting.text).not.toMatch(/[–—]/);
    const failing = briefOnHoldEmail("Acme", null, "https://x/settings");
    expect(failing.text).toContain("We couldn't bring Acme up to date");
  });

  it("is told by the weekly run whether the re-read is failing", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/cron/weekly-email/route.ts"), "utf8");
    expect(src).toMatch(/sendBriefOnHold\(\{[\s\S]*?failing,\s*\}\)/);
  });
});

describe("review of SEC2 to SEC5: what the scrub still takes out", () => {
  it("keeps the quotes on an error that isn't Anthropic's, so what's quoted is still taken out", () => {
    // JSON.parse on a model reply quotes the reply, which names a customer's job.
    const parse = new SyntaxError('Unexpected token S, "Smith Remodel 14 Elm St" is not valid JSON');
    expect(aiErrorText(parse)).toContain('"Smith Remodel 14 Elm St"');
    expect(scrubText(aiErrorText(parse))).not.toContain("Smith");
  });

  it("takes email addresses and query strings out before keeping Stripe IDs", () => {
    expect(scrubText("Sent to sub_contractors@ortizbuilders.com and cs_department@acme.com")).toBe("Sent to [email] and [email]");
    const url = scrubText("GET https://api.stripe.com/v1/customers/cus_ABCdef123456?name=Sam%20Ortiz failed");
    expect(url).toBe("GET https://api.stripe.com/v1/customers/cus_ABCdef123456 failed");
    // A Stripe ID at the end of a sentence is still kept.
    expect(scrubText("Webhook failed for sub_1PqRsTuVwXyZaBcDeFgHiJkL.")).toBe("Webhook failed for sub_1PqRsTuVwXyZaBcDeFgHiJkL.");
    // re_ is how Resend's API keys start, so it's no longer kept.
    expect(scrubText(`key ${FAKE_RESEND_KEY}`)).toBe("key [token]");
  });

  it("reduces a database error inside a transaction to the call", () => {
    expect(scrubText('Invalid `tx.referral.update()` invocation: { data: { email: "sam@x.com" } }')).toBe("Database error in tx.referral.update()");
  });

  it("doesn't let a quoted value through when the cut lands inside it", () => {
    const text = "b ".repeat(996) + '"Smith Kitchen Remodel for the Ortiz family" and more';
    const out = scrubText(text, 500);
    expect(out).not.toContain("Smith");
    expect(out.endsWith("...")).toBe(true);
  });

  it("keeps a long message with no spaces rather than cutting it to nothing", () => {
    const body = '{"customer":"Sam Ortiz","amount":12345,' + '"k":"v",'.repeat(400) + "}";
    const out = scrubText(body, 500);
    expect(out.length).toBe(500);
    expect(out).not.toContain("Sam");
  });
});

describe("review 2: a cut inside one long run leaves nothing of an address", () => {
  it("turns the whole run into [token]", () => {
    const out = scrubText("q".repeat(1990) + ".bob.smith@acme-builders.com and more", 500);
    expect(out).not.toContain("bob");
    expect(out).not.toContain("smith");
    expect(scrubText("note: " + "q".repeat(1990) + ".bob.smith@acme-builders.com", 500)).toBe("note: [token]");
  });
});
