import Anthropic from "@anthropic-ai/sdk";
import type { ConnectionMetrics, DataHealthReport } from "./profitability";
import { computeConnectionMetrics } from "./profitability";
import { formatCurrency } from "./format";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You write a weekly job-cost digest email for a contractor who runs their business on QuickBooks Online.

Rules, no exceptions:
- Use ONLY the numbers provided in the JSON you're given. Never estimate, round persuasively, or invent a figure that isn't in the data.
- If a number is missing (e.g. no estimate on file for a job), say so plainly instead of guessing.
- Lead with the most consequential thing: the job losing the most money or furthest over budget, not an evenly-weighted summary of everything.
- Write like a sharp project manager talking to the owner, not like a BI dashboard. Plain English, specific dollar amounts, no jargon like "variance analysis."
- Every claim must be traceable to a field in the input JSON.
- Keep it skimmable: a short headline take, then 3-6 short paragraphs or bullet callouts for the jobs that matter, then a one-line closer.
- Do not give tax, legal, or accounting advice - only report what happened on these jobs.`;

export async function generateWeeklyDigest(
  metrics: ConnectionMetrics,
  companyName: string
): Promise<string> {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1200,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Company: ${companyName}
Week starting: ${metrics.weekStarting.toISOString().slice(0, 10)}

Here is this week's job-cost data. Write the digest email body (plain text, no HTML, no markdown headers - a few short paragraphs is fine):

${JSON.stringify(metrics, null, 2)}`,
      },
    ],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude did not return a text response for the digest.");
  }
  return textBlock.text;
}

// Confidence levels below which a Claude-written profitability narrative
// would be trying to characterize data that doesn't support it - see
// generateWeeklyDigestForConnection below.
const TOO_LOW_FOR_NARRATIVE = new Set<DataHealthReport["overallConfidence"]>(["low", "insufficient_data"]);

/**
 * Plain-English, entirely deterministic explanation of why this week's email
 * doesn't have a profitability take in it - used instead of calling Claude
 * when company-wide Data Confidence is "low" or "insufficient_data". No AI
 * involved: every sentence here is built directly from counts already on
 * DataHealthReport, same numbers the Data Health page shows. This mirrors
 * the "structured facts first, AI narrative only as a secondary layer -
 * never AI alone" rule already applied to the dashboard, taken to its
 * logical conclusion: when the data can't support a trustworthy narrative,
 * skip the narrative entirely rather than have AI editorialize around gaps.
 */
export function buildDataHealthDigestBody(dataHealth: DataHealthReport, companyName: string): string {
  const lines: string[] = [];
  lines.push(
    `We didn't write a profitability take for ${companyName} this week - there isn't enough complete data synced yet to say anything reliable about your job margins. Here's exactly what's missing:`
  );
  lines.push("");

  const bullet = (n: number | null, label: string) => {
    if (n == null) return null;
    if (n === 0) return null;
    return `- ${n} ${label}`;
  };

  const items = [
    bullet(dataHealth.jobsMissingEstimates.length, "job(s) with no cost estimate on file"),
    bullet(dataHealth.jobsMissingCosts.length, "job(s) with revenue but no costs recorded yet"),
    bullet(dataHealth.staleJobs.length, "open job(s) with no synced activity in 30+ days"),
    bullet(
      dataHealth.unassignedExpenseCount,
      `expense(s) not tagged to any customer${
        dataHealth.unassignedExpenseAmount ? ` (${formatCurrency(dataHealth.unassignedExpenseAmount)})` : ""
      }`
    ),
    bullet(
      dataHealth.unresolvedExpenseCount,
      `expense(s) tagged to a customer we don't recognize as one of your jobs${
        dataHealth.unresolvedExpenseAmount ? ` (${formatCurrency(dataHealth.unresolvedExpenseAmount)})` : ""
      }`
    ),
  ].filter((l): l is string => l != null);

  if (items.length > 0) {
    lines.push(...items);
  } else {
    lines.push("- Not enough jobs synced yet to compute company-wide numbers.");
  }

  lines.push("");
  lines.push(
    "Fix any of the above in QuickBooks (or set a target margin/estimate in Settings) and next week's email should come back with a real narrative. In the meantime, the full breakdown is always up to date on your Data Health page."
  );

  return lines.join("\n");
}

/**
 * Single entry point both the manual "Generate this week's digest" button
 * and the weekly-email cron job call, so the narrative-vs-Data-Health
 * decision lives in exactly one place. Computes metrics via the same
 * deterministic engine either way; only branches on whether to spend an AI
 * call on the narrative.
 */
export async function generateWeeklyDigestForConnection(
  connectionId: string,
  weekStarting: Date,
  companyName: string
): Promise<{ narrative: string; kind: "narrative" | "data_health"; metrics: ConnectionMetrics }> {
  const metrics = await computeConnectionMetrics(connectionId, weekStarting);

  if (TOO_LOW_FOR_NARRATIVE.has(metrics.dataHealth.overallConfidence)) {
    return { narrative: buildDataHealthDigestBody(metrics.dataHealth, companyName), kind: "data_health", metrics };
  }

  const narrative = await generateWeeklyDigest(metrics, companyName);
  return { narrative, kind: "narrative", metrics };
}
