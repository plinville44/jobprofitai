import { NextRequest, NextResponse } from "next/server";
import { connectionForAccount, getAccount, refuseClient } from "@/lib/account";
import { getEntitlements, inactiveMessage } from "@/lib/entitlements";
import { refuseCrossSite } from "@/lib/sameOrigin";
import { SuggestionCooldownError, suggestJobTypesWithAI } from "@/lib/jobTypeSuggestions";
import { overLimitConnectionIds } from "@/lib/planLimits";
import { aiFailureKind } from "@/lib/ai";
import { reportError } from "@/lib/monitoring";

export const maxDuration = 120;

/**
 * POST /api/jobs/suggest-types  { connectionId }
 *
 * Asks AI to suggest job types for untyped jobs the word rules couldn't
 * place. Stores suggestions only; the contractor accepts them on the Jobs
 * page.
 */
export async function POST(req: NextRequest) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const refused = refuseClient(account);
    if (refused) return refused;
    const entitlements = await getEntitlements(account.ownerId);
    if (!entitlements.active) return NextResponse.json({ error: inactiveMessage(entitlements) }, { status: 402 });
    const body = await req.json().catch(() => ({}));
    const connection = await connectionForAccount(account, body?.connectionId);
    if (!connection) return NextResponse.json({ error: "Company not found" }, { status: 404 });
    // A paused company (past the plan's company limit) gets no AI work, as with the brief and analysis.
    if ((await overLimitConnectionIds(account.ownerId)).has(connection.id)) {
      return NextResponse.json({ error: "This company is paused because your plan doesn't cover this many companies. Billing shows what to do.", code: "company_paused" }, { status: 403 });
    }
    if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "AI suggestions aren't switched on." }, { status: 503 });

    const result = await suggestJobTypesWithAI(connection.id);
    return NextResponse.json({
      ok: true,
      ...result,
      message:
        result.asked === 0
          ? "Every job without a type already has a suggestion."
          : `Suggested a type for ${result.suggested} of ${result.asked} ${result.asked === 1 ? "job" : "jobs"}. The rest don't say enough in their names; set those by hand.${result.asked >= 180 ? " There are more; press again in a couple of minutes for the next batch." : ""}`,
    });
  } catch (err) {
    if (err instanceof SuggestionCooldownError) return NextResponse.json({ error: err.message }, { status: 429 });
    console.error("jobs/suggest-types failed:", err instanceof Error ? err.message : "Unknown error");
    // Reported so a refused AI request (an old ANTHROPIC_MODEL, a revoked key) is noticed. A timeout isn't a fault.
    if (aiFailureKind(err) !== "timeout") {
      await reportError(err, { route: "/api/jobs/suggest-types", method: "POST", feature: "job-type-suggestions" });
    }
    return NextResponse.json({ error: "The suggestions couldn't be made just now. Please try again." }, { status: 500 });
  }
}
