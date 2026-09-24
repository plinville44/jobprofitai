import { COMPANY_LEGAL_NAME, COMPANY_MAILING_ADDRESS } from "@/lib/company";
import { SUPPORT_EMAIL } from "./client";
import {
  PARTNER_COMMISSION_MONTHS,
  PARTNER_TIERS,
  PLANS,
  REFERRAL_QUALIFY_DAYS,
  TRIAL_DAYS,
  TRIAL_EXTENSION_DAYS,
} from "@/lib/plans";
import { DEFAULT_TIME_ZONE, formatDateTime } from "@/lib/format";

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

export function appUrl(path = ""): string {
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
  // Wordmark, not the full lockup. At the 190px this header renders, the
  // tagline baked into the lockup art is about 4px tall: unreadable, and it
  // shrinks the name itself to make room. Email clients have no responsive
  // image handling, so this is a fixed 600px asset rather than next/image.
  const logo = appUrl("/jobprofitai-wordmark@1x.png");

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
        <a href="${appUrl()}"><img src="${logo}" alt="JobProfitAI" width="190" height="34" style="display:block;border:0;width:190px;max-width:60%;height:auto;"></a>
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
            JobProfitAI: Profit Intelligence for QuickBooks. A product of ${COMPANY_LEGAL_NAME},<br>
            ${COMPANY_MAILING_ADDRESS}.<br>
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
    `JobProfitAI: Profit Intelligence for QuickBooks. A product of ${COMPANY_LEGAL_NAME}, ${COMPANY_MAILING_ADDRESS}.`,
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

/**
 * A trial or access end date, as the moment it actually is, in the account's
 * timezone and labelled with it.
 *
 * These used to print a bare date from the server's clock under "Your trial
 * runs through", for trials that end at a time of day, not at midnight. A
 * trial ending at 7pm Pacific on Sep 15 read "through September 16".
 */
export function formatDay(date: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  return formatDateTime(date, timeZone);
}

// ─────────────────────────────────────────────────────────────────────────
// ACCOUNT
// ─────────────────────────────────────────────────────────────────────────

/**
 * The reset link itself. Two things this copy does deliberately:
 *
 * It states the expiry in the body, not just the footnote, because "why
 * didn't the link work" is the single most common support question a reset
 * flow generates, and the answer is almost always that an hour passed.
 *
 * It tells someone who did not request this that they can ignore it and
 * their password is unchanged. That sentence is what stops a reset email
 * triggered by a mistyped address from reading like a breach notification.
 */
/**
 * Sent to the owner of a QuickBooks company when someone tries to connect
 * that company to a different JobProfitAI account. The attempt was refused;
 * this says so, and how to move the company if it was meant to happen.
 */
export function connectAttemptBlockedEmail(companyName: string): RenderedEmail {
  return buildEmail(`Someone tried to connect ${companyName} to another JobProfitAI account`, {
    preheader: "The connection was refused. Nothing changed in your account.",
    heading: "A connection attempt was refused",
    body: [
      `Someone signed in to QuickBooks and tried to connect ${companyName} to a different JobProfitAI account. It's already connected to yours, so we refused, and nothing changed.`,
      "If that was you or someone on your team moving the company to another account, disconnect it from Settings in this account first, then connect it from the other one.",
      "If you don't recognise it, no action is needed. Anyone who can do this has sign-in access to your QuickBooks company, so it may be worth checking who does in QuickBooks under Settings, Manage users.",
    ],
    cta: { label: "Open Settings", url: appUrl("/dashboard/settings") },
  });
}

/**
 * An invitation to join someone's JobProfitAI account as a team member.
 * Says who sent it and what it gives access to, because an unexpected
 * "you've been invited" email is otherwise indistinguishable from phishing.
 */
export function teamInviteEmail(input: {
  inviterName: string | null;
  inviterEmail: string;
  companyName: string | null;
  acceptUrl: string;
  expiryDays: number;
}): RenderedEmail {
  const who = input.inviterName ? `${input.inviterName} (${input.inviterEmail})` : input.inviterEmail;
  const what = input.companyName ? `job profit numbers for ${input.companyName}` : "their job profit numbers";
  // A fixed subject: the inviter's name is typed by them, and a subject line
  // of their choosing from our domain would be a gift to phishers.
  return buildEmail("You're invited to a JobProfitAI account", {
    preheader: "Your own login to see which jobs make money.",
    heading: "You're invited to JobProfitAI",
    body: [
      `${who} has invited you to their JobProfitAI account, where you can see ${what}: profit by job, estimate against actual, work in progress and the Weekly Profit Brief.`,
      "You get your own login. Nothing is shared except what's in their account, and they can remove your access at any time.",
      `This invitation works once and expires in ${input.expiryDays} days.`,
    ],
    cta: { label: "Accept the invitation", url: input.acceptUrl },
    footnote:
      "If you weren't expecting this, you can ignore it and nothing will happen. If the button doesn't work, copy and paste this address into your browser: " +
      input.acceptUrl,
  });
}

export function passwordResetEmail(resetUrl: string, expiryMinutes: number): RenderedEmail {
  return buildEmail("Reset your JobProfitAI password", {
    preheader: "A link to choose a new password. It expires in an hour.",
    heading: "Reset your password",
    body: [
      "Someone asked to reset the password for the JobProfitAI account using this email address. Use the button below to choose a new one.",
      `This link works once and expires in ${expiryMinutes} minutes.`,
      "If you did not ask for this, you can ignore this email. Your password stays exactly as it is, and nobody can change it without this link.",
    ],
    cta: { label: "Choose a new password", url: resetUrl },
    footnote:
      "If the button doesn't work, copy and paste this address into your browser: " + resetUrl,
  });
}

/**
 * The first email a new account receives. It has two jobs and does both:
 * confirm the address, and get them to QuickBooks. The welcome email that
 * used to go out at signup now follows verification, so a new customer gets
 * one message at signup rather than two within the same second.
 *
 * It says plainly what waits on verification, because "why hasn't my weekly
 * email arrived" is the question an unverified account will otherwise ask.
 */
export function verifyEmailEmail(verifyUrl: string, name: string | null, expiryHours: number): RenderedEmail {
  return buildEmail("Confirm your email for JobProfitAI", {
    preheader: "One click to confirm this is your address.",
    heading: `Confirm your email${name ? `, ${name.split(" ")[0]}` : ""}`,
    body: [
      "Please confirm this is the email address for your JobProfitAI account.",
      "We hold the Weekly Profit Brief until you confirm. That way a mistyped address never means someone else receiving your job numbers.",
    ],
    cta: { label: "Confirm my email", url: verifyUrl },
    footnote: `This link expires in ${expiryHours} hours. If you didn't create a JobProfitAI account, you can ignore this email. If the button doesn't work, copy and paste this address into your browser: ${verifyUrl}`,
  });
}

/**
 * Sent after the password actually changes. Not a courtesy: this is the
 * message that lets a customer notice a reset they did not perform, which is
 * the only way they would ever find out.
 */
/**
 * Sent when an Intuit account is linked to a JobProfitAI login, so a link
 * the owner didn't make is noticed.
 */
export function intuitLinkedEmail(): RenderedEmail {
  return buildEmail("Sign in with Intuit was turned on for your JobProfitAI login", {
    preheader: "An Intuit account can now sign in to your JobProfitAI login.",
    heading: "Sign in with Intuit is on",
    body: [
      "An Intuit account was just linked to your JobProfitAI login, so it can now sign in without your password. If that was you, there is nothing to do.",
      "If it wasn't you, reset your password straight away. That signs everyone out and unlinks the Intuit account. You can also unlink it in Settings under Sign-in security.",
    ],
    cta: { label: "Open Settings", url: appUrl("/dashboard/settings") },
  });
}

export function passwordChangedEmail(): RenderedEmail {
  return buildEmail("Your JobProfitAI password was changed", {
    preheader: "Confirming a password change on your account.",
    heading: "Your password was changed",
    body: [
      "The password on your JobProfitAI account was just changed. If that was you, there is nothing to do.",
      `If it was not you, contact us at ${SUPPORT_EMAIL} straight away and we will help you secure the account.`,
    ],
    cta: { label: "Log in", url: appUrl("/login") },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// TRIAL LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────

export function trialWelcomeEmail(name: string | null): RenderedEmail {
  return buildEmail("Welcome to JobProfitAI. Connect QuickBooks to get started", {
    preheader: "One step to see which jobs are actually making you money.",
    heading: `Welcome${name ? `, ${name.split(" ")[0]}` : ""}.`,
    body: [
      `Your ${TRIAL_DAYS}-day free trial is live. No credit card needed.`,
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

/**
 * The pivotal onboarding email: data has landed, here is what to do with it.
 *
 * It names every field QuickBooks cannot supply, and says why each one
 * matters, because they all gate features the customer is paying for and
 * none of them announces itself as missing. Without a target margin we
 * cannot compute "jobs below target" at all. Without a job type and an
 * estimated cost, forecast at completion, budget variance and every
 * cross-job pattern stay empty. And without jobs marked finished, Profit
 * Intelligence has nothing to compare, because it only ever looks at
 * completed work.
 *
 * That third one is the least obvious and the most damaging. QuickBooks
 * Projects have a status its API does not expose, so marking a project
 * Completed there tells us nothing (see src/lib/jobStatus.ts). A customer
 * who assumes it carries over will finish job after job and watch Profit
 * Intelligence stay empty, and they would be looking at the evidence when
 * they conclude the product does not work.
 */
export function analysisReadyEmail(companyName: string): RenderedEmail {
  return buildEmail("Your numbers are in. Here's where to start", {
    preheader: "Your first analysis is done, plus the three things that unlock the rest.",
    heading: "Your numbers are in",
    body: [
      `We've analyzed the job data in ${companyName}. Start on the dashboard: revenue, cost, gross profit and margin for every job, with the ones that need attention listed first.`,
      "Three things are worth five minutes now, because until they're set, parts of JobProfitAI have nothing to work with. QuickBooks doesn't have a field for any of them, which is why they're entered here.",
    ],
    bullets: [
      "Set your target margin in Settings. Until you do, we can't tell you which jobs are coming in below target, because we don't know what your target is.",
      "Add a job type and an estimated cost to your open jobs. Job type is what lets us compare similar jobs to each other. Estimated cost is what powers budget variance and forecast at completion. We suggest the job type from the job name to save you the typing.",
      "Mark your finished jobs as completed, on the Jobs page. You can select several and do them in one go. This one surprises people: marking a project Completed in QuickBooks doesn't reach us, because QuickBooks doesn't share project status with outside apps. Until a job is marked finished here, it can't be part of the pattern-finding, which only compares completed work.",
    ],
    cta: { label: "Open your dashboard", url: appUrl("/dashboard") },
    footnote:
      "Numbers look off? That's usually a gap in QuickBooks rather than a mistake. The Data Health page lists exactly what's missing and which jobs it affects.",
  });
}

/**
 * Two days after the first analysis: one plain question, no pitch.
 *
 * With no sales call in the funnel, this is the only moment we find out
 * whether the numbers looked right to the person who knows the jobs. A reply
 * lands in the support inbox (the default Reply-To), so the question is real,
 * not decoration.
 */
export function trialCheckInEmail(name: string | null): RenderedEmail {
  return buildEmail("Did your jobs show up the way you expected?", {
    preheader: "One question. Just hit reply.",
    heading: "Quick question",
    body: [
      `${name ? `${name.split(" ")[0]}, y` : "Y"}our QuickBooks jobs have been in JobProfitAI for a couple of days now.`,
      "Did they show up the way you expected? If a job is missing, a number looks off, or something is confusing, reply to this email and tell me. A real person reads every reply, usually within one business day.",
      "If everything looks right, a one-word \"yes\" helps too.",
    ],
    cta: { label: "Open your dashboard", url: appUrl("/dashboard") },
    footnote: "Numbers that look off are usually a gap in QuickBooks, not a mistake. The Data Health page shows exactly what is missing.",
  });
}

/**
 * About a week into an activated trial: how to read the three numbers that
 * matter, before the ending-soon email asks them to decide. Stands in for the
 * walkthrough a sales call would have given.
 */
export function reportGuideEmail(name: string | null): RenderedEmail {
  return buildEmail("How to read your job profit numbers in 5 minutes", {
    preheader: "The three numbers to check each week, and what to do about each.",
    heading: "Three numbers worth 5 minutes a week",
    body: [
      `${name ? `${name.split(" ")[0]}, h` : "H"}ere is the short version of how contractors use JobProfitAI each week. Open the dashboard and look at these three, in this order:`,
    ],
    bullets: [
      "Jobs Below Target. Every job under the margin you set in Settings. If this shows \"Not set\", set your target margin first; it takes 30 seconds and everything else depends on it.",
      "Profit At Risk. The dollars at stake on jobs that are over estimate or slipping. Start with the biggest one in Needs Your Attention and check whether a bill was coded to the wrong job or costs are really running over.",
      "Data Issues. Costs or invoices QuickBooks has not tied to a job. Fixing these in QuickBooks makes every other number more accurate.",
    ],
    cta: { label: "Check your three numbers", url: appUrl("/dashboard") },
    footnote: "Mark finished jobs as completed on the Jobs page. QuickBooks does not share project status with outside apps, so the margin trend and Profit Intelligence stay empty until you do.",
  });
}

export function trialEndingWithOfferEmail(
  daysLeft: number,
  newEndDate: Date,
  timeZone?: string
): RenderedEmail {
  return buildEmail(`Want another ${TRIAL_EXTENSION_DAYS} days of JobProfitAI, free?`, {
    preheader: `Five minutes of feedback gets you another ${TRIAL_EXTENSION_DAYS} days.`,
    heading: `Want another ${TRIAL_EXTENSION_DAYS} days free?`,
    body: [
      `Your trial ends in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}.`,
      `Help us improve JobProfitAI. Complete a short 5-minute feedback survey and we'll extend your full-access trial another ${TRIAL_EXTENSION_DAYS} days.`,
    ],
    callout: { label: "Your trial would end", value: formatDay(newEndDate, timeZone) },
    cta: { label: `Give Feedback & Get ${TRIAL_EXTENSION_DAYS} More Days`, url: appUrl("/dashboard/billing/feedback") },
    footnote:
      "No credit card, and no testimonial required. We just want honest answers about what's working and what isn't.",
  });
}

export function trialEndingNoOfferEmail(daysLeft: number, trialEndsAt: Date, timeZone?: string): RenderedEmail {
  return buildEmail(`Your JobProfitAI trial ends in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}`, {
    preheader: "Choose a plan to keep your profit intelligence running.",
    heading: "Your trial is ending soon",
    body: [
      "To keep your job profitability dashboard, insights and Weekly Profit Brief running without a gap, choose a plan before your trial ends.",
      "Your data and QuickBooks connection stay exactly as they are either way. Nothing is deleted when a trial ends.",
    ],
    callout: { label: "Trial ends", value: formatDay(trialEndsAt, timeZone) },
    cta: { label: "Choose Your Plan", url: appUrl("/dashboard/billing") },
    footnote: "Cancel anytime from your billing settings.",
  });
}

export function trialExtendedEmail(newEndDate: Date, timeZone?: string): RenderedEmail {
  return buildEmail(`Your JobProfitAI trial has been extended by ${TRIAL_EXTENSION_DAYS} days`, {
    preheader: `Your trial now ends ${formatDay(newEndDate, timeZone)}.`,
    heading: "Thanks. Your trial has been extended",
    body: [
      "We got your feedback, and it genuinely helps shape what gets built next.",
      `Your full-access trial has been extended by ${TRIAL_EXTENSION_DAYS} days. Nothing else changes: same features, same data, still no credit card.`,
    ],
    callout: { label: "Your trial now ends", value: formatDay(newEndDate, timeZone) },
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
    footnote: `${PLANS.profit_intelligence.name} is ${PLANS.profit_intelligence.priceLabel}/month, ${PLANS.profit_intelligence_pro.name} is ${PLANS.profit_intelligence_pro.priceLabel}/month. Cancel anytime.`,
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

export function subscriptionCanceledEmail(accessUntil: Date | null, timeZone?: string): RenderedEmail {
  return buildEmail("Your JobProfitAI subscription has been canceled", {
    preheader: "Here's what happens to your data.",
    heading: "Your subscription is canceled",
    body: [
      accessUntil
        ? "Your subscription won't renew. You keep full access until the end of the period you've already paid for."
        : "Your subscription has been canceled and the paid features are now switched off.",
      "Your data isn't deleted. If you come back, resubscribing restores everything as it was.",
      "If something about the product drove this, I'd like to know. Just reply to this email.",
    ],
    ...(accessUntil ? { callout: { label: "Access ends", value: formatDay(accessUntil, timeZone) } } : {}),
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
      `If they become a paying customer and stay subscribed for ${REFERRAL_QUALIFY_DAYS} days, you'll earn a free month of your current plan as an account credit.`,
    ],
    cta: { label: "See your referrals", url: appUrl("/dashboard/referrals") },
    footnote: "We don't share who they are. That's their business, not ours to pass along.",
  });
}

export function referralConvertedEmail(): RenderedEmail {
  return buildEmail("One of your referrals just subscribed", {
    preheader: `${REFERRAL_QUALIFY_DAYS} days of paid subscription and your free month is earned.`,
    heading: "Your referral subscribed",
    body: [
      "Someone who signed up through your link is now a paying JobProfitAI customer.",
      `Once they've been subscribed for ${REFERRAL_QUALIFY_DAYS} days, your free month is earned automatically and shows up as a credit on your account.`,
    ],
    cta: { label: "See your referrals", url: appUrl("/dashboard/referrals") },
  });
}

export function referralRewardEarnedEmail(amountCents: number, applied: boolean): RenderedEmail {
  return buildEmail("You earned a free month of JobProfitAI", {
    preheader: `A ${formatMoney(amountCents)} credit is on your account.`,
    heading: "You earned a free month",
    body: [
      `One of your referrals has been a paying customer for ${REFERRAL_QUALIFY_DAYS} days, so you've earned a free month of your current plan.`,
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
      `Here's your referral link. Any contractor who signs up through it starts a ${TRIAL_DAYS}-day free trial with no credit card, and is attributed to your firm automatically.`,
      (() => {
        const [entry, ...higher] = [...PARTNER_TIERS].reverse();
        const steps = higher.map((t) => `${t.ratePct}% at ${t.minPayingClients}`).join(" and ");
        return `You earn ${entry.ratePct}% of their subscription revenue for their first ${PARTNER_COMMISSION_MONTHS} paid months${steps ? `, rising to ${steps} paying clients` : ""}.`;
      })(),
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
      `You now have ${payingClients} paying ${payingClients === 1 ? "client" : "clients"}, earning ${ratePct}% of subscription revenue for each client's first ${PARTNER_COMMISSION_MONTHS} paid months.`,
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
      `A referred client's subscription invoice was paid, so ${formatMoney(amountCents)} has been added to your commission ledger (month ${monthNumber} of ${PARTNER_COMMISSION_MONTHS} for this client).`,
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
  // "from" rather than a comma: a comma reads as a list of two topics in an
  // inbox, and this matches the [Feedback] subject the feedback route sends,
  // so both internal notifications sort and scan the same way.
  return buildEmail(`[Contact] ${input.reason} from ${input.name}`, {
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
