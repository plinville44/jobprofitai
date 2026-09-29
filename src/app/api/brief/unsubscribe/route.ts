import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyUnsubscribe } from "@/lib/email/briefEmail";

/**
 * GET  /api/brief/unsubscribe?c=&e=&t=[&all=1]  shows a confirmation page.
 * POST /api/brief/unsubscribe?c=&e=&t=[&all=1]  removes that address from
 *      the company's email recipients (the Weekly Profit Brief and profit
 *      alerts go to the same list). Also what mail apps call for one-click
 *      unsubscribe (List-Unsubscribe-Post), which is always this one company.
 *
 * With all=1 it removes the address from every company on the same account.
 * A firm owner with forty client companies gets forty briefs, and making
 * them stop one company at a time invites marking them as spam instead.
 *
 * The link is signed for one company and one address, so either way it can
 * only ever remove the person it was sent to, and only from companies on
 * the account that emailed them. GET never changes anything, because link
 * scanners in mail systems open every link in a message.
 */
const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title: string, body: string, forms: string[] = []): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:#F6F7F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="max-width:480px;margin:48px auto;background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:28px;">
<h1 style="margin:0 0 12px;font-size:20px;color:#1E3A8A;">${esc(title)}</h1><p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#1F2937;">${body}</p>${forms.join("")}
</div></body></html>`;
  return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function button(action: string, label: string, primary: boolean): string {
  const style = primary
    ? "background:#1E3A8A;color:#fff;border:0;"
    : "background:#fff;color:#1E3A8A;border:1px solid #1E3A8A;";
  return `<form method="post" action="${esc(action)}" style="margin:0 0 10px;"><button type="submit" style="${style}border-radius:8px;padding:12px 22px;font-size:15px;font-weight:600;cursor:pointer;">${esc(label)}</button></form>`;
}

function parse(req: NextRequest) {
  const c = req.nextUrl.searchParams.get("c") ?? "";
  const e = req.nextUrl.searchParams.get("e") ?? "";
  const t = req.nextUrl.searchParams.get("t") ?? "";
  const email = c && e && t ? verifyUnsubscribe(c, e, t) : null;
  return { connectionId: c, email, all: req.nextUrl.searchParams.get("all") === "1", base: `${req.nextUrl.pathname}?c=${encodeURIComponent(c)}&e=${encodeURIComponent(e)}&t=${encodeURIComponent(t)}` };
}

const isRecipient = (recipients: string[], email: string) => recipients.some((r) => r.trim().toLowerCase() === email);

export async function GET(req: NextRequest) {
  const { connectionId, email, all, base } = parse(req);
  if (!email) return page("This link isn't valid", "It may have been copied incompletely. You can change who gets the brief in Settings.");

  const connection = await prisma.quickBooksConnection.findUnique({
    where: { id: connectionId },
    select: { userId: true, companyName: true },
  });
  const company = connection?.companyName ?? "this company";
  // Other companies on the same account that email this address.
  const others = connection
    ? (
        await prisma.quickBooksConnection.findMany({
          where: { userId: connection.userId, id: { not: connectionId }, disconnectedAt: null },
          select: { emailRecipients: true },
        })
      ).filter((c) => isRecipient(c.emailRecipients, email)).length
    : 0;

  const who = `<strong>${esc(email)}</strong>`;
  const oneForm = button(base, "Stop sending it to me", !all || others === 0);
  const allForm = others > 0 ? button(`${base}&all=1`, `Stop them for all ${others + 1} companies`, all) : "";
  if (all && others > 0) {
    return page(
      "Stop JobProfitAI emails for every company?",
      `This stops the Weekly Profit Brief and profit alerts to ${who} for all ${others + 1} companies on this JobProfitAI account. Nothing else changes. Or stop them for ${esc(company)} only.`,
      [allForm, button(base, `Only ${company}`, false)]
    );
  }
  return page(
    "Stop the Weekly Profit Brief?",
    `This stops the Weekly Profit Brief and profit alerts to ${who} for ${esc(company)}. Nothing else changes.${
      others > 0 ? ` This account emails you about ${others} other ${others === 1 ? "company" : "companies"} too; you can stop those as well.` : ""
    }`,
    [oneForm, allForm]
  );
}

export async function POST(req: NextRequest) {
  const { connectionId, email, all } = parse(req);
  if (!email) return page("This link isn't valid", "Nothing was changed.");
  const connection = await prisma.quickBooksConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, userId: true, emailRecipients: true },
  });
  if (!connection) return page("You're unsubscribed", "This address won't get emails about this company any more.");

  // Every company on the account for "all", including disconnected ones, so
  // reconnecting one doesn't start the emails again.
  const targets = all
    ? await prisma.quickBooksConnection.findMany({ where: { userId: connection.userId }, select: { id: true, emailRecipients: true } })
    : [connection];
  let removed = 0;
  for (const c of targets) {
    const remaining = c.emailRecipients.filter((r) => r.trim().toLowerCase() !== email);
    if (remaining.length === c.emailRecipients.length) continue;
    removed++;
    await prisma.quickBooksConnection.update({
      where: { id: c.id },
      // With nobody left to send to, the brief is switched off rather than
      // left on with an empty list.
      data: { emailRecipients: remaining, ...(remaining.length === 0 ? { emailEnabled: false } : {}) },
    });
  }
  return page(
    "You're unsubscribed",
    all && removed > 1
      ? `The Weekly Profit Brief and profit alerts won't be sent to this address for any of the ${removed} companies on this account. The account owner can add you back in Settings.`
      : "The Weekly Profit Brief and profit alerts won't be sent to this address for this company any more. The account owner can add you back in Settings."
  );
}
