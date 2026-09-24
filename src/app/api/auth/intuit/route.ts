import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { startIntuitFlow } from "@/lib/intuitSignIn";

/**
 * GET /api/auth/intuit?intent=signin[&realmId=...]
 *   The Sign in with Intuit button, and the app's Launch URL in Intuit's
 *   settings. Someone already signed in here goes straight to the dashboard,
 *   which is what launching from QuickBooks' Apps tab should do.
 *
 * GET /api/auth/intuit?intent=appstore
 *   The Connect/Reconnect URL in Intuit's settings, used by the App Store's
 *   "Get integration now": Intuit sign-in and QuickBooks access in one step.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const intent = url.searchParams.get("intent") === "appstore" ? "appstore" : "signin";
  const realmId = url.searchParams.get("realmId");

  if (intent === "signin" && (await getSession())) {
    return NextResponse.redirect(new URL("/dashboard", process.env.APP_URL));
  }
  return startIntuitFlow(intent, { realmId });
}
