import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccount } from "@/lib/account";
import { JOB_TYPE_OPTIONS } from "@/lib/jobTypes";

const JOB_TYPES = new Set(JOB_TYPE_OPTIONS.map((o) => o.value).filter(Boolean));

const OVERHEAD_METHODS = new Set(["pct_of_revenue", "pct_of_direct_cost"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 10;

/**
 * POST /api/settings/profile
 * { connectionId, targetMarginPct, overheadEnabled, overheadMethod, overheadValue,
 *   emailEnabled, emailRecipients, emailDay, emailHour, emailTimezone }
 *
 * One route for the whole Settings form, matching the plan's "one route, one
 * form" scope. All values are validated server-side before write - never
 * trusts the client to have kept the form in a legal state. `overheadValue`
 * and `targetMarginPct` arrive from the UI as plain percentages (e.g. 12 for
 * 12%); overheadValue is converted to the fraction the calculation engine
 * expects (see profitability.ts) before it's stored, since that's already
 * documented there as "stored as a fraction, e.g. 0.12 for 12%". None of this
 * touches financial calculations themselves - this route only ever writes
 * configuration inputs, never a computed number.
 */
export async function POST(req: NextRequest) {
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const body = await req.json();
    const { connectionId } = body;
    if (!connectionId || typeof connectionId !== "string") {
      return NextResponse.json({ error: "Missing connectionId" }, { status: 400 });
    }

    const connection = await prisma.quickBooksConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.userId !== account.ownerId) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const errors: string[] = [];

    // Target margin: 0-100, or null/blank to clear it.
    let targetMarginPct: number | null = null;
    if (body.targetMarginPct !== null && body.targetMarginPct !== "" && body.targetMarginPct !== undefined) {
      const n = Number(body.targetMarginPct);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        errors.push("Target margin must be a number between 0 and 100.");
      } else {
        targetMarginPct = n;
      }
    }

    // Overhead allocation - only meaningful, and only stored, as a complete set.
    const overheadEnabled = Boolean(body.overheadEnabled);
    let overheadMethod: string | null = null;
    let overheadValue: number | null = null;
    if (overheadEnabled) {
      if (typeof body.overheadMethod !== "string" || !OVERHEAD_METHODS.has(body.overheadMethod)) {
        errors.push("Choose how overhead should be allocated.");
      } else {
        overheadMethod = body.overheadMethod;
      }
      const n = Number(body.overheadValue);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        errors.push("Overhead percentage must be a number between 0 and 100.");
      } else {
        overheadValue = n / 100;
      }
    }

    // Email preferences.
    const emailEnabled = Boolean(body.emailEnabled);
    const rawRecipients: string[] = Array.isArray(body.emailRecipients)
      ? body.emailRecipients
      : typeof body.emailRecipients === "string"
      ? body.emailRecipients.split(/[,\n]/)
      : [];
    const emailRecipients = Array.from(
      new Set(rawRecipients.map((e) => e.trim()).filter((e) => e.length > 0))
    );
    const invalidEmails = emailRecipients.filter((e) => !EMAIL_RE.test(e));
    if (invalidEmails.length > 0) {
      errors.push(`Not a valid email address: ${invalidEmails.join(", ")}`);
    }
    if (emailEnabled && emailRecipients.length === 0) {
      errors.push("Add at least one recipient for the Weekly Profit Brief, or turn it off.");
    }
    if (emailRecipients.length > MAX_RECIPIENTS) {
      errors.push(`The Weekly Profit Brief can go to up to ${MAX_RECIPIENTS} people.`);
    }

    const emailDay = Number(body.emailDay);
    if (!Number.isInteger(emailDay) || emailDay < 0 || emailDay > 6) {
      errors.push("Email day must be between Sunday and Saturday.");
    }
    const emailHour = Number(body.emailHour);
    if (!Number.isInteger(emailHour) || emailHour < 0 || emailHour > 23) {
      errors.push("Email hour must be between 0 and 23.");
    }
    const emailTimezone = typeof body.emailTimezone === "string" ? body.emailTimezone.trim() : "";
    if (!emailTimezone) {
      errors.push("Choose a timezone for the Weekly Profit Brief.");
    } else {
      // A zone name Intl doesn't know would make the weekly send throw every
      // hour for this company and never go out.
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: emailTimezone });
      } catch {
        errors.push("That timezone isn't recognised. Choose one from the list.");
      }
    }

    // How jobs are read from QuickBooks, and whether labor comes from time
    // entries. Changing either rebuilds the company's jobs and costs on the
    // next sync, so both are only written when they are actually sent.
    let jobSource: string | undefined;
    if ("jobSource" in body) {
      if (body.jobSource === "projects" || body.jobSource === "customers") jobSource = body.jobSource;
      else errors.push("Choose how jobs are set up in QuickBooks.");
    }
    const laborFromTimeEntries = "laborFromTimeEntries" in body ? Boolean(body.laborFromTimeEntries) : undefined;
    const alertsEnabled = "alertsEnabled" in body ? Boolean(body.alertsEnabled) : undefined;

    // Per-job-type target margins: { roofing: 22, remodel: "" }. Blank removes.
    const marginTargets: { category: string; targetPct: number | null }[] = [];
    if (body.marginTargets && typeof body.marginTargets === "object") {
      for (const [category, raw] of Object.entries(body.marginTargets as Record<string, unknown>)) {
        if (!JOB_TYPES.has(category)) continue;
        if (raw === null || raw === "" || raw === undefined) {
          marginTargets.push({ category, targetPct: null });
          continue;
        }
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > 100) errors.push("Job type targets must be between 0 and 100.");
        else marginTargets.push({ category, targetPct: n });
      }
    }

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join(" ") }, { status: 400 });
    }

    const rebuild =
      (jobSource !== undefined && jobSource !== connection.jobSource) ||
      (laborFromTimeEntries !== undefined && laborFromTimeEntries !== connection.laborFromTimeEntries);

    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: {
        targetMarginPct,
        overheadEnabled,
        overheadMethod,
        overheadValue,
        emailEnabled,
        emailRecipients,
        emailDay,
        emailHour,
        emailTimezone,
        ...(jobSource !== undefined ? { jobSource } : {}),
        ...(laborFromTimeEntries !== undefined ? { laborFromTimeEntries } : {}),
        ...(alertsEnabled !== undefined ? { alertsEnabled } : {}),
        // Forces a full sync next time: an incremental one only reads what
        // changed in QuickBooks, and this changes how everything is read.
        ...(rebuild ? { lastFullSyncAt: null } : {}),
      },
    });

    for (const t of marginTargets) {
      if (t.targetPct == null) {
        await prisma.marginTarget.deleteMany({ where: { connectionId: connection.id, category: t.category } });
      } else {
        await prisma.marginTarget.upsert({
          where: { connectionId_category: { connectionId: connection.id, category: t.category } },
          create: { connectionId: connection.id, category: t.category, targetPct: t.targetPct },
          update: { targetPct: t.targetPct },
        });
      }
    }

    return NextResponse.json({ ok: true, rebuild });
  } catch (err) {
    // Message only, never the full error object - same reasoning as the
    // other API routes (see api/quickbooks/sync/route.ts).
    console.error("settings/profile failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't save settings." },
      { status: 500 }
    );
  }
}
