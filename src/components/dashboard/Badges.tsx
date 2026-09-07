import { confidenceLabel, dataQualityLabel } from "@/lib/format";

// Per the design spec: green=healthy, yellow=watch, red=needs attention, but
// never color alone. Every badge here pairs color with a text label (and a
// small glyph), so meaning survives for colorblind users and in any
// black-and-white printout.

/**
 * How complete a job's underlying QuickBooks data is.
 *
 * Deliberately NOT labelled "confidence". This badge answers "have we been
 * given enough to work with?", which is a question about the customer's
 * bookkeeping, and a contractor reading "Medium confidence" has no idea
 * whether that means the software is unsure of itself or their data has a
 * gap. The labels below name the actual condition, and every place this
 * badge appears also says which specific data is missing.
 */
export function DataQualityBadge({ confidence }: { confidence: string }) {
  const styles: Record<string, string> = {
    high: "bg-green-50 text-green-800 border-green-200",
    medium: "bg-amber-50 text-amber-800 border-amber-200",
    low: "bg-orange-50 text-orange-800 border-orange-200",
    insufficient_data: "bg-gray-100 text-gray-600 border-gray-200",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
        styles[confidence] ?? styles.insufficient_data
      }`}
    >
      {dataQualityLabel(confidence)}
    </span>
  );
}

/**
 * How much evidence sits behind a finding or a forecast.
 *
 * A genuinely different question from data completeness, which is why it's a
 * separate component with separate wording. "Strong evidence" says what the
 * rating is actually based on (how many comparable jobs, how much history)
 * rather than asking the reader to interpret a confidence grade.
 */
export function ConfidenceBadge({ confidence }: { confidence: string }) {
  const styles: Record<string, string> = {
    high: "bg-green-50 text-green-800 border-green-200",
    medium: "bg-amber-50 text-amber-800 border-amber-200",
    low: "bg-gray-100 text-gray-600 border-gray-200",
    insufficient_data: "bg-gray-100 text-gray-600 border-gray-200",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
        styles[confidence] ?? styles.insufficient_data
      }`}
    >
      {confidenceLabel(confidence)}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: "high" | "medium" | "low" }) {
  const config = {
    high: { label: "Needs attention", cls: "bg-red-50 text-red-800 border-red-200", glyph: "●" },
    medium: { label: "Watch", cls: "bg-amber-50 text-amber-800 border-amber-200", glyph: "●" },
    low: { label: "Minor", cls: "bg-gray-100 text-gray-600 border-gray-200", glyph: "●" },
  }[severity];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${config.cls}`}
    >
      <span aria-hidden>{config.glyph}</span> {config.label}
    </span>
  );
}

// "unmeasured" is distinct from "good" on purpose. A metric QuickBooks
// hasn't given us data for yet is not the same claim as "checked, zero
// issues," and conflating the two would be exactly the false precision the
// whole data-quality system exists to avoid.
export function StatusDot({ status }: { status: "good" | "warning" | "critical" | "unmeasured" }) {
  const color = { good: "#0ca30c", warning: "#fab219", critical: "#d03b3b", unmeasured: "#898781" }[
    status
  ];
  return <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} aria-hidden />;
}
