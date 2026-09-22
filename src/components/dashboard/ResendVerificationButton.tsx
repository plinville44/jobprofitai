"use client";

import { useState } from "react";

/**
 * Sends a fresh verification link to the signed-in account's address.
 * Used by the dashboard banner and by the verify page's error states.
 */
export default function ResendVerificationButton({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function resend() {
    setState("sending");
    setMessage(null);
    try {
      const res = await fetch("/api/auth/verify-email/resend", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setState("sent");
        setMessage(
          data?.alreadyVerified
            ? "Your email is already confirmed. Refresh the page."
            : `Sent. Check ${data?.email ?? "your inbox"}, and your spam folder.`
        );
      } else {
        setState("error");
        setMessage(data?.error ?? `Couldn't send (status ${res.status}). Try again in a minute.`);
      }
    } catch {
      setState("error");
      setMessage("Network error. Try again in a minute.");
    }
  }

  return (
    <span className={compact ? "inline-flex flex-wrap items-center gap-2" : "block"}>
      <button
        type="button"
        onClick={resend}
        disabled={state === "sending" || state === "sent"}
        className={
          compact
            ? "font-semibold text-amber-900 underline underline-offset-2 hover:text-amber-950 disabled:no-underline disabled:opacity-70"
            : "rounded-lg bg-jp-blue px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
        }
      >
        {state === "sending" ? "Sending..." : state === "sent" ? "Link sent" : "Send a new link"}
      </button>
      {message && (
        <span className={compact ? "text-amber-900" : "mt-2 block text-sm text-jp-slate"}>{message}</span>
      )}
    </span>
  );
}
