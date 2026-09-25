import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyUnsubscribe } from "@/lib/email/briefEmail";

/**
 * GET  /api/brief/unsubscribe?c=&e=&t=  shows a one-button confirmation page.
 * POST /api/brief/unsubscribe?c=&e=&t=  removes that address from the
 *      company's Weekly Profit Brief recipients. Also what mail apps call
 *      for one-click unsubscribe (List-Unsubscribe-Post).
 *
 * The link is signed for one company and one address, so it can only ever
 * remove the person it was sent to. GET never changes anything, because
 * link scanners in mail systems open every link in a message.
 */
function page(title: string, body: string, form?: string): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#F6F7F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="max-width:480px;margin:48px auto;background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:28px;">
<h1 style="margin:0 0 12px;font-size:20px;color:#1E3A8A;">${title}</h1><p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#1F2937;">${body}</p>${form ?? ""}
</div></body></html>`;
  return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function parse(req: NextRequest) {
  const c = req.nextUrl.searchParams.get("c") ?? "";
  const e = req.nextUrl.searchParams.get("e") ?? "";
  const t = req.nextUrl.searchParams.get("t") ?? "";
  const email = c && e && t ? verifyUnsubscribe(c, e, t) : null;
  return { connectionId: c, email };
}

export async function GET(req: NextRequest) {
  const { email } = parse(req);
  if (!email) return page("This link isn't valid", "It may have been copied incompletely. You can change who gets the brief in Settings.");
  const action = req.nextUrl.pathname + req.nextUrl.search;
  return page(
    "Stop the Weekly Profit Brief?",
    `This stops the weekly email to <strong>${email.replace(/</g, "&lt;")}</strong> for this company. Nothing else changes.`,
    `<form method="post" action="${action.replace(/"/g, "&quot;")}"><button type="submit" style="background:#1E3A8A;color:#fff;border:0;border-radius:8px;padding:12px 22px;font-size:15px;font-weight:600;cursor:pointer;">Stop sending it to me</button></form>`
  );
}

export async function POST(req: NextRequest) {
  const { connectionId, email } = parse(req);
  if (!email) return page("This link isn't valid", "Nothing was changed.");
  const connection = await prisma.quickBooksConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, emailRecipients: true },
  });
  if (connection) {
    const remaining = connection.emailRecipients.filter((r) => r.trim().toLowerCase() !== email);
    if (remaining.length !== connection.emailRecipients.length) {
      await prisma.quickBooksConnection.update({
        where: { id: connection.id },
        // With nobody left to send to, the brief is switched off rather than
        // left on with an empty list.
        data: { emailRecipients: remaining, ...(remaining.length === 0 ? { emailEnabled: false } : {}) },
      });
    }
  }
  return page("You're unsubscribed", "The Weekly Profit Brief won't be sent to this address any more. The account owner can add you back in Settings.");
}
