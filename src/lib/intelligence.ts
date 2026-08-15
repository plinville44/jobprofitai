import Anthropic from "@anthropic-ai/sdk";
import type { ProfitOpportunity } from "./profitability";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Same grounding discipline as digest.ts: Claude only ever writes prose
// around numbers app code already computed. It never invents, rounds
// persuasively, or restates a dollar figure differently than it was given -
// and even so, every number in the model's response is discarded and
// replaced with the original deterministic value before anything is stored
// (see generateProfitInsights below) rather than trusted from the model's
// own output.
const SYSTEM_PROMPT = `You write "Profit Insight" cards for a contractor profitability app, one per input opportunity.

Rules, no exceptions:
- You will be given a JSON array of pre-computed opportunities. Each one already has its financial impact, confidence level, and the job IDs behind it decided by deterministic app code - you are NOT computing or verifying any of that.
- Your job is only to write two short pieces of prose per opportunity: "evidence" (1-2 sentences restating what the data shows, in plain English) and "recommendedAction" (1-2 sentences of concrete, practical advice a contractor could act on this week).
- Never state a dollar amount, percentage, or count that isn't already present in the input JSON for that opportunity. If you want to reference a number, copy it from the input exactly.
- Write like an experienced construction business advisor, not a BI tool. No jargon like "variance analysis" or "delta."
- Do not give tax, legal, or accounting advice.
- Return ONLY a JSON array, same length and same order as the input, each element: { "evidence": string, "recommendedAction": string }. No other text.`;

export interface ProfitInsightDraft {
  dimension: string;
  finding: string;
  evidence: string;
  financialImpact: number | null;
  recommendedAction: string;
  confidence: "high" | "medium" | "low";
  sourceJobIds: string[];
}

/**
 * Turns deterministic ProfitOpportunity rollups into the persisted
 * Finding/Evidence/Impact/Action/Confidence shape. Confidence, financial
 * impact, and sourceJobIds are never taken from the model - they're copied
 * straight from the opportunity app code already computed, both going into
 * the prompt AND when assembling the final result, so nothing Claude writes
 * can silently change a number. `finding` reuses the opportunity's own
 * `title` (already deterministic, already correct) rather than asking the
 * model to restate it. Returns [] without calling the model at all when
 * there are no opportunities - never spend an AI call summarizing nothing.
 */
export async function generateProfitInsights(
  opportunities: ProfitOpportunity[]
): Promise<ProfitInsightDraft[]> {
  if (opportunities.length === 0) return [];

  const input = opportunities.map((o) => ({
    type: o.type,
    title: o.title,
    description: o.description,
    financialImpact: o.financialImpact,
    confidence: o.confidence,
    jobCount: o.supportingJobIds.length,
  }));

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Here are this company's profit opportunities:\n\n${JSON.stringify(input, null, 2)}`,
      },
    ],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude did not return a text response for profit insights.");
  }

  let drafts: { evidence: string; recommendedAction: string }[];
  try {
    // Claude sometimes wraps JSON in a code fence despite instructions -
    // strip it defensively rather than fail the whole refresh over formatting.
    const cleaned = textBlock.text.trim().replace(/^```(?:json)?\n?/, "").replace(/```$/, "");
    drafts = JSON.parse(cleaned);
  } catch {
    throw new Error("Couldn't parse Claude's response for profit insights.");
  }
  if (!Array.isArray(drafts) || drafts.length !== opportunities.length) {
    throw new Error("Claude returned an unexpected number of profit insights.");
  }

  // All dimensions produced by computeProfitOpportunities today are
  // category-level rollups (see profitability.ts) - "customer"/"cost_category"
  // dimensions are reserved in the schema for opportunity types not built yet.
  return opportunities.map((o, i) => ({
    dimension: "job_category",
    finding: o.title,
    evidence: drafts[i].evidence,
    financialImpact: o.financialImpact,
    recommendedAction: drafts[i].recommendedAction,
    confidence: o.confidence,
    sourceJobIds: o.supportingJobIds,
  }));
}
