"use client";

import { useState } from "react";

/**
 * Copy-to-clipboard for a referral link.
 *
 * The clipboard API needs a secure context and can be blocked by permissions,
 * so the input next to it is always selectable as a fallback and a failed
 * copy says so rather than silently doing nothing.
 */
export default function CopyLinkButton({
  value,
  label = "Copy link",
  onCopiedLabel = "Copied",
}: {
  value: string;
  label?: string;
  onCopiedLabel?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
      setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("failed");
      setTimeout(() => setState("idle"), 3000);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={copy}
        className="inline-flex items-center gap-2 rounded-lg bg-navy px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-gray-800"
      >
        {state === "copied" ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M3.5 8.5l3 3 6-7"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M10.5 5.5v-1a1.5 1.5 0 00-1.5-1.5H4A1.5 1.5 0 002.5 4.5V9A1.5 1.5 0 004 10.5h1"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        )}
        {state === "copied" ? onCopiedLabel : label}
      </button>
      {state === "failed" ? (
        <p role="alert" className="mt-2 text-xs text-red-700">
          Your browser blocked the copy. Select the link and copy it manually.
        </p>
      ) : null}
      <span aria-live="polite" className="sr-only">
        {state === "copied" ? "Link copied to clipboard" : ""}
      </span>
    </div>
  );
}
