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
