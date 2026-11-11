import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { disconnectedLanding, startIntuitFlow } from "@/lib/intuitSignIn";

/**
 * GET /api/auth/intuit?intent=signin[&realmId=...]
 *   The Sign in with Intuit button, and the app's Launch URL in Intuit's
 *   settings. Someone already signed in here goes straight to the dashboard,
 *   which is what launching from QuickBooks' Apps tab should do.
 *
 * GET /api/auth/intuit?intent=appstore
 *   The Connect/Reconnect URL in Intuit's settings, used by the App Store's
 *   "Get integration now": Intuit sign-in and QuickBooks access in one step.
 *
 * GET /api/auth/intuit?intent=signup
 *   The button on /signup: the same one step, but the visitor came through
 *   our pages, so a new account is measured like an email signup (see
 *   src/lib/intuitSignIn.ts).
 *
 * GET /api/auth/intuit?intent=disconnected[&realmId=...]
 *   Where the Disconnect URL's page (/quickbooks/disconnected) sends someone
 *   who isn't signed in: Intuit's sign-in, then back to that page signed in.
 *   Disconnecting from QuickBooks then lands in the app without a password,
 *   as Intuit's requirement 4.4 asks.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const asked = url.searchParams.get("intent");
  const realmId = url.searchParams.get("realmId");

  if (asked === "disconnected") {
    if (await getSession()) {
      return NextResponse.redirect(new URL(disconnectedLanding(realmId), process.env.APP_URL), 302);
    }
    return startIntuitFlow("signin", { realmId, land: "disconnected" });
  }

  const intent = asked === "appstore" || asked === "signup" ? asked : "signin";
  if (intent === "signin" && (await getSession())) {
    // 302: this is the Launch URL, and Intuit can put the realm ID in it.
    return NextResponse.redirect(new URL("/dashboard", process.env.APP_URL), 302);
  }
  return startIntuitFlow(intent, { realmId });
}
