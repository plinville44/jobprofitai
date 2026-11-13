import { prisma } from "@/lib/prisma";
import { fetchIntuitUserInfo } from "@/lib/quickbooks";
import { sendEmail } from "@/lib/email/client";
import { intuitLinkedEmail } from "@/lib/email/templates";

/**
 * Turns on Sign in with Intuit for the person who just connected QuickBooks,
 * when it's safely theirs.
 *
 * Why: Intuit's review (Nov 13, 2026, requirement 4.4) disconnects the app
 * from the QuickBooks App Store in a fresh browser and expects to land back
 * in JobProfitAI signed in, with no password or consent screen. The
 * Disconnect URL signs in through Intuit (OpenID), which works only for an
 * Intuit account linked to a login. Someone who signed up with email and
 * then pressed Connect to QuickBooks never linked one, so they were asked
 * for their password. The Connect flow now asks Intuit for the OpenID
 * scopes too (CONNECT_WITH_OPENID_SCOPES, the same consent screen the App
 * Store flow shows), and this links the Intuit account the person used.
 *
 * Linked only when all of these hold:
 * - Intuit has verified the Intuit account's email address;
 * - that address is this login's own (exact, ignoring case). A bookkeeper
 *   or team member connecting with someone else's Intuit login (the
 *   company owner's, say) isn't linked: that would let the other person
 *   sign in as them;
 * - this login has no Intuit account linked yet (never replaced);
 * - no other login has this Intuit account.
 * The owner of the login is emailed, as with any other link, and it can be
 * turned off in Settings; a password reset turns it off too.
 *
 * Never throws and never holds up the connection: any failure (Intuit's
 * userinfo, the database) just leaves the login as it was.
 */
export async function linkIntuitOnConnect(userId: string, accessToken: string): Promise<"linked" | "skipped"> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, intuitSub: true } });
    if (!user || user.intuitSub) return "skipped";

    const info = await fetchIntuitUserInfo(accessToken);
    if (!info.emailVerified || !info.email) return "skipped";
    if (info.email.trim().toLowerCase() !== user.email.trim().toLowerCase()) return "skipped";

    const taken = await prisma.user.findUnique({ where: { intuitSub: info.sub }, select: { id: true } });
    if (taken) return "skipped";

    // Only while still unlinked, so two connects at once can't overwrite each other.
    const { count } = await prisma.user.updateMany({ where: { id: user.id, intuitSub: null }, data: { intuitSub: info.sub } });
    if (count === 0) return "skipped";

    await sendEmail({ to: user.email, ...intuitLinkedEmail("connect") }).catch(() => {});
    return "linked";
  } catch (err) {
    // A unique clash (P2002) means another login took this Intuit account a
    // moment ago. Anything else is logged by its message (Intuit's status and
    // intuit_tid for a userinfo failure; never a token).
    if ((err as { code?: string })?.code !== "P2002") {
      console.error("intuit link on connect skipped:", err instanceof Error ? err.message : "Unknown error");
    }
    return "skipped";
  }
}
