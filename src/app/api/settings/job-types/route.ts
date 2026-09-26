import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { connectionForAccount, getAccount } from "@/lib/account";
import { refuseCrossSite } from "@/lib/sameOrigin";
import { getJobTypes } from "@/lib/jobTypesServer";
import { BUILT_IN_JOB_TYPE_KEYS, cleanJobTypeLabel, customJobTypeKey, MAX_CUSTOM_JOB_TYPES } from "@/lib/jobTypes";

/**
 * POST /api/settings/job-types
 *   { connectionId, action: "add", label }
 *   { connectionId, action: "rename", key, label }
 *   { connectionId, action: "hide" | "show", key }
 *
 * A company's job types. Keys never change, so renaming a type leaves every
 * job, target and tracked change on it untouched. Nothing is deleted: a type
 * nobody uses any more is hidden.
 */
/**
 * Jobs AI couldn't place are asked again once the list of types changes: a
 * new "Service call" type may be exactly what "Furnace tune-up" needed.
 */
async function forgetAiUnsure(connectionId: string) {
  await prisma.job.updateMany({
    where: { connectionId, suggestionSource: "ai_none" },
    data: { suggestionSource: null, suggestedAt: null },
  });
}

export async function POST(req: NextRequest) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const connection = await connectionForAccount(account, body?.connectionId);
    if (!connection) return NextResponse.json({ error: "Company not found" }, { status: 404 });

    const types = await getJobTypes(connection.id);
    const action = body?.action;

    if (action === "add") {
      const label = cleanJobTypeLabel(body?.label);
      if (!label) return NextResponse.json({ error: "Type a name for the job type." }, { status: 400 });
      if (types.some((t) => t.label.toLowerCase() === label.toLowerCase())) {
        return NextResponse.json({ error: `You already have a job type called ${label}.` }, { status: 400 });
      }
      if (types.filter((t) => !t.builtIn).length >= MAX_CUSTOM_JOB_TYPES) {
        return NextResponse.json({ error: `That's the limit of ${MAX_CUSTOM_JOB_TYPES} job types of your own. Hide or rename one instead.` }, { status: 400 });
      }
      const key = customJobTypeKey(label, types.map((t) => t.value));
      const count = await prisma.jobType.count({ where: { connectionId: connection.id } });
      await prisma.jobType.create({ data: { connectionId: connection.id, key, label, sortOrder: count } });
      await forgetAiUnsure(connection.id);
      return NextResponse.json({ ok: true, key });
    }

    const key = typeof body?.key === "string" ? body.key : "";
    const current = types.find((t) => t.value === key);
    if (!current) return NextResponse.json({ error: "That job type wasn't found." }, { status: 404 });

    if (action === "rename") {
      const label = cleanJobTypeLabel(body?.label);
      if (!label) return NextResponse.json({ error: "Type a name for the job type." }, { status: 400 });
      if (types.some((t) => t.value !== key && t.label.toLowerCase() === label.toLowerCase())) {
        return NextResponse.json({ error: `You already have a job type called ${label}.` }, { status: 400 });
      }
      await prisma.jobType.upsert({
        where: { connectionId_key: { connectionId: connection.id, key } },
        create: { connectionId: connection.id, key, label, hidden: current.hidden },
        update: { label },
      });
      await forgetAiUnsure(connection.id);
      return NextResponse.json({ ok: true });
    }

    if (action === "hide" || action === "show") {
      const hidden = action === "hide";
      await prisma.jobType.upsert({
        where: { connectionId_key: { connectionId: connection.id, key } },
        // A built-in type gets a row the first time it's changed.
        create: { connectionId: connection.id, key, label: current.label, hidden },
        update: { hidden },
      });
      if (!hidden) await forgetAiUnsure(connection.id);
      // Suggestions for a type that's now hidden are dropped.
      if (hidden) {
        await prisma.job.updateMany({
          where: { connectionId: connection.id, suggestedCategory: key },
          data: { suggestedCategory: null, suggestionSource: null, suggestionReason: null, suggestedAt: null },
        });
      }
      return NextResponse.json({ ok: true, builtIn: BUILT_IN_JOB_TYPE_KEYS.includes(key) });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    console.error("settings/job-types failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json({ error: "Couldn't save that. Please try again." }, { status: 500 });
  }
}
