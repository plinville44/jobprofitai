import { SUPPORT_EMAIL } from "./client";

// Branded transactional email templates.
//
// Every message is built from the same small set of blocks below rather than
// hand-written HTML per email, so the branding stays consistent and a change
// to the shell (logo, footer, colours) applies everywhere at once.
//
// Constraints these are written against, which is why the markup looks
// dated: email clients (Outlook especially) don't reliably support flexbox,
// grid, or external CSS, so this uses tables, inline styles, and a
// single-column layout that degrades gracefully to a narrow screen.

const NAVY = "#1E3A8A";
const GREEN = "#16A34A";
const TEXT = "#1F2937";
const MUTED = "#6B7280";
const BORDER = "#E5E7EB";
const BG = "#F6F7F9";

function appUrl(path = ""): string {
  const base = (process.env.APP_URL ?? "https://jobprofitai.com").replace(/\/+$/, "");
  return path ? `${base}${path.startsWith("/") ? path : `/${path}`}` : base;
}

export interface EmailButton {
  label: string;
  url: string;
}

export interface EmailContent {
  /** Inbox preview text. */
  preheader: string;
  heading: string;
  /** Paragraphs of body copy. */
  body: string[];
  bullets?: string[];
  cta?: EmailButton;
  /** Boxed callout rendered above the CTA - used for dates and amounts. */
  callout?: { label: string; value: string };
  /** Small print under the CTA. */
  footnote?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Full HTML document for one email. */
export function renderHtml(content: EmailContent): string {
  const logo = appUrl("/jobprofitai-logo@1x.png");

  const bodyHtml = content.body
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${TEXT};">${escapeHtml(p)}</p>`
    )
    .join("");

  const bulletsHtml = content.bullets?.length
    ? `<ul style="margin:0 0 20px;padding-left:20px;">${content.bullets
        .map(
          (b) =>
            `<li style="margin:0 0 8px;font-size:16px;line-height:1.6;color:${TEXT};">${escapeHtml(b)}</li>`
        )
        .join("")}</ul>`
    : "";

  const calloutHtml = content.callout
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
         <tr><td style="background:${BG};border:1px solid ${BORDER};border-radius:8px;padding:16px 20px;">
           <div style="font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:${MUTED};margin-bottom:4px;">${escapeHtml(content.callout.label)}</div>
           <div style="font-size:20px;font-weight:700;color:${NAVY};">${escapeHtml(content.callout.value)}</div>
         </td></tr>
       </table>`
    : "";

  const ctaHtml = content.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
         <tr><td style="background:${NAVY};border-radius:8px;">
           <a href="${content.cta.url}" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(content.cta.label)}</a>
         </td></tr>
       </table>`
    : "";

  const footnoteHtml = content.footnote
    ? `<p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:${MUTED};">${escapeHtml(content.footnote)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(content.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${BG};-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(content.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <tr><td style="padding:28px 32px 0;">
        <a href="${appUrl()}"><img src="${logo}" alt="JobProfitAI" width="190" style="display:block;border:0;width:190px;max-width:60%;height:auto;"></a>
      </td></tr>
      <tr><td style="padding:24px 32px 8px;">
        <h1 style="margin:0 0 16px;font-size:23px;line-height:1.3;font-weight:700;color:${NAVY};">${escapeHtml(content.heading)}</h1>
        ${bodyHtml}
        ${bulletsHtml}
        ${calloutHtml}
        ${ctaHtml}
        ${footnoteHtml}
      </td></tr>
      <tr><td style="padding:8px 32px 28px;">
        <div style="border-top:1px solid ${BORDER};padding-top:16px;">
          <p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:${MUTED};">
            Questions? Just reply to this email, or write to
            <a href="mailto:${SUPPORT_EMAIL}" style="color:${NAVY};">${SUPPORT_EMAIL}</a>.
          </p>
          <p style="margin:0;font-size:12px;line-height:1.5;color:${MUTED};">
            JobProfitAI: Profit Intelligence for QuickBooks. A product of PWL Solutions LLC.<br>
            QuickBooks is a trademark of Intuit Inc. JobProfitAI is not affiliated with or endorsed by Intuit.
          </p>
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** Plain-text alternative. Always sent alongside the HTML. */
export function renderText(content: EmailContent): string {
  const parts: string[] = [content.heading, "", ...content.body];
  if (content.bullets?.length) {
    parts.push("", ...content.bullets.map((b) => `- ${b}`));
  }
  if (content.callout) {
    parts.push("", `${content.callout.label}: ${content.callout.value}`);
  }
  if (content.cta) {
    parts.push("", `${content.cta.label}: ${content.cta.url}`);
  }
  if (content.footnote) {
    parts.push("", content.footnote);
  }
  parts.push(
    "",
    "---",
    `Questions? Reply to this email or write to ${SUPPORT_EMAIL}.`,
    "JobProfitAI: Profit Intelligence for QuickBooks. A product of PWL Solutions LLC.",
    "QuickBooks is a trademark of Intuit Inc. JobProfitAI is not affiliated with or endorsed by Intuit."
  );
  return parts.join("\n");
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function buildEmail(subject: string, content: EmailContent): RenderedEmail {
  return { subject, html: renderHtml(content), text: renderText(content) };
}

// --- Formatting helpers --------------------------------------------------

export function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function formatDay(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

// ─────────────────────────────────────────────────────────────────────────
// TRIAL LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────

export function trialWelcomeEmail(name: string | null): RenderedEmail {
  return buildEmail("Welcome to JobProfitAI. Connect QuickBooks to get started", {
    preheader: "One step to see which jobs are actually making you money.",
    heading: `Welcome${name ? `, ${name.split(" ")[0]}` : ""}.`,
    body: [
      "Your 14-day free trial is live. No credit card needed.",
      "There's one step to get value out of JobProfitAI: connect your QuickBooks Online company. From there we organize your jobs, revenue and costs, and show you which jobs are making money and which ones are quietly costing you.",
    ],
    bullets: [
      "Job-by-job revenue, cost, gross profit and margin",
      "Margin leaks and cost overruns flagged before they get expensive",
      "A Weekly Profit Brief so you don't have to go looking for problems",
    ],
    cta: { label: "Connect QuickBooks", url: appUrl("/dashboard") },
    footnote: "Takes about two minutes. You can disconnect at any time from Settings.",
  });
}

export function setupReminderEmail(name: string | null, daysLeft: number): RenderedEmail {
  return buildEmail("Your JobProfitAI trial is running. QuickBooks isn't connected yet", {
    preheader: "Connect QuickBooks to see your job profitability.",
    heading: "You haven't connected QuickBooks yet",
    body: [
      `${name ? `${name.split(" ")[0]}, y` : "Y"}our free trial is running, but JobProfitAI can't show you anything until it can read your job data.`,
      "Connecting takes about two minutes: you log into QuickBooks Online the way you normally do and approve access. We never see or store your QuickBooks password.",
    ],
    callout: { label: "Days left in your trial", value: String(daysLeft) },
    cta: { label: "Connect QuickBooks", url: appUrl("/dashboard") },
    footnote: "If something got in the way, reply to this email and we'll help.",
  });
}

export function analysisReadyEmail(companyName: string): RenderedEmail {
  return buildEmail("Your JobProfitAI profit intelligence is ready", {
    preheader: "Your first job profitability analysis is done.",
    heading: "Your numbers are in",
    body: [
      `We've analyzed the job data in ${companyName} and your profit intelligence is ready to look at.`,
      "Start with the dashboard: it shows revenue, cost, gross profit and margin for every job, and flags the ones that need attention right now.",
    ],
    cta: { label: "See your job profitability", url: appUrl("/dashboard") },
    footnote:
      "Numbers look off? That's usually a data gap in QuickBooks rather than a mistake. Check the Data Health page, which lists exactly what's missing.",
  });
}

export function trialEndingWithOfferEmail(daysLeft: number, newEndDate: Date): RenderedEmail {
  return buildEmail("Want another 14 days of JobProfitAI, free?", {
    preheader: "Five minutes of feedback gets you another 14 days.",
    heading: "Want another 14 days free?",
    body: [
      `Your trial ends in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}.`,
      "Help us improve JobProfitAI. Complete a short 5-minute feedback survey and we'll extend your full-access trial another 14 days.",
    ],
    callout: { label: "Your trial would run through", value: formatDay(newEndDate) },
    cta: { label: "Give Feedback & Get 14 More Days", url: appUrl("/dashboard/billing/feedback") },
    footnote:
      "No credit card, and no testimonial required. We just want honest answers about what's working and what isn't.",
  });
}

export function trialEndingNoOfferEmail(daysLeft: number, trialEndsAt: Date): RenderedEmail {
  return buildEmail(`Your JobProfitAI trial ends in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}`, {
    preheader: "Choose a plan to keep your profit intelligence running.",
    heading: "Your trial is ending soon",
    body: [
      "To keep your job profitability dashboard, insights and Weekly Profit Brief running without a gap, choose a plan before your trial ends.",
      "Your data and QuickBooks connection stay exactly as they are either way. Nothing is deleted when a trial ends.",
    ],
    callout: { label: "Trial ends", value: formatDay(trialEndsAt) },
    cta: { label: "Choose Your Plan", url: appUrl("/dashboard/billing") },
    footnote: "Cancel anytime from your billing settings.",
  });
}

export function trialExtendedEmail(newEndDate: Date): RenderedEmail {
  return buildEmail("Your JobProfitAI trial has been extended by 14 days", {
    preheader: `Your trial now runs through ${formatDay(newEndDate)}.`,
    heading: "Thanks. Your trial has been extended",
    body: [
      "We got your feedback, and it genuinely helps shape what gets built next.",
      "Your full-access trial has been extended by 14 days. Nothing else changes: same features, same data, still no credit card.",
    ],
    callout: { label: "Your trial now runs through", value: formatDay(newEndDate) },
    cta: { label: "Back to your dashboard", url: appUrl("/dashboard") },
  });
}

export function trialExpiredEmail(): RenderedEmail {
  return buildEmail("Your JobProfitAI trial has ended", {
    preheader: "Choose a plan to turn your profit intelligence back on.",
    heading: "Your trial has ended",
    body: [
      "Your free trial is over, so the profit intelligence features are paused for now.",
      "Nothing has been deleted. Your account, your QuickBooks connection and every job we've analyzed are all still here. Choosing a plan turns everything back on exactly as you left it.",
    ],
    cta: { label: "Choose Your Plan", url: appUrl("/dashboard/billing") },
    footnote: "Profit Intelligence is $149/month, Profit Intelligence Pro is $299/month. Cancel anytime.",
  });
}

export function testimonialRequestEmail(name: string | null): RenderedEmail {
  return buildEmail("Would you be willing to share how JobProfitAI is going?", {
    preheader: "A couple of sentences would help other contractors.",
    heading: "A quick ask",
    body: [
      `${name ? `${name.split(" ")[0]}, y` : "Y"}ou've been using JobProfitAI for a few weeks now, which is long enough to have a real opinion about it.`,
      "If it's been useful, would you be willing to share a couple of sentences we could quote on our website? If it hasn't, I'd honestly rather hear that. Reply and tell me what's missing.",
      "Either way there's nothing owed here. This has no effect on your account, your billing, or anything you've already been given.",
    ],
    cta: { label: "Reply with a sentence or two", url: `mailto:${SUPPORT_EMAIL}?subject=JobProfitAI%20feedback` },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// BILLING
// ─────────────────────────────────────────────────────────────────────────

export function subscriptionConfirmedEmail(planName: string, priceLabel: string): RenderedEmail {
  return buildEmail(`You're on ${planName}. Welcome aboard`, {
    preheader: "Your JobProfitAI subscription is active.",
    heading: "Your subscription is active",
    body: [
      `You're now on ${planName} at ${priceLabel}/month. Everything stays exactly where you left it, same connection, same jobs, same history.`,
      "One thing worth doing now: check that the Weekly Profit Brief is going to the right people in Settings. That email is where most of the day-to-day value lands.",
    ],
    cta: { label: "Go to your dashboard", url: appUrl("/dashboard") },
    footnote: "Manage your plan, payment method and invoices anytime from Billing.",
  });
}

export function paymentFailedEmail(planName: string): RenderedEmail {
  return buildEmail("We couldn't process your JobProfitAI payment", {
    preheader: "Update your payment method to avoid an interruption.",
    heading: "Your last payment didn't go through",
    body: [
      `The most recent payment for your ${planName} subscription was declined. This is usually an expired card.`,
      "Your account is still fully active. We'll keep retrying for a couple of weeks. Updating your card now avoids any interruption.",
    ],
    cta: { label: "Update payment method", url: appUrl("/dashboard/billing") },
  });
}

export function subscriptionCanceledEmail(accessUntil: Date | null): RenderedEmail {
  return buildEmail("Your JobProfitAI subscription has been canceled", {
    preheader: "Here's what happens to your data.",
    heading: "Your subscription is canceled",
    body: [
      accessUntil
        ? "Your subscription won't renew. You keep full access until the end of the period you've already paid for."
        : "Your subscription has been canceled and the paid features are now switched off.",
      "Your data isn't deleted. If you come back, resubscribing restores everything as it was.",
      "If something about the product drove this, I'd genuinely like to know, just reply to this email.",
    ],
    ...(accessUntil ? { callout: { label: "Access continues through", value: formatDay(accessUntil) } } : {}),
    cta: { label: "Reactivate", url: appUrl("/dashboard/billing") },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// CUSTOMER REFERRALS
// ─────────────────────────────────────────────────────────────────────────

export function referralSignupEmail(): RenderedEmail {
  return buildEmail("Someone signed up through your JobProfitAI link", {
    preheader: "Your referral link brought in a new trial.",
    heading: "Someone joined through your link",
    body: [
      "A new contractor started a JobProfitAI trial using your referral link.",
      "If they become a paying customer and stay subscribed for 30 days, you'll earn a free month of your current plan as an account credit.",
    ],
    cta: { label: "See your referrals", url: appUrl("/dashboard/referrals") },
    footnote: "We don't share who they are. That's their business, not ours to pass along.",
  });
}

export function referralConvertedEmail(): RenderedEmail {
  return buildEmail("One of your referrals just subscribed", {
    preheader: "30 days of paid subscription and your free month is earned.",
    heading: "Your referral subscribed",
    body: [
      "Someone who signed up through your link is now a paying JobProfitAI customer.",
      "Once they've been subscribed for 30 days, your free month is earned automatically and shows up as a credit on your account.",
    ],
    cta: { label: "See your referrals", url: appUrl("/dashboard/referrals") },
  });
}

export function referralRewardEarnedEmail(amountCents: number, applied: boolean): RenderedEmail {
  return buildEmail("You earned a free month of JobProfitAI", {
    preheader: `A ${formatMoney(amountCents)} credit is on your account.`,
    heading: "You earned a free month",
    body: [
      "One of your referrals has been a paying customer for 30 days, so you've earned a free month of your current plan.",
      applied
        ? "The credit is on your account now and will automatically come off your next invoice. If it's larger than one invoice, the remainder carries over."
        : "The credit is recorded and will be applied automatically as soon as you have an active subscription.",
    ],
    callout: { label: "Credit earned", value: formatMoney(amountCents) },
    cta: { label: "See your referrals", url: appUrl("/dashboard/referrals") },
    footnote: "Credits stack, every qualified referral adds another month.",
  });
}

// ─────────────────────────────────────────────────────────────────────────
// PARTNER PROGRAM
// ─────────────────────────────────────────────────────────────────────────

export function partnerApplicationReceivedEmail(firmName: string): RenderedEmail {
  return buildEmail("We received your JobProfitAI Partner Program application", {
    preheader: "We'll review and get back to you.",
    heading: "Application received",
    body: [
      `Thanks for applying to the JobProfitAI Partner Program on behalf of ${firmName}.`,
      "We review applications by hand, usually within a couple of business days. Once you're approved you'll get your referral link and access to your partner dashboard.",
    ],
    footnote: `Questions in the meantime? Write to ${SUPPORT_EMAIL}.`,
  });
}

export function partnerApprovedEmail(firmName: string, url: string): RenderedEmail {
  return buildEmail("You're approved. Welcome to the JobProfitAI Partner Program", {
    preheader: "Here's your referral link and dashboard.",
    heading: "You're approved",
    body: [
      `${firmName} is now a JobProfitAI partner.`,
      "Here's your referral link. Any contractor who signs up through it starts a 14-day free trial with no credit card, and is attributed to your firm automatically.",
      "You earn 20% of their subscription revenue for their first 12 paid months, rising to 25% at 10 paying clients and 30% at 25.",
    ],
    callout: { label: "Your referral link", value: url },
    cta: { label: "Open your partner dashboard", url: appUrl("/dashboard/partner") },
  });
}

export function partnerNewSignupEmail(): RenderedEmail {
  return buildEmail("A new client started a trial through your partner link", {
    preheader: "A referred contractor just signed up.",
    heading: "New referred signup",
    body: [
      "A contractor started a JobProfitAI trial through your partner link.",
      "You'll start earning commission once they convert to a paid subscription.",
    ],
    cta: { label: "Open your partner dashboard", url: appUrl("/dashboard/partner") },
  });
}

export function partnerNewPayingClientEmail(payingClients: number, ratePct: number): RenderedEmail {
  return buildEmail("One of your referred clients just subscribed", {
    preheader: "You're now earning commission on this client.",
    heading: "New paying client",
    body: [
      "A contractor you referred has converted to a paid JobProfitAI subscription. Commission starts accruing from their first paid invoice.",
      `You now have ${payingClients} paying ${payingClients === 1 ? "client" : "clients"}, earning ${ratePct}% of subscription revenue for each client's first 12 paid months.`,
    ],
    cta: { label: "Open your partner dashboard", url: appUrl("/dashboard/partner") },
  });
}

export function partnerTierUpgradeEmail(ratePct: number, payingClients: number): RenderedEmail {
  return buildEmail(`You've moved up to ${ratePct}% commission`, {
    preheader: "Your partner tier just increased.",
    heading: `You're now earning ${ratePct}%`,
    body: [
      `With ${payingClients} paying clients, your commission rate has increased to ${ratePct}% of subscription revenue.`,
      "The new rate applies to invoices from here on. Commissions already earned keep the rate they were earned at.",
    ],
    cta: { label: "Open your partner dashboard", url: appUrl("/dashboard/partner") },
  });
}

export function partnerCommissionEarnedEmail(amountCents: number, monthNumber: number): RenderedEmail {
  return buildEmail("You earned a JobProfitAI commission", {
    preheader: `${formatMoney(amountCents)} added to your partner ledger.`,
    heading: "Commission earned",
    body: [
      `A referred client's subscription invoice was paid, so ${formatMoney(amountCents)} has been added to your commission ledger (month ${monthNumber} of 12 for this client).`,
      "Commissions are tracked in your dashboard and paid out by our team. You'll get a confirmation when a payout is recorded.",
    ],
    callout: { label: "Commission earned", value: formatMoney(amountCents) },
    cta: { label: "See your commissions", url: appUrl("/dashboard/partner") },
  });
}

export function partnerPayoutRecordedEmail(amountCents: number, note: string | null): RenderedEmail {
  return buildEmail("Your JobProfitAI partner commission has been paid", {
    preheader: `${formatMoney(amountCents)} marked as paid.`,
    heading: "Commission paid",
    body: [
      `${formatMoney(amountCents)} in partner commission has been marked as paid in your ledger.`,
      ...(note ? [note] : []),
    ],
    cta: { label: "See your commissions", url: appUrl("/dashboard/partner") },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// CONTACT FORM
// ─────────────────────────────────────────────────────────────────────────

export function contactConfirmationEmail(name: string): RenderedEmail {
  return buildEmail("We received your message", {
    preheader: "Thanks for contacting JobProfitAI.",
    heading: "We received your message",
    body: [
      `Thanks for contacting JobProfitAI${name ? `, ${name.split(" ")[0]}` : ""}. We received your message and will follow up as soon as possible.`,
      "If you need to add anything, just reply to this email.",
    ],
  });
}

export function contactNotificationEmail(input: {
  name: string;
  company?: string | null;
  email: string;
  phone?: string | null;
  reason: string;
  message: string;
}): RenderedEmail {
  return buildEmail(`[Contact] ${input.reason}, ${input.name}`, {
    preheader: `${input.reason} enquiry from ${input.email}`,
    heading: `New contact form submission`,
    body: [input.message],
    bullets: [
      `Name: ${input.name}`,
      `Email: ${input.email}`,
      ...(input.company ? [`Company: ${input.company}`] : []),
      ...(input.phone ? [`Phone: ${input.phone}`] : []),
      `Reason: ${input.reason}`,
    ],
  });
}
