import Anthropic from "@anthropic-ai/sdk";

/**
 * The one Anthropic client and model name the app uses.
 *
 * The model comes from ANTHROPIC_MODEL so it can be changed in Vercel
 * without a code change when Anthropic retires one (they give at least 60
 * days' notice; see https://platform.claude.com/docs/en/about-claude/model-deprecations).
 * The default is a current Sonnet model. It was hard-coded as
 * claude-sonnet-4-5 in two files before, whose earliest retirement date is
 * Sept 29, 2026.
 */
export const AI_MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-5";

export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
