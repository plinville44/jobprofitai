// Deterministic guard rails around the AI-written part of the Weekly Profit
// Brief: what the model is given, and what comes back.
//
// The prompt asks for all of this. This makes it true whether or not the
// model listened, because the text goes straight into a customer's inbox.

/**
 * - Drops a leading "Subject:" line. Asked for a "headline take", the model
 *   sometimes writes itself an email subject, which then arrived as the
 *   first line of the body under the real subject.
 * - Drops a leading greeting ("Hi team,"), which reads oddly beneath a
 *   deterministic section.
 * - Replaces em and en dashes. House style is no dashes as punctuation in
 *   any copy; a spaced dash becomes a comma, a bare one (a range such as
 *   "Jan–Mar") becomes a hyphen.
 */
export function cleanDigestText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  while (lines.length > 0) {
    const first = lines[0].trim();
    if (first === "" || /^subject\s*:/i.test(first) || /^(hi|hello|hey|good (morning|afternoon))\b.*,$/i.test(first)) {
      lines.shift();
      continue;
    }
    break;
  }

  return lines
    .join("\n")
    .replace(/[ \t]+[—–][ \t]+/g, ", ")
    .replace(/[—–]/g, "-")
    .trim();
}

// --- Shaping what the model is given -----------------------------------

interface VarianceFields {
  status: string;
  estimatedCost: number | null;
  actualCost: number;
  varianceVsEstimate: number | null;
  varianceVsEstimatePct: number | null;
}

/**
 * Removes "under budget" from open jobs before the model ever sees it.
 *
 * Variance is costs minus estimate, so every job in progress starts deeply
 * negative and climbs toward zero as the work gets done. Handed that number,
 * the model wrote "You're actually $3,500 under budget on costs" about a job
 * that had simply not finished spending yet - the same defect as the job page
 * praising a job with no costs for being "$12,000 under the estimate".
 *
 * Only a completed job can come in under budget. An open job that has gone
 * OVER its estimate is already over, finished or not, so a positive variance
 * is kept. For an open job still inside its estimate, the variance is
 * replaced by how much of the estimate has been spent, which is the true
 * statement: "$8,000 spent of an $11,500 estimate".
 *
 * Done here, deterministically, because a prompt rule alone is a request.
 */
export function withoutOpenJobUnderspend<T extends VarianceFields>(
  job: T
): T & { spentOfEstimatePct?: number } {
  const stillInsideEstimate =
    job.status === "open" && job.varianceVsEstimate != null && job.varianceVsEstimate <= 0;
  if (!stillInsideEstimate) return job;
  return {
    ...job,
    varianceVsEstimate: null,
    varianceVsEstimatePct: null,
    ...(job.estimatedCost ? { spentOfEstimatePct: job.actualCost / job.estimatedCost } : {}),
  };
}
