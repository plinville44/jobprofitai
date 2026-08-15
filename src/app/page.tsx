import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-20">
      <nav className="mb-16 flex items-center justify-between">
        <span className="text-lg font-bold text-navy">JobProfitAI</span>
        <div className="flex gap-4 text-sm">
          <Link href="/login" className="px-3 py-2 text-navy hover:text-brand">
            Log in
          </Link>
          <Link
            href="/signup"
            className="rounded-lg bg-brand px-4 py-2 font-semibold text-white hover:bg-blue-700"
          >
            Start free trial
          </Link>
        </div>
      </nav>

      <section className="text-center">
        <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-brand">
          For contractors on QuickBooks Online
        </p>
        <h1 className="mx-auto max-w-3xl text-4xl font-bold leading-tight text-navy sm:text-5xl">
          Know which jobs are bleeding margin, every Monday, before it&apos;s too late.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-gray-600">
          Connect QuickBooks in two minutes. Every week, get a plain-English digest
          that flags cost overruns, thin margins, and jobs to watch — written by AI,
          grounded in your real numbers.
        </p>
        <div className="mt-8 flex justify-center gap-4">
          <Link
            href="/signup"
            className="rounded-lg bg-brand px-6 py-3 font-semibold text-white hover:bg-blue-700"
          >
            Start your free trial
          </Link>
          <Link
            href="/how-it-works"
            className="rounded-lg border border-gray-300 px-6 py-3 font-semibold text-navy hover:bg-gray-50"
          >
            See how it works
          </Link>
        </div>
      </section>

      <section className="mt-24 grid gap-8 sm:grid-cols-3">
        {[
          {
            title: "Sits on top of QuickBooks",
            body: "No rip-and-replace. Connect your existing QuickBooks Online company in two minutes.",
          },
          {
            title: "Written, not just dashboarded",
            body: "A short weekly email that tells you what happened and why — not another dashboard to check.",
          },
          {
            title: "Grounded in your numbers",
            body: "Every callout in the digest traces back to a real transaction in your QuickBooks data.",
          },
        ].map((f) => (
          <div key={f.title} className="rounded-xl border border-gray-200 p-6">
            <h3 className="font-semibold text-navy">{f.title}</h3>
            <p className="mt-2 text-sm text-gray-600">{f.body}</p>
          </div>
        ))}
      </section>

      <footer className="mt-24 flex flex-wrap items-center justify-between gap-4 border-t border-gray-200 pt-8 text-sm text-gray-500">
        <span>&copy; {new Date().getFullYear()} PWL Solutions LLC</span>
        <div className="flex gap-6">
          <Link href="/privacy" className="hover:text-brand">
            Privacy Policy
          </Link>
          <Link href="/terms" className="hover:text-brand">
            Terms of Service
          </Link>
        </div>
      </footer>
    </main>
  );
}
