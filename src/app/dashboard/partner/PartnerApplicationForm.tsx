"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const inputClass =
  "w-full rounded-lg border border-gray-300 bg-white px-3.5 py-2.5 text-[15px] text-navy outline-none transition-colors placeholder:text-gray-400 focus:border-brand focus:ring-2 focus:ring-brand/20";

export default function PartnerApplicationForm() {
  const router = useRouter();
  const [values, setValues] = useState({
    firmName: "",
    contactName: "",
    phone: "",
    website: "",
    clientCountEstimate: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function set(key: keyof typeof values) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setValues((v) => ({ ...v, [key]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/partner/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "We couldn't submit your application. Please try again.");
        setLoading(false);
        return;
      }
      router.refresh();
    } catch {
      setError("We couldn't reach the server. Please check your connection and try again.");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="firmName" className="mb-1.5 block text-sm font-medium text-navy">
            Firm name <span className="text-red-600">*</span>
          </label>
          <input
            id="firmName"
            required
            maxLength={160}
            value={values.firmName}
            onChange={set("firmName")}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="contactName" className="mb-1.5 block text-sm font-medium text-navy">
            Your name <span className="text-red-600">*</span>
          </label>
          <input
            id="contactName"
            required
            maxLength={120}
            autoComplete="name"
            value={values.contactName}
            onChange={set("contactName")}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="phone" className="mb-1.5 block text-sm font-medium text-navy">
            Phone <span className="font-normal text-gray-500">(optional)</span>
          </label>
          <input
            id="phone"
            type="tel"
            maxLength={40}
            autoComplete="tel"
            value={values.phone}
            onChange={set("phone")}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="website" className="mb-1.5 block text-sm font-medium text-navy">
            Website <span className="font-normal text-gray-500">(optional)</span>
          </label>
          <input
            id="website"
            maxLength={200}
            placeholder="yourfirm.com"
            value={values.website}
            onChange={set("website")}
            className={inputClass}
          />
        </div>
        <div className="sm:col-span-2">
          <label
            htmlFor="clientCountEstimate"
            className="mb-1.5 block text-sm font-medium text-navy"
          >
            Roughly how many contractor clients do you work with?
          </label>
          <select
            id="clientCountEstimate"
            value={values.clientCountEstimate}
            onChange={set("clientCountEstimate")}
            className={inputClass}
          >
            <option value="">Prefer not to say</option>
            <option value="1-5">1–5</option>
            <option value="6-15">6–15</option>
            <option value="16-30">16–30</option>
            <option value="31-75">31–75</option>
            <option value="75+">75+</option>
          </select>
        </div>
      </div>

      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={loading}
        className="rounded-lg bg-navy px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Submitting…" : "Submit application"}
      </button>
      <p className="text-xs text-gray-500">
        Applications are reviewed by a person, usually within a couple of business days.
      </p>
    </form>
  );
}
