// Display formatting helpers.
//
// House style note: no em dashes anywhere in customer-facing copy. A plain
// hyphen stands in for "no value" in tables, and prose uses commas, colons
// or separate sentences instead.
// Exported so pages render the same placeholder as the formatters do. A page
// that writes its own literal drifts from this the moment the house style
// changes, which is exactly how a stray ", " ended up in a dozen tables.
export const NO_VALUE = "-";

export function formatCurrency(value: number | null | undefined): string {
  if (value == null) return NO_VALUE;
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function formatPct(fraction: number | null | undefined, digits = 1): string {
  if (fraction == null) return NO_VALUE;
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatDate(date: Date | null | undefined): string {
  if (!date) return NO_VALUE;
  return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const CATEGORY_LABELS: Record<string, string> = {
  labor: "Labor",
  materials: "Materials",
  subcontractor: "Subcontractors",
  equipment: "Equipment",
  overhead: "Overhead",
  other: "Other",
};
export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/**
 * How much evidence sits behind a finding or forecast.
 *
 * Says what the rating is based on rather than asking the reader to
 * interpret a grade. "Limited evidence" tells a contractor to treat a
 * finding as a lead worth checking; "High confidence" tells them nothing
 * about why.
 */
const CONFIDENCE_LABELS: Record<string, string> = {
  high: "Strong evidence",
  medium: "Some evidence",
  low: "Limited evidence",
  insufficient_data: "Not enough data",
};
export function confidenceLabel(confidence: string): string {
  return CONFIDENCE_LABELS[confidence] ?? confidence;
}

/**
 * How complete the QuickBooks data behind a job (or the whole company) is.
 *
 * Separate from confidenceLabel on purpose: this is a statement about the
 * customer's bookkeeping, not about how sure the software is. Every place
 * these labels appear also names the specific data that's missing, so the
 * label never has to carry the explanation on its own.
 */
const DATA_QUALITY_LABELS: Record<string, string> = {
  high: "Complete data",
  medium: "Some data missing",
  low: "Key data missing",
  insufficient_data: "Not enough data",
};
export function dataQualityLabel(confidence: string): string {
  return DATA_QUALITY_LABELS[confidence] ?? confidence;
}
