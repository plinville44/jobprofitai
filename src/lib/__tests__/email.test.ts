import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));

// Stand in for the Resend SDK. Deliberately mirrors the real v3 contract:
// send() RESOLVES with `{ data, error }` and does NOT throw on an API error.
// That shape is the whole reason the email client checks the returned error -
// code that only try/catches would count a rejected send as a success.
const sent: { to: unknown; subject: string; replyTo?: string }[] = [];
let nextError: { message: string } | null = null;

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (payload: any) => {
        if (nextError) {
          const err = nextError;
          nextError = null;
          return { data: null, error: err };
        }
        // The wire field is `reply_to` in the v3 SDK; asserting on the
        // provider's spelling is the point, since that is what a wrong name
        // would silently break.
        sent.push({ to: payload.to, subject: payload.subject, replyTo: payload.reply_to });
        return { data: { id: `msg_${sent.length}` }, error: null };
      },
    };
  },
}));

import { hasSentLifecycleEmail, sendEmail, sendLifecycleEmail } from "../email/client";

const BASE = {
  to: "owner@example.com",
  subject: "Your trial is ending",
  html: "<p>hi</p>",
  text: "hi",
};

beforeEach(() => {
  fake.client = createFakePrisma();
  sent.length = 0;
  nextError = null;
  process.env.RESEND_API_KEY = "re_test_key";
  delete process.env.EMAIL_DEV_REDIRECT;
});

describe("sendEmail", () => {
  it("treats a returned Resend error as a failure, not a success", async () => {
    nextError = { message: "Domain is not verified" };

    const result = await sendEmail(BASE);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Domain is not verified");
    expect(sent).toHaveLength(0);
  });

  it("defaults Reply-To to the support address", async () => {
    await sendEmail(BASE);
    expect(sent[0].replyTo).toBe("support@jobprofitai.com");
  });

  it("skips cleanly, without throwing, when no API key is configured", async () => {
    delete process.env.RESEND_API_KEY;

    const result = await sendEmail(BASE);

    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("honours the development redirect safeguard", async () => {
    process.env.EMAIL_DEV_REDIRECT = "dev@example.com";

    await sendEmail(BASE);

    expect(sent[0].to).toEqual(["dev@example.com"]);
    expect(sent[0].subject).toContain("[dev->owner@example.com]");
  });
});

describe("lifecycle email is sent at most once per dedupe key", () => {
  const lifecycle = {
    ...BASE,
    userId: "u1",
    emailType: "trial_ending_soon",
    dedupeKey: "trial_ending:u1:2026-03-15",
  };

  it("sends the first time and skips every repeat", async () => {
    const first = await sendLifecycleEmail(lifecycle);
    const second = await sendLifecycleEmail(lifecycle);
    const third = await sendLifecycleEmail(lifecycle);

    expect(first.ok).toBe(true);
    expect(first.skipped).toBeUndefined();
    expect(second.skipped).toBe(true);
    expect(third.skipped).toBe(true);
    expect(sent).toHaveLength(1);
    expect(await hasSentLifecycleEmail(lifecycle.dedupeKey)).toBe(true);
  });

  /** An hourly cron re-running must not re-mail everyone. */
  it("stays quiet across repeated cron-style invocations", async () => {
    for (let i = 0; i < 24; i++) await sendLifecycleEmail(lifecycle);
    expect(sent).toHaveLength(1);
    expect(await fake.client.emailEvent.count({ where: { status: "sent" } })).toBe(1);
  });

  it("survives concurrent invocations", async () => {
    await Promise.all([
      sendLifecycleEmail(lifecycle),
      sendLifecycleEmail(lifecycle),
      sendLifecycleEmail(lifecycle),
    ]);
    expect(sent).toHaveLength(1);
  });

  /**
   * The dedupe key encodes the lifecycle instant, so extending a trial to a
   * new end date legitimately allows one more "ending soon" email.
   */
  it("allows a new send when the lifecycle instant genuinely changes", async () => {
    await sendLifecycleEmail(lifecycle);
    await sendLifecycleEmail({ ...lifecycle, dedupeKey: "trial_ending:u1:2026-03-29" });

    expect(sent).toHaveLength(2);
  });

  it("records the provider message id for a successful send", async () => {
    await sendLifecycleEmail(lifecycle);
    const row = await fake.client.emailEvent.findUnique({
      where: { dedupeKey: lifecycle.dedupeKey },
    });
    expect(row.providerMessageId).toBe("msg_1");
    expect(row.status).toBe("sent");
  });

  /**
   * A transient provider failure must not permanently burn the key - one bad
   * minute at Resend shouldn't cost a customer their trial-ending email.
   */
  it("releases the key after a failure so the next run retries", async () => {
    nextError = { message: "Rate limited" };
    const failed = await sendLifecycleEmail(lifecycle);

    expect(failed.ok).toBe(false);
    expect(await hasSentLifecycleEmail(lifecycle.dedupeKey)).toBe(false);

    const retry = await sendLifecycleEmail(lifecycle);
    expect(retry.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("keeps a failure audit row so delivery problems stay visible", async () => {
    nextError = { message: "Domain is not verified" };
    await sendLifecycleEmail(lifecycle);

    const failures = await fake.client.emailEvent.findMany({ where: { status: "failed" } });
    expect(failures).toHaveLength(1);
    expect(failures[0].errorMessage).toBe("Domain is not verified");
    expect(failures[0].dedupeKey).toContain("failed:");
  });
});
