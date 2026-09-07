import { NextRequest, NextResponse } from "next/server";
import { startOfWeek } from "date-fns";
import { prisma } from "@/lib/prisma";
import { generateWeeklyDigestForConnection } from "@/lib/digest";
import { runSyncForConnection } from "@/lib/quickbooksSync";
import { authorizeCron } from "@/lib/cronAuth";
import { sendEmail } from "@/lib/email/client";

// Vercel Cron Jobs send a GET request on the configured schedule (see
// vercel.json - hourly, "0 * * * *"). This route runs once per hour and, for
// each connection whose emailDay/emailHour/emailTimezone matches the current
// hour *in that connection's own timezone*, syncs QuickBooks then sends that
// connection's weekly email. Running hourly (rather than once a week) is
// what lets each customer pick their own send day/time without needing a
// separate cron entry per customer.
export const maxDuration = 300; // multiple connections, each doing a QBO sync + possibly a Claude call

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function getLocalDayHour(date: Date, timeZone: string): { day: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);
  const weekdayAbbrev = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  let hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  if (hour === 24) hour = 0; // some locales render midnight as "24"
  const day = WEEKDAYS.indexOf(weekdayAbbrev);
  return { day: day === -1 ? 0 : day, hour };
}

export async function GET(req: NextRequest) {
  // Shared cron authorization (see src/lib/cronAuth.ts). Replaces an
  // earlier inline check that only enforced the secret when CRON_SECRET
  // happened to be set - meaning a missing env var in production silently
  // made this endpoint public, and anyone could trigger customer emails and
  // paid Anthropic calls on demand. authorizeCron fails closed in production.
  const auth = authorizeCron(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const now = new Date();
  const weekStarting = startOfWeek(now, { weekStartsOn: 1 }); // Monday, same label the manual digest button uses

  const connections = await prisma.quickBooksConnection.findMany({
    where: { disconnectedAt: null, emailEnabled: true },
  });

  const results: { connectionId: string; status: string; detail?: string }[] = [];

  // Every connection considered gets an entry in `results`, including ones
  // that simply aren't due this hour - a hovering cron with no output for
  // 167 out of every 168 runs (correct behavior) looks identical to "this is
  // broken and finding nothing" from the outside otherwise. Same "never
  // silently drop a gap" rule this project has applied everywhere else (see
  // Data Health), just applied to the cron's own diagnostics.
  for (const connection of connections) {
    try {
      const { day, hour } = getLocalDayHour(now, connection.emailTimezone);
      if (day !== connection.emailDay || hour !== connection.emailHour) {
        results.push({
          connectionId: connection.id,
          status: "not_due",
          detail: `configured for day ${connection.emailDay}, hour ${connection.emailHour} in ${connection.emailTimezone} - right now it's day ${day}, hour ${hour} there`,
        });
        continue;
      }
      if (connection.emailRecipients.length === 0) {
        results.push({ connectionId: connection.id, status: "skipped", detail: "no recipients configured" });
        continue;
      }

      // Idempotency: if this week's digest was already emailed (e.g. a retry
      // or a second cron invocation landed in the same target hour), don't
      // send it twice.
      const existing = await prisma.weeklyDigest.findUnique({
        where: { connectionId_weekStarting: { connectionId: connection.id, weekStarting } },
      });
      if (existing?.emailedAt) {
        results.push({ connectionId: connection.id, status: "skipped", detail: "already emailed this week" });
        continue;
      }

      // Sync first so the email reflects the freshest numbers, same
      // mechanics as the "Sync now" button (see runSyncForConnection).
      try {
        await runSyncForConnection(connection.id);
      } catch (syncErr) {
        // A sync failure shouldn't silently skip the email - fall through
        // and generate/send using whatever was already synced, but flag it.
        console.error(
          `weekly-email: sync failed for connection ${connection.id}:`,
          syncErr instanceof Error ? syncErr.message : "Unknown error"
        );
      }

      const companyName = connection.companyName ?? "your company";
      const { narrative, kind, metrics } = await generateWeeklyDigestForConnection(
        connection.id,
        weekStarting,
        companyName
      );

      const digest = await prisma.weeklyDigest.upsert({
        where: { connectionId_weekStarting: { connectionId: connection.id, weekStarting } },
        create: { connectionId: connection.id, weekStarting, metrics: metrics as any, narrative, kind },
        update: { metrics: metrics as any, narrative, kind },
      });

      // Routed through the shared email client rather than calling Resend
      // directly. That matters here specifically: the Resend v3 SDK RESOLVES
      // with `{ data: null, error }` on a rejected send instead of throwing,
      // so the previous try/catch around resend.emails.send() marked failed
      // digests as successfully emailed - and then stamped emailedAt, which
      // permanently suppressed the retry. sendEmail() checks the returned
      // error as well as catching thrown ones.
      const subject =
        kind === "narrative"
          ? `${companyName} - Job Profitability Digest, week of ${weekStarting.toLocaleDateString()}`
          : `${companyName} - Data Health notice, week of ${weekStarting.toLocaleDateString()}`;

      const sendResult = await sendEmail({
        to: connection.emailRecipients,
        subject,
        text: narrative,
        html: `<pre style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;white-space:pre-wrap;color:#1F2937;">${narrative
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}</pre>`,
      });
      const emailed = sendResult.ok;

      if (emailed) {
        await prisma.weeklyDigest.update({ where: { id: digest.id }, data: { emailedAt: new Date() } });
      }

      results.push({
        connectionId: connection.id,
        status: emailed ? "sent" : "generated_not_sent",
        detail: emailed
          ? kind
          : `digest saved, not emailed (${sendResult.error ?? "unknown reason"})`,
      });
    } catch (err) {
      // One connection's failure must never take down the rest of the run.
      console.error(
        `weekly-email: failed for connection ${connection.id}:`,
        err instanceof Error ? err.message : "Unknown error"
      );
      results.push({ connectionId: connection.id, status: "error", detail: err instanceof Error ? err.message : "Unknown error" });
    }
  }

  return NextResponse.json({
    ok: true,
    checkedAt: now.toISOString(),
    connectionsConsidered: connections.length, // 0 here means no connection has the weekly email turned on at all - different from "found some, none due this hour" (see per-connection results below)
    results,
  });
}
