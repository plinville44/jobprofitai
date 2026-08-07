import Anthropic from "@anthropic-ai/sdk";
import type { ConnectionMetrics } from "./profitability";

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
