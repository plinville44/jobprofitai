"use client";

import { useId, useRef, useState } from "react";
import { CONTACT_REASONS } from "@/lib/contact";

type Status = "idle" | "submitting" | "success" | "error";

const inputClass =
  "w-full rounded-lg border border-jp-line bg-white px-3.5 py-2.5 text-[15px] text-jp-ink shadow-sm outline-none transition-colors placeholder:text-jp-muted focus:border-jp-blue focus:ring-2 focus:ring-jp-blue/20";

/**
 * Marketing contact form.
 *
 * Validation is duplicated deliberately: the browser's own `required` gives
 * instant feedback, but the API re-validates everything server-side, because
 * client validation is a convenience and never a control.
 */
export default function ContactForm() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const errorId = useId();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "submitting") return;

    setStatus("submitting");
    setError(null);

    const formData = new FormData(event.currentTarget);
    const payload = Object.fromEntries(formData.entries());

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(
          data?.error ??
            "Something went wrong sending your message. Please email support@jobprofitai.com."
        );
        setStatus("error");
        return;
      }

      formRef.current?.reset();
      setStatus("success");
    } catch {
      setError(
        "We couldn't reach the server. Please check your connection, or email support@jobprofitai.com."
      );
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <div
        role="status"
        className="rounded-xl border border-jp-green/30 bg-green-50/60 p-8 text-center"
      >
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-jp-green/15 text-jp-green">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
            <path
              d="M5.5 11.5l4 4 7-8"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-jp-ink">We received your message</h2>
        <p className="mx-auto mt-2 max-w-md text-[15px] leading-relaxed text-jp-slate">
          Thanks for contacting JobProfitAI. We&rsquo;ve sent a confirmation to your email address
          and will follow up as soon as possible.
        </p>
        <button
          type="button"
          onClick={() => setStatus("idle")}
          className="mt-5 text-sm font-medium text-jp-blue hover:underline"
        >
          Send another message
        </button>
      </div>
    );
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      noValidate={false}
      className="rounded-xl border border-jp-line bg-white p-6 sm:p-8"
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="contact-name" className="mb-1.5 block text-sm font-medium text-jp-ink">
            Name <span className="text-red-600">*</span>
          </label>
          <input
            id="contact-name"
            name="name"
            type="text"
            required
            maxLength={120}
            autoComplete="name"
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="contact-company" className="mb-1.5 block text-sm font-medium text-jp-ink">
            Company
          </label>
          <input
            id="contact-company"
            name="company"
            type="text"
            maxLength={160}
            autoComplete="organization"
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="contact-email" className="mb-1.5 block text-sm font-medium text-jp-ink">
            Email <span className="text-red-600">*</span>
          </label>
          <input
            id="contact-email"
            name="email"
            type="email"
            required
            maxLength={320}
            autoComplete="email"
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="contact-phone" className="mb-1.5 block text-sm font-medium text-jp-ink">
            Phone <span className="font-normal text-jp-muted">(optional)</span>
          </label>
          <input
            id="contact-phone"
            name="phone"
            type="tel"
            maxLength={40}
            autoComplete="tel"
            className={inputClass}
          />
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="contact-reason" className="mb-1.5 block text-sm font-medium text-jp-ink">
            Reason for contacting <span className="text-red-600">*</span>
          </label>
          <select id="contact-reason" name="reason" required defaultValue="" className={inputClass}>
            <option value="" disabled>
              Choose one&hellip;
            </option>
            {CONTACT_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {reason}
              </option>
            ))}
          </select>
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="contact-message" className="mb-1.5 block text-sm font-medium text-jp-ink">
            Message <span className="text-red-600">*</span>
          </label>
          <textarea
            id="contact-message"
            name="message"
            required
            rows={6}
            minLength={10}
            maxLength={5000}
            className={`${inputClass} resize-y`}
          />
        </div>
      </div>

      {/*
        Honeypot. Hidden from sight and from screen readers, and excluded
        from tab order, so no real person can fill it in - but it's a normal
        input in the DOM, which is what most naive bots fill.
      */}
      <div className="absolute h-0 w-0 overflow-hidden" aria-hidden="true">
        <label htmlFor="contact-website">Website</label>
        <input id="contact-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      {error ? (
        <p id={errorId} role="alert" className="mt-5 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <div className="mt-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        <button
          type="submit"
          disabled={status === "submitting"}
          aria-describedby={error ? errorId : undefined}
          className="inline-flex w-full items-center justify-center rounded-lg bg-jp-blue px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-jp-navy disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          {status === "submitting" ? (
            <>
              <svg
                className="mr-2 h-4 w-4 animate-spin"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
                <path d="M14.5 8A6.5 6.5 0 008 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              Sending&hellip;
            </>
          ) : (
            "Send message"
          )}
        </button>
        <p className="text-xs leading-relaxed text-jp-muted">
          We&rsquo;ll only use your details to reply to this enquiry.
        </p>
      </div>
    </form>
  );
}
