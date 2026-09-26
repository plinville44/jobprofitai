import crypto from "crypto";
import { COMPANY_LEGAL_NAME, COMPANY_MAILING_ADDRESS } from "@/lib/company";
import { formatCurrency, formatDate } from "@/lib/format";
import type { ConnectionMetrics } from "@/lib/profitability";
import { jobChangeSentence, type WeekOverWeekReport } from "@/lib/weekOverWeek";
import type { BriefHeadline } from "@/lib/briefHeadline";
import { SUPPORT_EMAIL } from "./client";
import { appUrl } from "./templates";

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

export function unsubscribeUrl(connectionId: string, email: string): string {
  const e = Buffer.from(email.trim().toLowerCase()).toString("base64url");
  return appUrl(`/api/brief/unsubscribe?c=${encodeURIComponent(connectionId)}&e=${e}&t=${unsubscribeSig(connectionId, email)}`);
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
  recipient: string;
  ownerEmail: string | null;
}

export function renderBriefEmail(input: BriefEmailInput): { subject: string; html: string; text: string; headers: Record<string, string> } {
  const { metrics, weekOverWeek: wow } = input;
  const week = formatDate(input.weekStarting);
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
                  `<li style="margin:0 0 6px;font-size:14px;line-height:1.5;color:${TEXT};"><a href="${esc(appUrl(t.href))}" style="color:${NAVY};font-weight:600;text-decoration:none;">${esc(t.title)}</a>${
                    t.impact != null ? ` <span style="color:${MUTED};">(${esc(formatCurrency(t.impact))} ${esc(t.impactLabel)})</span>` : ""
                  }</li>`
              )
              .join("")}</ul>`
          : ""
      }
      <a href="${appUrl("/dashboard/opportunities")}" style="display:inline-block;margin-top:6px;font-size:14px;font-weight:600;color:${NAVY};">See what to change, and what it's worth</a>
    </div>`
    : "";

  const inBrief = new Set(metrics.briefJobIds);
  const briefJobs = metrics.jobs.filter((j) => inBrief.has(j.jobId));
  const overBudget = briefJobs.filter((j) => j.status === "open" && j.varianceVsEstimatePct != null && j.varianceVsEstimatePct > 0.1).length;
  const underBilled = briefJobs.reduce((s, j) => s + (j.overUnderBilling != null && j.overUnderBilling < 0 ? -j.overUnderBilling : 0), 0);
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

  const jobUrl = (id: string) => appUrl(`/dashboard/jobs/${id}`);
  const changes = wow.changes.slice(0, 8);
  const hidden = wow.changes.length - changes.length;
  const since = wow.comparedToWeekStarting ? `since the brief for the week of ${formatDate(wow.comparedToWeekStarting)}` : "";

  const changesHtml = wow.noComparisonReason
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${MUTED};">${
        wow.noComparisonReason === "first_brief"
          ? "This is the first Weekly Profit Brief for this company. From next week this section lists what moved in your books since the previous one."
          : "The previous brief's figures couldn't be read, so there's no comparison this week."
      }</p>`
    : changes.length === 0
      ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${MUTED};">Nothing changed on your jobs in QuickBooks ${esc(since)}.</p>`
      : `<ul style="margin:0 0 16px;padding-left:18px;">${changes
          .map(
            (c) =>
              `<li style="margin:0 0 8px;font-size:15px;line-height:1.5;color:${TEXT};">${
                c.removed ? `<strong>${esc(c.jobName)}</strong>` : `<a href="${jobUrl(c.jobId)}" style="color:${NAVY};font-weight:600;text-decoration:none;">${esc(c.jobName)}</a>`
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

  const unsub = unsubscribeUrl(input.connectionId, input.recipient);
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
    <a href="${appUrl("/dashboard")}"><img src="${appUrl("/jobprofitai-wordmark@1x.png")}" alt="JobProfitAI" width="170" style="display:block;border:0;width:170px;max-width:55%;height:auto;"></a>
  </td></tr>
  <tr><td style="padding:18px 28px 4px;">
    <div style="font-size:13px;color:${MUTED};">${esc(input.kind === "narrative" ? "Weekly Profit Brief" : "Data Health notice")} &middot; week of ${esc(week)}</div>
    <h1 style="margin:4px 0 18px;font-size:22px;line-height:1.3;color:${NAVY};">${esc(input.companyName)}</h1>
    ${headlineHtml}
    ${tilesHtml}
    <h2 style="margin:0 0 10px;font-size:15px;text-transform:uppercase;letter-spacing:.04em;color:${MUTED};">What changed ${esc(since)}</h2>
    ${changesHtml}
    <h2 style="margin:8px 0 10px;font-size:15px;text-transform:uppercase;letter-spacing:.04em;color:${MUTED};">${input.kind === "narrative" ? "The summary" : "Why there is no summary this week"}</h2>
    ${bodyHtml}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="background:${NAVY};border-radius:8px;">
      <a href="${appUrl("/dashboard")}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Open your dashboard</a>
    </td></tr></table>
    ${
      input.kind === "narrative"
        ? `<p style="margin:0 0 16px;font-size:12px;color:${MUTED};">"What changed" and every figure above are calculated from your QuickBooks data. The summary is written by AI from those same figures.</p>`
        : ""
    }
  </td></tr>
  <tr><td style="padding:4px 28px 24px;">
    <div style="border-top:1px solid ${BORDER};padding-top:14px;font-size:12px;line-height:1.6;color:${MUTED};">
      ${esc(why)} <a href="${unsub}" style="color:${MUTED};">Stop getting this email</a> &middot;
      <a href="${appUrl("/dashboard/settings")}" style="color:${MUTED};">Change the day and time</a><br>
      Questions? Reply, or write to <a href="mailto:${SUPPORT_EMAIL}" style="color:${MUTED};">${SUPPORT_EMAIL}</a>.<br>
      ${esc(COMPANY_LEGAL_NAME)}, ${esc(COMPANY_MAILING_ADDRESS)}. QuickBooks is a trademark of Intuit Inc.
    </div>
  </td></tr>
</table></td></tr></table></body></html>`;

  const textChanges = wow.noComparisonReason
    ? "This is the first Weekly Profit Brief for this company, so there is nothing to compare against yet."
    : changes.length === 0
      ? `Nothing changed on your jobs in QuickBooks ${since}.`
      : changes.map((c) => `- ${c.jobName}: ${jobChangeSentence(c)}`).join("\n") + (hidden > 0 ? `\n${hidden} more jobs also changed.` : "");
  const text = [
    `${input.companyName}: ${input.kind === "narrative" ? "Weekly Profit Brief" : "Data Health notice"}, week of ${week}`,
    "",
    ...(hl
      ? [
          hl.headline,
          hlTiles.map((t) => `${t.label}: ${formatCurrency(t.value)}`).join(" | "),
          ...hl.snapshot.top.map((t) => `- ${t.title}${t.impact != null ? ` (${formatCurrency(t.impact)} ${t.impactLabel})` : ""}`),
          `What to change, and what it's worth: ${appUrl("/dashboard/opportunities")}`,
          "",
        ]
      : []),
    tiles.map((t) => `${t.label}: ${t.value}`).join(" | "),
    "",
    `WHAT CHANGED ${since.toUpperCase()}`.trim(),
    textChanges,
    "",
    input.body,
    "",
    `Open your dashboard: ${appUrl("/dashboard")}`,
    "",
    "---",
    why,
    `Stop getting this email: ${unsub}`,
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
}): { subject: string; html: string; text: string; headers: Record<string, string> } {
  const first = input.alerts[0];
  const subject =
    input.alerts.length === 1
      ? `${input.companyName}: ${first.jobName} needs a look`
      : `${input.companyName}: ${input.alerts.length} jobs need a look`;
  const unsub = unsubscribeUrl(input.connectionId, input.recipient);
  const isOwner = input.ownerEmail != null && input.ownerEmail.toLowerCase() === input.recipient.toLowerCase();
  const items = input.alerts.slice(0, 10);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <tr><td style="padding:24px 28px 0;"><a href="${appUrl("/dashboard")}"><img src="${appUrl("/jobprofitai-wordmark@1x.png")}" alt="JobProfitAI" width="170" style="display:block;border:0;width:170px;max-width:55%;height:auto;"></a></td></tr>
  <tr><td style="padding:18px 28px 4px;">
    <div style="font-size:13px;color:${MUTED};">Profit alert</div>
    <h1 style="margin:4px 0 16px;font-size:22px;line-height:1.3;color:${NAVY};">${esc(input.companyName)}</h1>
    <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${TEXT};">Last night's QuickBooks sync turned up ${items.length === 1 ? "something" : "a few things"} worth a look before the weekly brief:</p>
    ${items
      .map(
        (a) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;"><tr><td style="border:1px solid ${BORDER};border-radius:8px;padding:12px 14px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:${RED};">${esc(ALERT_LABELS[a.kind] ?? "Needs a look")}</div>
          <div style="margin-top:4px;font-size:15px;font-weight:600;"><a href="${appUrl(`/dashboard/jobs/${a.jobId}`)}" style="color:${NAVY};text-decoration:none;">${esc(a.jobName)}</a></div>
          <div style="margin-top:2px;font-size:14px;color:${TEXT};">${esc(a.issue)}${a.financialImpact != null ? ` (${esc(formatCurrency(a.financialImpact))})` : ""}</div>
        </td></tr></table>`
      )
      .join("")}
    ${input.alerts.length > items.length ? `<p style="margin:0 0 14px;font-size:13px;color:${MUTED};">and ${input.alerts.length - items.length} more on your dashboard.</p>` : ""}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="background:${NAVY};border-radius:8px;">
      <a href="${appUrl("/dashboard")}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Open your dashboard</a>
    </td></tr></table>
  </td></tr>
  <tr><td style="padding:4px 28px 24px;"><div style="border-top:1px solid ${BORDER};padding-top:14px;font-size:12px;line-height:1.6;color:${MUTED};">
    Each alert is sent once per job. ${isOwner ? "" : `${esc(input.ownerEmail ?? "The account owner")} added you as a recipient. `}<a href="${appUrl("/dashboard/settings")}" style="color:${MUTED};">Turn alerts off in Settings</a> &middot; <a href="${unsub}" style="color:${MUTED};">Stop all emails about this company</a><br>
    ${esc(COMPANY_LEGAL_NAME)}, ${esc(COMPANY_MAILING_ADDRESS)}.
  </div></td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    `Profit alert: ${input.companyName}`,
    "",
    ...items.map((a) => `- ${a.jobName}: ${a.issue}${a.financialImpact != null ? ` (${formatCurrency(a.financialImpact)})` : ""} ${appUrl(`/dashboard/jobs/${a.jobId}`)}`),
    "",
    `Open your dashboard: ${appUrl("/dashboard")}`,
    `Turn alerts off in Settings: ${appUrl("/dashboard/settings")}`,
    `Stop all emails about this company: ${unsub}`,
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
