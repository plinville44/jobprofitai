import { NextRequest, NextResponse } from "next/server";
import { turnOffTipsEmails, verifyTipsToken } from "@/lib/emailPreferences";

/**
 * GET  /api/email/tips-off?u=&t=  shows a confirmation page (link scanners
 *      open every link, so GET never changes anything).
 * POST /api/email/tips-off?u=&t=  turns tips and reminders off for that login.
 *      Also the one-click unsubscribe mail apps call (List-Unsubscribe-Post).
 *
 * The link is signed for one login, so it can only ever turn off that
 * login's tips. Account, billing and security emails are unaffected.
 */
const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title: string, body: string, form = ""): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:#F6F7F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="max-width:480px;margin:48px auto;background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:28px;">
<h1 style="margin:0 0 12px;font-size:20px;color:#1E3A8A;">${esc(title)}</h1><p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#1F2937;">${body}</p>${form}
</div></body></html>`;
  return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function parse(req: NextRequest): { userId: string | null; action: string } {
  const u = req.nextUrl.searchParams.get("u") ?? "";
  const t = req.nextUrl.searchParams.get("t") ?? "";
  const valid = u !== "" && t !== "" && verifyTipsToken(u, t);
  return { userId: valid ? u : null, action: `${req.nextUrl.pathname}?u=${encodeURIComponent(u)}&t=${encodeURIComponent(t)}` };
}

export async function GET(req: NextRequest) {
  const { userId, action } = parse(req);
  if (!userId) return page("This link isn't valid", "It may have been copied incompletely. Reply to any of our emails and we'll take care of it.");
  return page(
    "Stop tips and reminders?",
    "This stops emails with product tips, setup reminders, feedback requests and trial offers. Emails about your account, billing, security and your trial dates still arrive.",
    `<form method="post" action="${esc(action)}"><button type="submit" style="background:#1E3A8A;color:#fff;border:0;border-radius:8px;padding:12px 22px;font-size:15px;font-weight:600;cursor:pointer;">Stop tips and reminders</button></form>`
  );
}

export async function POST(req: NextRequest) {
  const { userId } = parse(req);
  if (!userId) return page("This link isn't valid", "It may have been copied incompletely. Reply to any of our emails and we'll take care of it.");
  await turnOffTipsEmails(userId);
  return page("Done", "You won't get tips and reminders from JobProfitAI any more. Emails about your account and billing still arrive.");
}
