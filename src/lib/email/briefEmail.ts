import crypto from "crypto";
import { COMPANY_LEGAL_NAME, COMPANY_MAILING_ADDRESS } from "@/lib/company";
import { formatCurrency, formatDate } from "@/lib/format";
import type { ConnectionMetrics } from "@/lib/profitability";
import { jobChangeSentence, noComparisonMessage, type WeekOverWeekReport } from "@/lib/weekOverWeek";
import { briefTileJobs, type BriefHeadline, type BriefTileJobs } from "@/lib/briefHeadline";
import { companyOpenPath } from "@/lib/companyLinks";
import { JOB_SOURCE_QUESTION } from "@/lib/jobSetup";
import { SUPPORT_EMAIL } from "./client";
import { appUrl } from "./templates";

/**
 * A link to a dashboard page that opens it for this email's company, not
 * whichever company the reader last had on screen (see companyLinks.ts).
 */
export function companyUrl(connectionId: string, path: string): string {
  return appUrl(companyOpenPath(connectionId, path));
}

/**
 * The Weekly Profit Brief as an email people will actually open.
 *
 * It used to be the plain-text narrative wrapped in a <pre> tag: no logo,
 * no figures up top, and no link to the job it was talking about. It is
 * the thing customers pay for, and the marketing site shows a formatted
 * email, so this renders one: headline figures, what changed (each job
 * linked), the written summary, a button to the dashboard, and a footer
 * with a working unsubscribe for every recipient.
 */

const NAVY = "#1E3A8A";
const TEXT = "#1F2937";
const MUTED = "#6B7280";
const BORDER = "#E5E7EB";
const BG = "#F6F7F9";
const RED = "#B91C1C";

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------------------------------------------------------------------
// Unsubscribe links
// ---------------------------------------------------------------------------

function unsubscribeSig(connectionId: string, email: string): string {
  return crypto
    .createHmac("sha256", process.env.AUTH_SECRET ?? "dev-only")
    .update(`brief-unsub:${connectionId}:${email.trim().toLowerCase()}`)
    .digest("base64url")
    .slice(0, 32);
}

/**
 * The recipient's own unsubscribe link. With `allCompanies`, the page it
 * opens offers stopping the emails for every company on the account; the
 * signature is the same, since either way it can only remove the address it
 * was sent to.
 */
export function unsubscribeUrl(connectionId: string, email: string, opts: { allCompanies?: boolean } = {}): string {
  const e = Buffer.from(email.trim().toLowerCase()).toString("base64url");
  return appUrl(
    `/api/brief/unsubscribe?c=${encodeURIComponent(connectionId)}&e=${e}&t=${unsubscribeSig(connectionId, email)}${opts.allCompanies ? "&all=1" : ""}`
  );
}

/** Checks an unsubscribe link and returns the address it is for. */
export function verifyUnsubscribe(connectionId: string, encodedEmail: string, sig: string): string | null {
  let email: string;
  try {
    email = Buffer.from(encodedEmail, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = unsubscribeSig(connectionId, email);
  if (expected.length !== sig.length) return null;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig)) ? email : null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface BriefEmailInput {
  connectionId: string;
  companyName: string;
  weekStarting: Date;
  kind: "narrative" | "data_health";
  /** The written part: the AI summary, or the Data Health notice. */
  body: string;
  weekOverWeek: WeekOverWeekReport;
  metrics: ConnectionMetrics;
  /** The Profit Opportunity headline, when it could be worked out. */
  headline?: BriefHeadline | null;
  /**
   * The jobs behind the "over estimate" and "not yet billed" tiles, on the
   * feed's rules (see briefTileJobs). Without them the over-estimate tile
   * is counted from the brief's jobs and the unbilled tile is left off.
   */
  tiles?: BriefTileJobs | null;
  /** The AI write-up failed and `body` says so: the email doesn't call it an AI summary. */
  summaryMissing?: boolean;
  recipient: string;
  ownerEmail: string | null;
  /** The account has other companies: the footer also offers stopping the emails for all of them. */
  hasOtherCompanies?: boolean;
  /**
   * The dashboard is still asking whether each job is a Class (see
   * jobSourceQuestionPending). The brief isn't held back for the answer; it
   * points to the question instead.
   */
  jobSourceQuestionPending?: boolean;
}

/** Up to five jobs by name, then "and N more". */
function someJobs<T>(list: T[], each: (t: T) => string): string {
  const shown = list.slice(0, 5).map(each);
  const more = list.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

export function renderBriefEmail(input: BriefEmailInput): { subject: string; html: string; text: string; headers: Record<string, string> } {
  const { metrics, weekOverWeek: wow } = input;
  const week = formatDate(input.weekStarting);
  const link = (path: string) => companyUrl(input.connectionId, path);
  // The money headline only goes on a brief whose data supports it.
  const hl = input.kind === "narrative" ? input.headline ?? null : null;
  const subject =
    hl?.subject ??
    (input.kind === "narrative"
      ? `${input.companyName}: Weekly Profit Brief, week of ${week}`
      : `${input.companyName}: Data Health notice, week of ${week}`);

  // The money, first: the headline and the biggest opportunities, from the
  // same calculation as the Profit Opportunities page.
  const hlTiles = hl
    ? [
        { label: "At risk on open jobs", value: hl.snapshot.openJobRisk },
        { label: "Estimates priced too low", value: hl.snapshot.estimatesShortfall },
        { label: "Pricing gap, last 12 months", value: hl.snapshot.pricingGap },
      ]
    : [];
  const headlineHtml = hl
    ? `<div style="margin:0 0 20px;padding:16px 18px;border:1px solid ${BORDER};border-radius:10px;background:#f8fafc;">
      <div style="font-size:17px;line-height:1.4;font-weight:700;color:${NAVY};">${esc(hl.headline)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 4px;"><tr>${hlTiles
        .map(
          (t) =>
            `<td style="vertical-align:top;padding-right:10px;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:${MUTED};">${esc(t.label)}</div><div style="margin-top:2px;font-size:17px;font-weight:700;color:${t.value > 0 ? RED : NAVY};">${esc(formatCurrency(t.value))}</div></td>`
        )
        .join("")}</tr></table>
      ${
        hl.snapshot.top.length
          ? `<ul style="margin:10px 0 0;padding-left:18px;">${hl.snapshot.top
              .map(
                (t) =>
                  `<li style="margin:0 0 6px;font-size:14px;line-height:1.5;color:${TEXT};"><a href="${esc(link(t.href))}" style="color:${NAVY};font-weight:600;text-decoration:none;">${esc(t.title)}</a>${
                    t.impact != null ? ` <span style="color:${MUTED};">(${esc(formatCurrency(t.impact))} ${esc(t.impactLabel)})</span>` : ""
                  }</li>`
              )
              .join("")}</ul>`
          : ""
      }
      <a href="${esc(link("/dashboard/opportunities"))}" style="display:inline-block;margin-top:6px;font-size:14px;font-weight:600;color:${NAVY};">See what to change, and what it's worth</a>
    </div>`
    : "";

  // Counted on the feed's rules, and each with its jobs named below the
  // tiles, so no figure stands without the jobs behind it.
  const tileJobs = input.tiles ?? briefTileJobs(metrics);
  const overBudget = tileJobs.overEstimate.length;
  const unbilledJobs = tileJobs.unbilled ?? [];
  const underBilled = unbilledJobs.reduce((s, u) => s + u.amount, 0);
  const tiles: { label: string; value: string; alert?: boolean }[] = [
    { label: "Open jobs", value: String(metrics.totals.activeJobs) },
    {
      label: wow.noComparisonReason ? "Billed to date" : "Billed since last brief",
      value: formatCurrency(wow.noComparisonReason ? metrics.totals.totalActualRevenue : wow.revenueAdded),
    },
    {
      label: wow.noComparisonReason ? "Costs to date" : "New costs since last brief",
      value: formatCurrency(wow.noComparisonReason ? metrics.totals.totalActualCost : wow.costAdded),
    },
    { label: "Jobs 10%+ over estimate", value: String(overBudget), alert: overBudget > 0 },
  ];
  if (underBilled >= 1000) tiles.push({ label: "Work done, not yet billed", value: formatCurrency(underBilled), alert: true });

  const jobUrl = (id: string) => link(`/dashboard/jobs/${encodeURIComponent(id)}`);
  const jobLink = (id: string, name: string) =>
    `<a href="${esc(jobUrl(id))}" style="color:${NAVY};font-weight:600;text-decoration:none;">${esc(name)}</a>`;
  const tileLines: { html: string; text: string }[] = [];
  if (tileJobs.overEstimate.length) {
    const pctOver = (p: number) => `${Math.round(p * 100)}% over`;
    tileLines.push({
      html: `10%+ over estimate: ${someJobs(tileJobs.overEstimate, (j) => `${jobLink(j.jobId, j.jobName)} (${esc(pctOver(j.pct))})`)}.`,
      text: `10%+ over estimate: ${someJobs(tileJobs.overEstimate, (j) => `${j.jobName} (${pctOver(j.pct)})`)}.`,
    });
  }
  if (underBilled >= 1000) {
    tileLines.push({
      html: `Not yet billed: ${someJobs(unbilledJobs, (j) => `${jobLink(j.jobId, j.jobName)} (${esc(formatCurrency(j.amount))})`)}.`,
      text: `Not yet billed: ${someJobs(unbilledJobs, (j) => `${j.jobName} (${formatCurrency(j.amount)})`)}.`,
    });
  }
  const tileJobsHtml = tileLines.length
    ? `<div style="margin:-12px 0 24px;font-size:13px;line-height:1.6;color:${MUTED};">${tileLines.map((l) => `<div>${l.html}</div>`).join("")}</div>`
    : "";
  const changes = wow.changes.slice(0, 8);
  const hidden = wow.changes.length - changes.length;
  const since = wow.comparedToWeekStarting ? `since the brief for the week of ${formatDate(wow.comparedToWeekStarting)}` : "";

  const noComparison = noComparisonMessage(wow.noComparisonReason, wow.basisChange ?? "labor_burden");
  const changesHtml = wow.noComparisonReason
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${MUTED};">${esc(noComparison)}</p>`
    : changes.length === 0
      ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${MUTED};">Nothing changed on your jobs in QuickBooks ${esc(since)}.</p>`
      : `<ul style="margin:0 0 16px;padding-left:18px;">${changes
          .map(
            (c) =>
              `<li style="margin:0 0 8px;font-size:15px;line-height:1.5;color:${TEXT};">${
                c.removed ? `<strong>${esc(c.jobName)}</strong>` : jobLink(c.jobId, c.jobName)
              }: ${esc(jobChangeSentence(c))}</li>`
          )
          .join("")}</ul>${
          hidden > 0
            ? `<p style="margin:0 0 16px;font-size:13px;color:${MUTED};">${hidden} more ${hidden === 1 ? "job" : "jobs"} also changed. Each job page has the full history.</p>`
            : ""
        }`;

  // The written part is plain text: paragraphs separated by blank lines,
  // with "- " lines as lists (the Data Health notice uses them).
  const bodyHtml = input.body
    .split(/\n\s*\n/)
    .map((para) => para.split("\n").map((l) => l.trim()).filter(Boolean))
    .filter((lines) => lines.length > 0)
    .map((lines) => {
      const bullets = lines.filter((l) => l.startsWith("- "));
      const prose = lines.filter((l) => !l.startsWith("- "));
      const p = prose.length
        ? `<p style="margin:0 0 ${bullets.length ? 8 : 16}px;font-size:15px;line-height:1.6;color:${TEXT};">${esc(prose.join(" "))}</p>`
        : "";
      const ul = bullets.length
        ? `<ul style="margin:0 0 16px;padding-left:18px;">${bullets
            .map((l) => `<li style="margin:0 0 6px;font-size:15px;line-height:1.5;color:${TEXT};">${esc(l.slice(2))}</li>`)
            .join("")}</ul>`
        : "";
      return p + ul;
    })
    .join("");

  const tilesHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-collapse:separate;border-spacing:0 8px;"><tr>${tiles
    .map(
      (t) =>
        `<td style="background:${BG};border:1px solid ${BORDER};border-radius:8px;padding:10px 12px;vertical-align:top;width:${Math.floor(100 / tiles.length)}%;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:${MUTED};">${esc(t.label)}</div>
          <div style="margin-top:4px;font-size:18px;font-weight:700;color:${t.alert ? RED : NAVY};">${esc(t.value)}</div>
        </td>`
    )
    .join('<td style="width:8px;"></td>')}</tr></table>`;

  const questionText = input.jobSourceQuestionPending
    ? `One question is waiting at the top of the dashboard: "${JOB_SOURCE_QUESTION}" The answer decides how the jobs are read from QuickBooks, so these figures may change once it's answered.`
    : null;
  const questionHtml = questionText
    ? `<p style="margin:0 0 20px;padding:12px 14px;border:1px solid ${BORDER};border-radius:8px;font-size:14px;line-height:1.5;color:${TEXT};">${esc(questionText)} <a href="${esc(link("/dashboard"))}" style="color:${NAVY};font-weight:600;">Answer it</a></p>`
    : "";

  const unsub = unsubscribeUrl(input.connectionId, input.recipient);
  const unsubAll = unsubscribeUrl(input.connectionId, input.recipient, { allCompanies: true });
  const isOwner = input.ownerEmail != null && input.ownerEmail.toLowerCase() === input.recipient.toLowerCase();
  const why = isOwner
    ? "You get this because you set up JobProfitAI for this company."
    : `You get this because ${input.ownerEmail ?? "the account owner"} added you as a recipient.`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${BG};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(
    hl ? hl.headline : changes[0] ? `${changes[0].jobName}: ${jobChangeSentence(changes[0])}` : `Your jobs at ${input.companyName} this week.`
  )}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <tr><td style="padding:24px 28px 0;">
    <a href="${esc(link("/dashboard"))}"><img src="${appUrl("/jobprofitai-wordmark@1x.png")}" alt="JobProfitAI" width="170" style="display:block;border:0;width:170px;max-width:55%;height:auto;"></a>
  </td></tr>
  <tr><td style="padding:18px 28px 4px;">
    <div style="font-size:13px;color:${MUTED};">${esc(input.kind === "narrative" ? "Weekly Profit Brief" : "Data Health notice")} &middot; week of ${esc(week)}</div>
    <h1 style="margin:4px 0 18px;font-size:22px;line-height:1.3;color:${NAVY};">${esc(input.companyName)}</h1>
    ${questionHtml}
    ${headlineHtml}
    ${tilesHtml}
    ${tileJobsHtml}
    <h2 style="margin:0 0 10px;font-size:15px;text-transform:uppercase;letter-spacing:.04em;color:${MUTED};">What changed ${esc(since)}</h2>
    ${changesHtml}
    <h2 style="margin:8px 0 10px;font-size:15px;text-transform:uppercase;letter-spacing:.04em;color:${MUTED};">${input.kind === "narrative" ? "The summary" : "Why there is no summary this week"}</h2>
    ${bodyHtml}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="background:${NAVY};border-radius:8px;">
      <a href="${esc(link("/dashboard"))}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Open your dashboard</a>
    </td></tr></table>
    ${
      input.kind === "narrative"
        ? `<p style="margin:0 0 16px;font-size:12px;color:${MUTED};">"What changed" and every figure above are calculated from your QuickBooks data.${
            input.summaryMissing ? "" : " The summary is written by AI from those same figures."
          }</p>`
        : ""
    }
  </td></tr>
  <tr><td style="padding:4px 28px 24px;">
    <div style="border-top:1px solid ${BORDER};padding-top:14px;font-size:12px;line-height:1.6;color:${MUTED};">
      ${esc(why)} <a href="${esc(unsub)}" style="color:${MUTED};">Stop getting this email</a> &middot;
      ${input.hasOtherCompanies ? `<a href="${esc(unsubAll)}" style="color:${MUTED};">Stop it for every company on this account</a> &middot;` : ""}
      <a href="${esc(link("/dashboard/settings"))}" style="color:${MUTED};">Change the day and time</a><br>
      Questions? Reply, or write to <a href="mailto:${SUPPORT_EMAIL}" style="color:${MUTED};">${SUPPORT_EMAIL}</a>.<br>
      ${esc(COMPANY_LEGAL_NAME)}, ${esc(COMPANY_MAILING_ADDRESS)}. QuickBooks is a trademark of Intuit Inc.
    </div>
  </td></tr>
</table></td></tr></table></body></html>`;

  const textChanges = wow.noComparisonReason
    ? noComparison
    : changes.length === 0
      ? `Nothing changed on your jobs in QuickBooks ${since}.`
      : changes.map((c) => `- ${c.jobName}: ${jobChangeSentence(c)}`).join("\n") + (hidden > 0 ? `\n${hidden} more jobs also changed.` : "");
  const text = [
    `${input.companyName}: ${input.kind === "narrative" ? "Weekly Profit Brief" : "Data Health notice"}, week of ${week}`,
    "",
    ...(questionText ? [`${questionText} ${link("/dashboard")}`, ""] : []),
    ...(hl
      ? [
          hl.headline,
          hlTiles.map((t) => `${t.label}: ${formatCurrency(t.value)}`).join(" | "),
          ...hl.snapshot.top.map((t) => `- ${t.title}${t.impact != null ? ` (${formatCurrency(t.impact)} ${t.impactLabel})` : ""}`),
          `What to change, and what it's worth: ${link("/dashboard/opportunities")}`,
          "",
        ]
      : []),
    tiles.map((t) => `${t.label}: ${t.value}`).join(" | "),
    ...tileLines.map((l) => l.text),
    "",
    `WHAT CHANGED ${since.toUpperCase()}`.trim(),
    textChanges,
    "",
    input.body,
    "",
    `Open your dashboard: ${link("/dashboard")}`,
    `Change the day and time: ${link("/dashboard/settings")}`,
    "",
    "---",
    why,
    `Stop getting this email: ${unsub}`,
    ...(input.hasOtherCompanies ? [`Stop it for every company on this account: ${unsubAll}`] : []),
    `${COMPANY_LEGAL_NAME}, ${COMPANY_MAILING_ADDRESS}.`,
  ].join("\n");

  return {
    subject,
    html,
    text,
    headers: {
      "List-Unsubscribe": `<${unsub}>, <mailto:${SUPPORT_EMAIL}?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/** A mid-week profit alert, one email listing everything new since the last check. */
export function renderAlertEmail(input: {
  connectionId: string;
  companyName: string;
  alerts: { jobId: string; jobName: string; kind: string; issue: string; financialImpact: number | null }[];
  recipient: string;
  ownerEmail: string | null;
  /** The account has other companies: the footer also offers stopping the emails for all of them. */
  hasOtherCompanies?: boolean;
}): { subject: string; html: string; text: string; headers: Record<string, string> } {
  const first = input.alerts[0];
  const subject =
    input.alerts.length === 1
      ? `${input.companyName}: ${first.jobName} needs a look`
      : `${input.companyName}: ${input.alerts.length} jobs need a look`;
  const unsub = unsubscribeUrl(input.connectionId, input.recipient);
  const unsubAll = unsubscribeUrl(input.connectionId, input.recipient, { allCompanies: true });
  const link = (path: string) => companyUrl(input.connectionId, path);
  const jobUrl = (id: string) => link(`/dashboard/jobs/${encodeURIComponent(id)}`);
  const isOwner = input.ownerEmail != null && input.ownerEmail.toLowerCase() === input.recipient.toLowerCase();
  const items = input.alerts.slice(0, 10);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <tr><td style="padding:24px 28px 0;"><a href="${esc(link("/dashboard"))}"><img src="${appUrl("/jobprofitai-wordmark@1x.png")}" alt="JobProfitAI" width="170" style="display:block;border:0;width:170px;max-width:55%;height:auto;"></a></td></tr>
  <tr><td style="padding:18px 28px 4px;">
    <div style="font-size:13px;color:${MUTED};">Profit alert</div>
    <h1 style="margin:4px 0 16px;font-size:22px;line-height:1.3;color:${NAVY};">${esc(input.companyName)}</h1>
    <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${TEXT};">Your latest QuickBooks sync turned up ${items.length === 1 ? "something" : "a few things"} worth a look before the weekly brief:</p>
    ${items
      .map(
        (a) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;"><tr><td style="border:1px solid ${BORDER};border-radius:8px;padding:12px 14px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:${RED};">${esc(ALERT_LABELS[a.kind] ?? "Needs a look")}</div>
          <div style="margin-top:4px;font-size:15px;font-weight:600;"><a href="${esc(jobUrl(a.jobId))}" style="color:${NAVY};text-decoration:none;">${esc(a.jobName)}</a></div>
          <div style="margin-top:2px;font-size:14px;color:${TEXT};">${esc(a.issue)}${a.financialImpact != null ? ` (${esc(formatCurrency(a.financialImpact))})` : ""}</div>
        </td></tr></table>`
      )
      .join("")}
    ${input.alerts.length > items.length ? `<p style="margin:0 0 14px;font-size:13px;color:${MUTED};">and ${input.alerts.length - items.length} more on your dashboard.</p>` : ""}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="background:${NAVY};border-radius:8px;">
      <a href="${esc(link("/dashboard"))}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Open your dashboard</a>
    </td></tr></table>
  </td></tr>
  <tr><td style="padding:4px 28px 24px;"><div style="border-top:1px solid ${BORDER};padding-top:14px;font-size:12px;line-height:1.6;color:${MUTED};">
    Each alert is sent once per job. ${isOwner ? "" : `${esc(input.ownerEmail ?? "The account owner")} added you as a recipient. `}<a href="${esc(link("/dashboard/settings"))}" style="color:${MUTED};">Turn alerts off in Settings</a> &middot; <a href="${esc(unsub)}" style="color:${MUTED};">Stop all emails about this company</a>${
      input.hasOtherCompanies ? ` &middot; <a href="${esc(unsubAll)}" style="color:${MUTED};">Stop them for every company on this account</a>` : ""
    }<br>
    ${esc(COMPANY_LEGAL_NAME)}, ${esc(COMPANY_MAILING_ADDRESS)}.
  </div></td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    `Profit alert: ${input.companyName}`,
    "",
    ...items.map((a) => `- ${a.jobName}: ${a.issue}${a.financialImpact != null ? ` (${formatCurrency(a.financialImpact)})` : ""} ${jobUrl(a.jobId)}`),
    "",
    `Open your dashboard: ${link("/dashboard")}`,
    `Turn alerts off in Settings: ${link("/dashboard/settings")}`,
    `Stop all emails about this company: ${unsub}`,
    ...(input.hasOtherCompanies ? [`Stop them for every company on this account: ${unsubAll}`] : []),
  ].join("\n");
  return {
    subject,
    html,
    text,
    headers: {
      "List-Unsubscribe": `<${unsub}>, <mailto:${SUPPORT_EMAIL}?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

const ALERT_LABELS: Record<string, string> = {
  over_budget: "Over its estimate",
  forecast_below_target: "Forecast below target",
  underbilled: "Work done, not billed",
};
