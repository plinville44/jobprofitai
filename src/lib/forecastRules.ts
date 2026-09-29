import type { ForecastResult, JobFinancials } from "./profitability";

/**
 * Below this share complete, a percent the contractor typed in is too small
 * to divide cost to date by. $30,000 of materials delivered on a job entered
 * as 10% complete projects to $300,000, when the materials were simply
 * bought early. Forecasts from it are low confidence (no feed item, no
 * alert), and the WIP schedule doesn't project the estimated total cost
 * from it.
 */
export const MIN_ENTERED_PERCENT_TO_PROJECT = 0.25;

/**
 * Whether a forecast is firm enough to warn about: the feed, Needs
 * Attention and the emailed alerts all use this. A forecast from a small
 * share of the contract billed isn't, nor one from a small percent complete
 * entered, and neither is one from billing when the costs say the work is
 * further along than the bills: that job is probably under-billed, not over
 * budget, and the two can't be told apart without a percent complete.
 */
export function forecastIsActionable(f: JobFinancials, fc: ForecastResult | null | undefined): fc is ForecastResult & { forecastMarginPct: number; contractValue: number } {
  if (!fc?.available || fc.forecastMarginPct == null || fc.contractValue == null || fc.contractValue <= 0) return false;
  if (fc.confidence === "low") return false;
  // Also set as low confidence where the forecast is made; checked here too
  // so a forecast built elsewhere can't slip past it.
  if (fc.progressSource === "manual" && fc.progress != null && fc.progress < MIN_ENTERED_PERCENT_TO_PROJECT) return false;
  if (fc.progressSource === "billing" && f.wip != null && f.wip.overUnderBilling < 0) return false;
  return true;
}
