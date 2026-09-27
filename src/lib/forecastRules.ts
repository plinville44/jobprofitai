import type { ForecastResult, JobFinancials } from "./profitability";

/**
 * Whether a forecast is firm enough to warn about: the feed, Needs
 * Attention and the emailed alerts all use this. A forecast from a small
 * share of the contract billed isn't, and neither is one from billing when
 * the costs say the work is further along than the bills: that job is
 * probably under-billed, not over budget, and the two can't be told apart
 * without a percent complete.
 */
export function forecastIsActionable(f: JobFinancials, fc: ForecastResult | null | undefined): fc is ForecastResult & { forecastMarginPct: number; contractValue: number } {
  if (!fc?.available || fc.forecastMarginPct == null || fc.contractValue == null || fc.contractValue <= 0) return false;
  if (fc.confidence === "low") return false;
  if (fc.progressSource === "billing" && f.wip != null && f.wip.overUnderBilling < 0) return false;
  return true;
}
