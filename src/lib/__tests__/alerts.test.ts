import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { hasCleared } from "../alerts";

const job = (over: Record<string, unknown> = {}) =>
  ({ status: "open", varianceVsEstimatePct: 0.12, targetMarginPct: 25, estimatedRevenue: 100_000, wip: null, ...over }) as any;

describe("hasCleared", () => {
  it("clears everything once the job is finished or gone", () => {
    expect(hasCleared("over_budget", job({ status: "closed" }), undefined)).toBe(true);
    expect(hasCleared("underbilled", undefined, undefined)).toBe(true);
  });

  it("re-arms over budget only once back within 5%, not while hovering near 10%", () => {
    expect(hasCleared("over_budget", job({ varianceVsEstimatePct: 0.09 }), undefined)).toBe(false);
    expect(hasCleared("over_budget", job({ varianceVsEstimatePct: 0.04 }), undefined)).toBe(true);
  });

  it("keeps an alert whose figure can't be worked out any more", () => {
    expect(hasCleared("over_budget", job({ varianceVsEstimatePct: null }), undefined)).toBe(false);
    expect(hasCleared("forecast_below_target", job(), undefined)).toBe(false);
    expect(hasCleared("forecast_below_target", job(), { available: false } as any)).toBe(false);
    expect(hasCleared("underbilled", job({ wip: null }), undefined)).toBe(false);
  });

  it("clears a forecast alert once the forecast is back at target", () => {
    expect(hasCleared("forecast_below_target", job(), { available: true, forecastMarginPct: 0.265 } as any)).toBe(true);
    expect(hasCleared("forecast_below_target", job(), { available: true, forecastMarginPct: 0.255 } as any)).toBe(false);
    expect(hasCleared("forecast_below_target", job(), { available: true, forecastMarginPct: 0.2 } as any)).toBe(false);
  });

  it("clears underbilling only once well under the raise threshold", () => {
    expect(hasCleared("underbilled", job({ wip: { overUnderBilling: -3000 } }), undefined)).toBe(false);
    expect(hasCleared("underbilled", job({ wip: { overUnderBilling: -2000 } }), undefined)).toBe(true);
  });
});
