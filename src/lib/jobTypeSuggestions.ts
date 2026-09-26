import { AI_MODEL, anthropic } from "./ai";
import { prisma } from "./prisma";
import { getJobTypes } from "./jobTypesServer";
import { selectableJobTypes, suggestJobType, suggestJobTypeFromEstimateLines, type CompanyJobType } from "./jobTypes";
import { buildJobIndex, resolveJob, type EstimateLine } from "./qboNormalize";
import { contractEstimates } from "./opportunities";

/**
 * Suggested job types for jobs that don't have one.
 *
 * Job type is the one thing QuickBooks can't tell us, and every comparison in
 * the Profit Opportunity Feed groups by it. These are SUGGESTIONS: nothing
 * is applied until the contractor accepts it, because a wrong type silently
 * puts a job in the wrong comparison.
 *
 * In order: a word in the job's name, the products and services on its
 * estimate, then (only when asked) AI reading the job and customer names.
 */

export interface JobTypeSuggestionRow {
  jobId: string;
  jobName: string;
  customerName: string | null;
  status: string;
  suggested: string | null;
  source: "name" | "estimate" | "ai" | null;
  reason: string | null;
  /** AI was asked about this job and couldn't tell from its name. */
  aiUnsure?: boolean;
}

export interface JobTypeSuggestionList {
  untyped: number;
  rows: JobTypeSuggestionRow[];
  /** Untyped jobs with no suggestion yet, which AI could be asked about. */
  withoutSuggestion: number;
}

export async function getJobTypeSuggestions(connectionId: string, types?: CompanyJobType[]): Promise<JobTypeSuggestionList> {
  const jobTypes = types ?? (await getJobTypes(connectionId));
  const selectable = new Set(selectableJobTypes(jobTypes).map((t) => t.value));
  const [jobs, allJobs, estimates] = await Promise.all([
    prisma.job.findMany({
      where: { connectionId, missingSince: null, category: null },
      select: { id: true, name: true, customerName: true, status: true, statusOverride: true, suggestedCategory: true, suggestionSource: true, suggestionReason: true },
      orderBy: { name: "asc" },
    }),
    prisma.job.findMany({ where: { connectionId }, select: { id: true, qboId: true, parentQboId: true } }),
    prisma.jobEstimate.findMany({ where: { connectionId }, select: { customerQboId: true, amount: true, status: true, txnDate: true, lines: true } }),
  ]);

  const index = buildJobIndex(allJobs);
  const linesByJob = new Map<string, { amount: number; status: string; txnDate: Date; lines: EstimateLine[] }[]>();
  for (const e of estimates) {
    const r = resolveJob(index, e.customerQboId);
    if (!r || !Array.isArray(e.lines)) continue;
    linesByJob.set(r.jobId, [
      ...(linesByJob.get(r.jobId) ?? []),
      { amount: Number(e.amount), status: e.status, txnDate: e.txnDate, lines: e.lines as unknown as EstimateLine[] },
    ]);
  }

  const rows: JobTypeSuggestionRow[] = jobs.map((j) => {
    const base = {
      jobId: j.id,
      jobName: j.name,
      customerName: j.customerName,
      status: j.statusOverride ?? j.status,
    };
    const byName = suggestJobType(j.name, jobTypes);
    if (byName) return { ...base, suggested: byName.value, source: "name" as const, reason: `"${byName.matchedOn}" in the job name` };
    const lines = contractEstimates(linesByJob.get(j.id) ?? []).flatMap((e) => e.lines);
    const byEstimate = suggestJobTypeFromEstimateLines(lines.map((l) => ({ name: l.n, amount: l.a })), jobTypes);
    if (byEstimate) return { ...base, suggested: byEstimate.value, source: "estimate" as const, reason: `"${byEstimate.matchedOn}" on the estimate` };
    if (j.suggestedCategory && j.suggestionSource === "ai" && selectable.has(j.suggestedCategory)) {
      return { ...base, suggested: j.suggestedCategory, source: "ai" as const, reason: j.suggestionReason ?? "Suggested by AI from the job and customer names" };
    }
    if (j.suggestionSource === "ai_none") {
      return { ...base, suggested: null, source: null, reason: "AI couldn't tell from the name", aiUnsure: true };
    }
    return { ...base, suggested: null, source: null, reason: null };
  });

  return { untyped: jobs.length, rows, withoutSuggestion: rows.filter((r) => !r.suggested && !r.aiUnsure).length };
}

const AI_BATCH = 60;
const AI_MAX_JOBS = 180;
/** One AI run per company in this window, however often the button is pressed. */
const AI_COOLDOWN_MS = 2 * 60_000;

export class SuggestionCooldownError extends Error {}

const SYSTEM_PROMPT = `You sort a contractor's jobs into the job types the contractor uses.

You get the contractor's job types (key and name) and a list of jobs, each with an id, the job's name and the customer's name, exactly as they appear in QuickBooks.

Rules:
- Only use a key from the list you were given. Never invent a type.
- If the name doesn't make the type reasonably clear, answer null. A person's or company's name alone ("Smith Residence", "Oak Street") says nothing about the work: answer null. A wrong type is worse than none.
- "reason" is at most 12 words and names the words in the job name you went on, e.g. "\\"primary suite\\" suggests a remodel".
- Return ONLY a JSON array, one element per job, in any order: { "id": string, "type": string or null, "reason": string }. No other text.`;

/**
 * Asks AI to suggest types for untyped jobs that the word rules couldn't
 * place, and stores the suggestions (never the types themselves). Sends the
 * job names, their customer names and the company's job type names, which
 * is what the Privacy Policy says AI features receive.
 */
export async function suggestJobTypesWithAI(connectionId: string): Promise<{ asked: number; suggested: number }> {
  const types = await getJobTypes(connectionId);
  const list = await getJobTypeSuggestions(connectionId, types);
  const selectable = selectableJobTypes(types);
  const keys = new Set(selectable.map((t) => t.value));
  // Jobs AI already couldn't place aren't asked again, so each press moves
  // on to jobs it hasn't seen and the cost of a press is bounded.
  const todo = list.rows.filter((r) => !r.suggested && !r.aiUnsure).slice(0, AI_MAX_JOBS);
  if (todo.length === 0 || selectable.length === 0) return { asked: 0, suggested: 0 };

  // One run per company per cooldown, claimed before any model call: the
  // update only succeeds for the first request, however many arrive at once,
  // and a run that fails still holds the slot.
  const claim = await prisma.quickBooksConnection.updateMany({
    where: { id: connectionId, OR: [{ aiSuggestAt: null }, { aiSuggestAt: { lt: new Date(Date.now() - AI_COOLDOWN_MS) } }] },
    data: { aiSuggestAt: new Date() },
  });
  if (claim.count === 0) throw new SuggestionCooldownError("AI suggestions were just asked for this company. Give it a couple of minutes before asking again.");

  const batches: (typeof todo)[] = [];
  for (let i = 0; i < todo.length; i += AI_BATCH) batches.push(todo.slice(i, i + AI_BATCH));
  const counts = await Promise.all(batches.map((batch) => suggestBatch(connectionId, batch, selectable, keys)));
  return { asked: todo.length, suggested: counts.reduce((s, n) => s + n, 0) };
}

async function suggestBatch(
  connectionId: string,
  batch: JobTypeSuggestionRow[],
  selectable: CompanyJobType[],
  keys: Set<string>
): Promise<number> {
  let suggested = 0;
  {
    const message = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: JSON.stringify(
            {
              jobTypes: selectable.map((t) => ({ key: t.value, name: t.label })),
              jobs: batch.map((r) => ({ id: r.jobId, job: r.jobName, customer: r.customerName })),
            },
            null,
            1
          ),
        },
      ],
    });
    const text = message.content.find((b) => b.type === "text");
    if (!text || text.type !== "text" || message.stop_reason === "max_tokens") return 0;
    let answers: { id?: unknown; type?: unknown; reason?: unknown }[];
    try {
      answers = JSON.parse(text.text.trim().replace(/^```(?:json)?\n?/, "").replace(/```$/, ""));
    } catch {
      return 0;
    }
    if (!Array.isArray(answers)) return 0;
    const ids = new Set(batch.map((r) => r.jobId));
    const answered = new Set<string>();
    for (const a of answers) {
      if (typeof a?.id !== "string" || !ids.has(a.id) || typeof a.type !== "string" || !keys.has(a.type)) continue;
      answered.add(a.id);
      const reason = typeof a.reason === "string" ? a.reason.replace(/[\u2013\u2014]/g, ",").slice(0, 120) : null;
      // Scoped to this company and to jobs still without a type, so a stale
      // answer can't overwrite a type set in the meantime.
      const res = await prisma.job.updateMany({
        where: { id: a.id, connectionId, category: null },
        data: { suggestedCategory: a.type, suggestionSource: "ai", suggestionReason: reason ? `AI: ${reason}` : "Suggested by AI from the job and customer names", suggestedAt: new Date() },
      });
      suggested += res.count;
    }
    // The rest were asked and left blank: marked, so they aren't sent again.
    const unsure = batch.map((r) => r.jobId).filter((id) => !answered.has(id));
    if (unsure.length) {
      await prisma.job.updateMany({
        where: { id: { in: unsure }, connectionId, category: null },
        data: { suggestedCategory: null, suggestionSource: "ai_none", suggestionReason: null, suggestedAt: new Date() },
      });
    }
  }
  return suggested;
}
