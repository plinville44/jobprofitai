import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { clearSession, getSession, revokeAllSessions, verifyPassword } from "@/lib/auth";
import { decryptToken } from "@/lib/crypto";
import { revokeToken } from "@/lib/quickbooks";
import { getStripe } from "@/lib/stripe/client";
import { CANCEL_FAILED_MESSAGE, stripeSubscriptionEnded } from "@/lib/stripe/billing";
import { reportError } from "@/lib/monitoring";
import { REMOVED_ROLE, removeFromRecipientLists } from "@/lib/teamRemoval";

/**
 * POST /api/account/delete  { password, confirm: "DELETE" }
 *
 * Permanently deletes the account and everything derived from it.
 *
 * Order matters here, and it's deliberately "external first, database last":
 *
 *   1. Cancel any Stripe subscription, so deleting an account can never
 *      leave someone being billed for a product they no longer have. First,
 *      because if it fails nothing has changed yet: the account stays and
 *      the customer is asked to try again (stripeSubscriptionEnded in
 *      src/lib/stripe/billing.ts).
 *   2. Revoke QuickBooks tokens with Intuit. Done before the delete,
 *      because once the row is gone the encrypted token is gone with it and
 *      we would have no way to revoke it - leaving a live grant against the
 *      customer's QuickBooks company with nothing on our side to revoke it
 *      with.
 *   3. Delete the user row, which cascades to connections, jobs, cost
 *      entries, invoices, digests, month-end WIP snapshots, insights,
 *      feedback and referral data.
 *
 * Re-authentication with the current password is required. Account deletion
 * is irreversible, and a session cookie alone (on a shared or unattended
 * machine) is not a good enough basis for destroying someone's financial
 * history.
 */
export const runtime = "nodejs";

const DeleteSchema = z.object({
  password: z.string().min(1, "Enter your password to confirm."),
  confirm: z.literal("DELETE", {
    errorMap: () => ({ message: 'Type DELETE to confirm.' }),
  }),
});

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const parsed = DeleteSchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return NextResponse.json({ error: first?.message ?? "Invalid request." }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      include: { connections: true, subscription: true },
    });
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const valid = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!valid) {
      return NextResponse.json({ error: "That password isn't correct." }, { status: 401 });
    }

    // 1. Cancel billing so nobody is charged after their account is gone.
    const stripeSubscriptionId = user.subscription?.stripeSubscriptionId;
    if (stripeSubscriptionId) {
      try {
        await getStripe().subscriptions.cancel(stripeSubscriptionId);
      } catch (err) {
        console.error(
          `account/delete: could not cancel Stripe subscription ${stripeSubscriptionId}:`,
          err instanceof Error ? err.message : "Unknown error"
        );
        // Whatever the stored status says (it can be stale), only Stripe
        // saying the subscription has ended, or doesn't exist, lets this go
        // ahead. Deleting otherwise could leave it charging an account that
        // no longer exists, with nothing on our side to stop it.
        if (!(await stripeSubscriptionEnded(stripeSubscriptionId))) {
          await reportError(err, { route: "/api/account/delete", method: "POST" });
          return NextResponse.json({ error: CANCEL_FAILED_MESSAGE }, { status: 502 });
        }
      }
    }

    // 2. Revoke every live QuickBooks grant while we still hold the tokens.
    for (const connection of user.connections) {
      if (connection.disconnectedAt) continue;
      try {
        await revokeToken(decryptToken(connection.refreshToken));
      } catch (err) {
        // Best-effort: an already-invalid token must not block deletion.
        console.error(
          "account/delete: token revoke failed for a connection:",
          err instanceof Error ? err.message : "Unknown error"
        );
      }
    }

    // 3. Delete the account. Cascades handle connections, jobs, cost
    //    entries, invoices, digests, month-end WIP snapshots (through the
    //    connection), insights, trial feedback, referral codes
    //    and email events - see the onDelete: Cascade rules in schema.prisma.
    //    In-app feedback rows carry the user's id and email but have no
    //    foreign key to User (so they are not cascaded), which is why they
    //    are removed explicitly here. Both deletes run in one transaction.
    // Team members lose access with the account. Their own logins are left
    // in place (they belong to them), but every session is ended now.
    const members = await prisma.teamMember.findMany({
      where: { ownerUserId: user.id, memberUserId: { not: null } },
      select: { memberUserId: true },
    });
    // A team member or client deleting their own login: their address comes
    // off the brief and alert lists of the account they belonged to, as when
    // the owner removes them (teamRemoval.ts). The membership row itself goes
    // with the login (onDelete: Cascade).
    const membership = await prisma.teamMember.findUnique({
      where: { memberUserId: user.id },
      select: { ownerUserId: true, email: true, acceptedAt: true, role: true },
    });

    await prisma.$transaction([
      prisma.feedback.deleteMany({ where: { userId: user.id } }),
      prisma.user.delete({ where: { id: user.id } }),
    ]);

    // Only a login that really belonged to that account: not an invitation
    // it never accepted, and not the marker left when it was removed (its
    // address came off the lists then).
    if (membership?.acceptedAt && membership.role !== REMOVED_ROLE && membership.ownerUserId !== user.id) {
      await removeFromRecipientLists(membership.ownerUserId, [membership.email, user.email]).catch((err) => {
        console.error(
          "account/delete: could not take the address off the team's email lists:",
          err instanceof Error ? err.message : "Unknown error"
        );
      });
    }

    for (const m of members) {
      if (m.memberUserId) await revokeAllSessions(m.memberUserId).catch(() => {});
    }

    await clearSession();

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("account/delete failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json(
      {
        error:
          "We couldn't delete your account. Please email support@jobprofitai.com and we'll handle it.",
      },
      { status: 500 }
    );
  }
}
