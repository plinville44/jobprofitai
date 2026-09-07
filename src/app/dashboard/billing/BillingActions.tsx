"use client";

import { useState } from "react";
import type { PlanId } from "@/lib/plans";

/**
 * Buttons that start Stripe Checkout or open the Billing Portal.
 *
 * Both just ask the server for a URL and then navigate to it. No Stripe
 * keys, price IDs or card handling exist on the client at all - which is
 * what keeps card data entirely on Stripe's own domain.
 */

function useRedirectAction() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go(key: string, url: string, body?: unknown) {
    if (pending) return;
    setPending(key);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        setError(data.error ?? "Something went wrong. Please try again.");
        setPending(null);
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("We couldn't reach the server. Please check your connection and try again.");
      setPending(null);
    }
  }

  return { pending, error, go };
}

export function CheckoutButton({
  plan,
  label,
  variant = "primary",
  className = "",
}: {
  plan: PlanId;
  label: string;
  variant?: "primary" | "secondary";
  className?: string;
}) {
  const { pending, error, go } = useRedirectAction();
  const busy = pending === plan;

  const styles =
    variant === "primary"
      ? "bg-jp-blue text-white hover:bg-jp-navy"
      : "border border-jp-line bg-white text-jp-ink hover:border-jp-blue hover:text-jp-blue";

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => go(plan, "/api/billing/checkout", { plan })}
        disabled={busy}
        className={`inline-flex w-full items-center justify-center rounded-lg px-5 py-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${styles}`}
      >
        {busy ? "Opening secure checkout…" : label}
      </button>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ManageBillingButton({ label = "Manage Billing" }: { label?: string }) {
  const { pending, error, go } = useRedirectAction();
  const busy = pending === "portal";

  return (
    <div>
      <button
        type="button"
        onClick={() => go("portal", "/api/billing/portal")}
        disabled={busy}
        className="inline-flex items-center justify-center rounded-lg border border-jp-line bg-white px-5 py-2.5 text-sm font-semibold text-jp-ink transition-colors hover:border-jp-blue hover:text-jp-blue disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "Opening…" : label}
      </button>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
