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
 *  - "refused": Anthropic turned the request down (400, 401, 403, 404,
 *    413, 422). A bad request (an ANTHROPIC_MODEL too old for
 *    inference_geo), a key that doesn't work, a model that doesn't exist:
 *    trying again won't help, and someone needs to know.
 *  - "transient": a rate limit (429), overloaded (529) or another server
 *    error. Trying again later can work.
 *  - "other": anything else, such as a failure with no status.
 */
export type AiFailureKind = "timeout" | "connection" | "refused" | "transient" | "other";

/** Statuses that mean the request itself was turned down, whatever the time. */
const REFUSED_STATUSES = new Set([400, 401, 403, 404, 413, 422]);

/**
 * What an AI request's failure says, in words that survive the scrub on logs
 * and Sentry (src/lib/scrub.ts). The SDK puts Anthropic's reply in the
 * message as JSON ("404 {"type":"error","error":{"type":"not_found_error",
 * "message":"model: ..."}}"), and the scrub replaces every quoted value, so
 * the reason a summary failed reached neither the logs nor Sentry (audit
 * Oct 27, SEC2 and E8). Built from the error's fields instead, with no
 * quotes: status, Anthropic's error type and its message. Anthropic's own
 * messages carry no customer data. Errors that aren't the SDK's keep their
 * type ("TypeError: ...") and their quotes.
 */
export function aiErrorText(err: unknown): string {
  if (err === null || typeof err !== "object") return String(err ?? "Unknown error");
  const e = err as { name?: unknown; status?: unknown; message?: unknown; error?: unknown; constructor?: { name?: unknown } };
  const unquote = (s: string) => s.replace(/["“”]/g, "").replace(/\s+/g, " ").trim();
  const body = e.error && typeof e.error === "object" ? (e.error as { error?: unknown; type?: unknown; message?: unknown }) : null;
  const inner = body?.error && typeof body.error === "object" ? (body.error as { type?: unknown; message?: unknown }) : body;
  const type = typeof inner?.type === "string" && inner.type !== "error" ? inner.type : null;
  const detail = typeof inner?.message === "string" ? inner.message : null;
  if (typeof e.status === "number" && (type || detail)) {
    return unquote([String(e.status), type, detail].filter(Boolean).join(" ").replace(/^(\d+) (\w+) /, "$1 $2: "));
  }
  // Anything else keeps its quotes, so the scrub still takes out what's
  // inside them: a JSON.parse error on the model's reply quotes the reply
  // ("Smith Kitc..."), which is customer data (review of audit Oct 27, SEC2).
  const message = typeof e.message === "string" ? e.message : "Unknown error";
  const name = typeof e.name === "string" ? e.name : typeof e.constructor?.name === "string" ? e.constructor.name : "";
  return name && name !== "Error" && !message.startsWith(name) ? `${name}: ${message}` : message;
}

/**
 * The error to report for a failed AI request: the same kind of error, with
 * aiErrorText as its message, so the reason survives the scrub on its way to
 * Sentry. Only an error Anthropic answered (it has a status) is rewritten:
 * anything else, a database error say, is passed through as it is, so the
 * report keeps its own rules (a database error's code, see describeError).
 */
export function aiErrorForReport(err: unknown): unknown {
  if (err === null || typeof err !== "object" || typeof (err as { status?: unknown }).status !== "number") return err;
  const e = err as { name?: unknown; stack?: unknown; constructor?: { name?: unknown } };
  const out = new Error(aiErrorText(err));
  const name = typeof e.name === "string" && e.name !== "Error" ? e.name : typeof e.constructor?.name === "string" ? e.constructor.name : "Error";
  out.name = name;
  if (typeof e.stack === "string") out.stack = e.stack;
  return out;
}

export function aiFailureKind(err: unknown): AiFailureKind {
  if (err === null || typeof err !== "object") return "other";
  const e = err as { name?: unknown; status?: unknown; message?: unknown; constructor?: { name?: unknown } };
  const name = [e.name, e.constructor?.name].filter((n): n is string => typeof n === "string").join(" ");
  const message = typeof e.message === "string" ? e.message : "";
  const status = typeof e.status === "number" ? e.status : null;
  if (/ConnectionTimeout|TimeoutError/.test(name) || status === 408 || (status == null && /timed? ?out/i.test(message))) return "timeout";
  if (/APIConnectionError/.test(name) || (status == null && /^connection error|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message))) {
    return "connection";
  }
  if (status != null && REFUSED_STATUSES.has(status)) return "refused";
  if (status != null && (status === 429 || status >= 500)) return "transient";
  return "other";
}
