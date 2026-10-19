import Anthropic from "@anthropic-ai/sdk";

/**
 * The Anthropic clients and model name the app uses.
 *
 * The model comes from ANTHROPIC_MODEL so it can be changed in Vercel
 * without a code change when Anthropic retires one (they give at least 60
 * days' notice; see https://platform.claude.com/docs/en/about-claude/model-deprecations).
 * The default is a current Sonnet model. It was hard-coded as
 * claude-sonnet-4-5 in two files before, whose earliest retirement date is
 * Sept 29, 2026.
 */
export const AI_MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-5";

/**
 * A client whose requests give up after `timeoutMs`, tried at most
 * 1 + `maxRetries` times.
 *
 * The SDK's own default is a 10 minute timeout with 2 retries, far past the
 * time limit of every route that calls it, so a stalled request ran until
 * the platform killed the whole function: the customer's button got a
 * platform error page, and the weekly brief run lost every company it was
 * working on. Each caller picks limits that fit inside its own route.
 */
export function aiClient(timeoutMs: number, maxRetries = 1): Anthropic {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: timeoutMs, maxRetries });
}

/**
 * For requests someone is waiting on (Profit Insights, job type
 * suggestions). Their routes allow 120 seconds; two tries of 55 seconds fit
 * inside that with room for the database work around them. A reply of a few
 * thousand tokens takes well under a minute.
 */
export const anthropic = aiClient(55_000, 1);

/**
 * Where Anthropic runs our requests. By default Anthropic may route API
 * traffic to data centers in the US, Europe, Asia or Australia; "us" keeps
 * inference on US infrastructure (Anthropic's inference_geo, priced at 1.1x).
 * The Privacy Policy (sections 4 and 10) says the AI processing happens in
 * the US, so every call goes through inUs(). It needs a Claude 4.6 or later
 * model: an older ANTHROPIC_MODEL makes Anthropic refuse the request.
 * See https://platform.claude.com/docs/en/manage-claude/data-residency
 */
export const INFERENCE_GEO = "us" as const;

/**
 * The request's parameters with inference_geo set. The installed SDK
 * predates the field and sends unknown fields through as they are. Typed as
 * the SDK's own parameters so the request is still checked.
 */
export function inUs(params: Anthropic.MessageCreateParamsNonStreaming): Anthropic.MessageCreateParamsNonStreaming {
  return { ...params, inference_geo: INFERENCE_GEO } as Anthropic.MessageCreateParamsNonStreaming;
}

/**
 * How an AI request failed, read from the error's shape rather than the
 * SDK's classes:
 *  - "timeout": no answer in the time the request was given.
 *  - "connection": the request never got an answer (the network, a dropped
 *    connection).
 *  - "refused": Anthropic answered with a 4xx. A bad request (an
 *    ANTHROPIC_MODEL too old for inference_geo), a key that doesn't work, a
 *    model that doesn't exist: trying again won't help, and someone needs
 *    to know.
 *  - "other": overloaded, a server error, or a reply that couldn't be used.
 */
export function aiFailureKind(err: unknown): "timeout" | "connection" | "refused" | "other" {
  if (err === null || typeof err !== "object") return "other";
  const e = err as { name?: unknown; status?: unknown; message?: unknown; constructor?: { name?: unknown } };
  const name = [e.name, e.constructor?.name].filter((n): n is string => typeof n === "string").join(" ");
  const message = typeof e.message === "string" ? e.message : "";
  const status = typeof e.status === "number" ? e.status : null;
  if (/ConnectionTimeout|TimeoutError/.test(name) || status === 408 || (status == null && /timed? ?out/i.test(message))) return "timeout";
  if (/APIConnectionError/.test(name) || (status == null && /^connection error|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message))) {
    return "connection";
  }
  if (status != null && status >= 400 && status < 500) return "refused";
  return "other";
}
