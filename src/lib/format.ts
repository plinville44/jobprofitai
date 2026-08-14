export function formatCurrency(value: number | null | undefined): string {
  if (value == null) return "—";
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function formatPct(fraction: number | null | undefined, digits = 1): string {
  if (fraction == null) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatDate(date: Date | null | undefined): string {
  if (!date) return "—";
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

const CONFIDENCE_LABELS: Record<string, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
  insufficient_data: "Insufficient data",
};
export function confidenceLabel(confidence: string): string {
  return CONFIDENCE_LABELS[confidence] ?? confidence;
}
