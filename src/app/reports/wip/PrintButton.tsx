"use client";

/** Opens the browser's print dialog, where "Save as PDF" makes the file for the bank. */
export default function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-lg bg-navy px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
    >
      Print or save as PDF
    </button>
  );
}
