import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

const OVERHEAD_METHODS = new Set(["pct_of_revenue", "pct_of_direct_cost"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const body = await req.json();
    const { connectionId } = body;
    if (!connectionId || typeof connectionId !== "string") {
      return NextResponse.json({ error: "Missing connectionId" }, { status: 400 });
    }

    const connection = await prisma.quickBooksConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.userId !== session.userId) {
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
      errors.push("Add at least one recipient to receive the weekly email, or turn it off.");
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
      errors.push("Choose a timezone for the weekly email.");
    }

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join(" ") }, { status: 400 });
    }

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
      },
    });

    return NextResponse.json({ ok: true });
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
