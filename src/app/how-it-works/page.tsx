export default function HowItWorksPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-20">
      <h1 className="text-3xl font-bold text-navy">How it works</h1>
      <ol className="mt-8 space-y-6 text-gray-700">
        <li>
          <strong className="text-navy">1. Connect QuickBooks.</strong> Click
          &quot;Connect to QuickBooks,&quot; log into QuickBooks Online the same way you
          always do, and approve read-only access. Takes about two minutes.
        </li>
        <li>
          <strong className="text-navy">2. We sync your job data.</strong> Every job,
          estimate, cost, and invoice tied to a project or class in your QuickBooks
          company.
        </li>
        <li>
          <strong className="text-navy">3. You get a Monday digest.</strong> A short,
          plain-English email flagging which jobs are on track and which are bleeding
          margin — with real dollar amounts, not just percentages.
        </li>
      </ol>
      <p className="mt-10 text-sm text-gray-500">
        (Full pricing and product detail pages are being built out this week — check back soon.)
      </p>
    </main>
  );
}
