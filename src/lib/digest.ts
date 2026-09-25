import { AI_MODEL, anthropic } from "./ai";
import type { ConnectionMetrics, DataHealthReport } from "./profitability";
import { computeConnectionMetrics } from "./profitability";
import { formatCurrency } from "./format";
import { prisma } from "./prisma";
import {
  computeWeekOverWeek,
  renderWeekOverWeek,
  weekOverWeekForModel,
  type WeekOverWeekReport,
} from "./weekOverWeek";
import { cleanDigestText, withoutOpenJobUnderspend } from "./digestText";

const SYSTEM_PROMPT = `You write the narrative part of a weekly job-cost email for a contractor who runs their business on QuickBooks Online.

What the data means. Read this before anything else:
- "jobs" are the jobs that matter now: every job still open, plus jobs with any activity in the last 90 days. Older finished jobs are left out on purpose.
- "jobs" and "totals" are JOB-TO-DATE figures: everything billed and spent on each job over its whole life. They are NOT this week's activity. Never say a job did something "this week" based on them, and never describe the totals as what "the week" produced.
- "estimatedRevenue" is the job's contract value. "overUnderBilling" (open jobs only) is billed to date minus the revenue earned by the work done so far: positive means billed ahead of the work, negative means work done that hasn't been billed yet. "percentComplete" is how far along the job is (0 to 1). "forecastMarginPct", when present, is the margin the job is on track to finish at.
- An open job's "marginPct" is margin to date and mostly reflects billing timing. Never call an open job unprofitable or below target from marginPct alone; use forecastMarginPct when it is there, and otherwise talk about spend against the estimate.
- "weekOverWeek" is the only source for what changed since the last brief. A deterministic "What changed" section built from it is shown to the reader directly above your text, word for word. Do not repeat it line by line. You may refer to it ("the new costs on Torres Kitchen above").
- If weekOverWeek.noComparisonReason is set, there is no previous brief to compare against. Do not speculate about what changed.

Accuracy rules, no exceptions:
- Use ONLY the numbers provided. Never estimate, round persuasively, or invent a figure. Every claim must be traceable to a field in the input.
- Over budget is not a loss. A job "lost money" only when its actual cost exceeds its actual revenue (marginPct below zero). A job that ran $6,600 over its estimate but still has a 28% margin went over budget and stayed profitable; say exactly that.
- Only a completed job can be under budget. An open job that has spent less than its estimate is not under budget, it is unfinished. Where an open job has spentOfEstimatePct instead of a variance, describe it as spend so far against the estimate ("$8,000 spent of an $11,500 estimate").
- Do not guess at causes. Say what the numbers show, not why they might be that way. If something looks worth checking, say what to check.
- There is one cost estimate per job and no estimate per category. costByCategory says where the money went, never which category ran over. Never say an overrun "came from" a category, or from all of them.
- If a number is missing (no estimate on file, for example), say so plainly instead of guessing.
- Do not give tax, legal, or accounting advice. Only report what happened on these jobs.

What to write:
- Lead with the most consequential thing for the owner: a job losing money if there is one, otherwise the job furthest over its estimate, otherwise the most important change since last week.
- Write like a sharp project manager talking to the owner. Plain English, specific dollar amounts, no jargon.
- 3 to 5 short paragraphs, then a one-line closer. When weekOverWeek shows no changes, keep it to 2 short paragraphs: the reader has seen these job-to-date figures before.
- Write about the jobs, not about the data. Never explain to the reader what kind of figures these are ("these are job-to-date totals") or restate that nothing changed; the section above already says so.

Format:
- Plain text only. No markdown, no headings, no bullets.
- No subject line, no greeting, no sign-off. Start with your first sentence.
- Do not use em dashes or en dashes. Use commas, colons or full stops.`;

export async function generateWeeklyDigest(
  metrics: ConnectionMetrics,
  companyName: string,
  weekOverWeek: WeekOverWeekReport
): Promise<string> {
  const inBrief = new Set(metrics.briefJobIds);
  const dh = metrics.briefDataHealth;
  const message = await anthropic.messages.create({
    model: AI_MODEL,
    max_tokens: 1200,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Company: ${companyName}
Week starting: ${metrics.weekStarting.toISOString().slice(0, 10)}

Job-to-date figures for the jobs that matter now, plus what changed since the previous brief. Write the narrative as described.

${JSON.stringify(
  {
    totals: metrics.totals,
    jobs: metrics.jobs.filter((j) => inBrief.has(j.jobId)).map(withoutOpenJobUnderspend),
    topConcerns: metrics.topConcerns.map(withoutOpenJobUnderspend),
    // Counts only. The full lists are on the Data Health page.
    dataHealth: {
      openJobsMissingEstimates: dh.jobsMissingEstimates.length,
      jobsWithRevenueButNoCosts: dh.jobsMissingCosts.length,
      untaggedJobCostsLast12Months: dh.untaggedJobCostCount,
      timeEntriesWithoutPayRate: dh.timeEntriesWithoutPayRate,
      possibleDuplicateCosts: dh.possibleDuplicates.length,
    },
    weekOverWeek: weekOverWeekForModel(weekOverWeek),
  },
  null,
  2
)}`,
      },
    ],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude did not return a text response for the digest.");
  }
  return cleanDigestText(textBlock.text);
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
  // What actually decides this email is sent: more than half of all jobs
  // have no calculable profit yet (see computeDataHealth). The notice used to
  // list other gaps instead, missing estimates and untagged expenses, which
  // don't affect that rating at all. A reader who fixed every item it named
  // got the same notice next week. So it now leads with the real reason and
  // names those jobs, then lists the other checks as secondary.
  const lines: string[] = [];
  const total = dataHealth.totalJobs;
  const without = dataHealth.jobsWithoutEnoughData;

  if (total === 0) {
    lines.push(
      `We didn't write a profitability summary for ${companyName} this week because there are no open or recently active jobs synced from QuickBooks yet. Once a job has invoices or costs on it, it shows up here.`
    );
    return lines.join("\n");
  }

  lines.push(
    `We didn't write a profitability summary for ${companyName} this week. ${without.length} of your ${total} open or recently active jobs don't have both revenue and costs in QuickBooks yet, so their profit can't be calculated, and a summary built on the rest would be misleading.`
  );
  lines.push("");
  lines.push("Jobs without enough data yet:");
  for (const job of without.slice(0, 8)) lines.push(`- ${job.jobName}: ${job.reason}`);
  if (without.length > 8) lines.push(`- and ${without.length - 8} more, listed on your Data Health page`);

  const bullet = (n: number | null, label: string) => (n == null || n === 0 ? null : `- ${n} ${label}`);
  const other = [
    bullet(dataHealth.jobsMissingEstimates.length, "open job(s) with no cost estimate on file"),
    bullet(dataHealth.staleJobs.length, "open job(s) with no synced activity in 30+ days"),
    bullet(dataHealth.completedJobsWithUnresolvedActivity.length, "completed job(s) with unresolved activity"),
    bullet(
      dataHealth.untaggedJobCostCount,
      `job cost(s) in the last 12 months not tagged to any job${
        dataHealth.untaggedJobCostAmount ? ` (${formatCurrency(dataHealth.untaggedJobCostAmount)})` : ""
      }`
    ),
    bullet(
      dataHealth.unresolvedExpenseCount,
      `expense(s) tagged to a customer we don't recognize as one of your jobs${
        dataHealth.unresolvedExpenseAmount ? ` (${formatCurrency(dataHealth.unresolvedExpenseAmount)})` : ""
      }`
    ),
    bullet(dataHealth.timeEntriesWithoutPayRate, "time entry(ies) from employees with no pay rate set in QuickBooks"),
    bullet(dataHealth.possibleDuplicates.length, "possible duplicate cost(s)"),
  ].filter((l): l is string => l != null);

  if (other.length > 0) {
    lines.push("");
    lines.push("Also worth a look, though these don't stop the summary:");
    lines.push(...other);
  }

  lines.push("");
  lines.push(
    "The summary comes back once most jobs have both invoices and costs in QuickBooks. That usually means tagging expenses and bills to the right Project. The full breakdown is always current on your Data Health page."
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
): Promise<{
  narrative: string;
  kind: "narrative" | "data_health";
  metrics: ConnectionMetrics & { weekOverWeek: ReturnType<typeof weekOverWeekForModel> };
  /** The written part alone (AI summary or Data Health notice), for the HTML email. */
  body: string;
  weekOverWeek: WeekOverWeekReport;
}> {
  const metrics = await computeConnectionMetrics(connectionId, weekStarting);

  // The comparison point is the most recent brief from an EARLIER week.
  // Strictly earlier, so regenerating this week's brief compares against
  // last week rather than against itself. If a week was skipped, this
  // compares against the last one that exists, and the section's heading
  // names that week so the gap is visible rather than implied away.
  const prior = await prisma.weeklyDigest.findFirst({
    where: { connectionId, weekStarting: { lt: weekStarting } },
    orderBy: { weekStarting: "desc" },
    select: { weekStarting: true, metrics: true },
  });
  const weekOverWeek = computeWeekOverWeek(prior, metrics);
  const changesSection = renderWeekOverWeek(weekOverWeek);

  // Stored with the snapshot. Next week's comparison only reads `jobs`, so
  // this is for the record: what the brief said changed, alongside the
  // figures it was computed from.
  const stored = { ...metrics, weekOverWeek: weekOverWeekForModel(weekOverWeek) };

  // The changes section goes on both kinds of brief. It is arithmetic on
  // stored numbers, so it stays trustworthy even in a week when the data is
  // too thin for the AI narrative to be.
  //
  // Judged on the jobs the brief is about, not on the company's whole
  // history: old jobs that were never fully tagged must not silence the
  // brief for jobs that are.
  if (TOO_LOW_FOR_NARRATIVE.has(metrics.briefDataHealth.overallConfidence)) {
    const body = buildDataHealthDigestBody(metrics.briefDataHealth, companyName);
    return { narrative: `${changesSection}\n\n${body}`, kind: "data_health", metrics: stored, body, weekOverWeek };
  }

  const body = await generateWeeklyDigest(metrics, companyName, weekOverWeek);
  return { narrative: `${changesSection}\n\n${body}`, kind: "narrative", metrics: stored, body, weekOverWeek };
}
