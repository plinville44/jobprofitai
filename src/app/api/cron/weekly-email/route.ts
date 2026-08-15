import { NextRequest, NextResponse } from "next/server";
import { startOfWeek } from "date-fns";
import { Resend } from "resend";
import { prisma } from "@/lib/prisma";
import { generateWeeklyDigestForConnection } from "@/lib/digest";
import { runSyncForConnection } from "@/lib/quickbooksSync";

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
  // Vercel automatically sends `Authorization: Bearer $CRON_SECRET` on its
  // own scheduled invocations once CRON_SECRET is set as an env var - this
  // is the documented Vercel Cron protection pattern, so a request without
  // the right secret is rejected rather than letting anyone trigger emails.
  if (process.env.CRON_SECRET) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const now = new Date();
  const weekStarting = startOfWeek(now, { weekStartsOn: 1 }); // Monday, same label the manual digest button uses

  const connections = await prisma.quickBooksConnection.findMany({
    where: { disconnectedAt: null, emailEnabled: true },
  });

  const results: { connectionId: string; status: string; detail?: string }[] = [];

  for (const connection of connections) {
    try {
      const { day, hour } = getLocalDayHour(now, connection.emailTimezone);
      if (day !== connection.emailDay || hour !== connection.emailHour) {
        continue; // not this connection's send time this hour
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

      let emailed = false;
      if (process.env.RESEND_API_KEY) {
        try {
          const resend = new Resend(process.env.RESEND_API_KEY);
          await resend.emails.send({
            from: process.env.DIGEST_FROM_EMAIL ?? "JobProfitAI <digest@jobprofitai.com>",
            to: connection.emailRecipients,
            subject:
              kind === "narrative"
                ? `${companyName} - Job Profitability Digest, week of ${weekStarting.toLocaleDateString()}`
                : `${companyName} - Data Health notice, week of ${weekStarting.toLocaleDateString()}`,
            text: narrative,
          });
          emailed = true;
        } catch (emailErr) {
          console.error(
            `weekly-email: send failed for connection ${connection.id}:`,
            emailErr instanceof Error ? emailErr.message : "Unknown error"
          );
        }
      }

      if (emailed) {
        await prisma.weeklyDigest.update({ where: { id: digest.id }, data: { emailedAt: new Date() } });
      }

      results.push({
        connectionId: connection.id,
        status: emailed ? "sent" : "generated_not_sent",
        detail: emailed ? kind : "RESEND_API_KEY not configured or send failed - digest saved, not emailed",
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

  return NextResponse.json({ ok: true, checkedAt: now.toISOString(), results });
}
