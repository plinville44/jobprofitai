import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { clearSession, getSession, verifyPassword } from "@/lib/auth";
import { decryptToken } from "@/lib/crypto";
import { revokeToken } from "@/lib/quickbooks";
import { getStripe } from "@/lib/stripe/client";

/**
 * POST /api/account/delete  { password, confirm: "DELETE" }
 *
 * Permanently deletes the account and everything derived from it.
 *
 * Order matters here, and it's deliberately "external first, database last":
 *
 *   1. Revoke QuickBooks tokens with Intuit. Done FIRST, because once the
 *      row is gone the encrypted token is gone with it and we would have no
 *      way to revoke it - leaving a live grant against the customer's
 *      QuickBooks company with nothing on our side to revoke it with.
 *   2. Cancel any Stripe subscription, so deleting an account can never
 *      leave someone being billed for a product they no longer have.
 *   3. Delete the user row, which cascades to connections, jobs, cost
 *      entries, invoices, digests, insights, feedback and referral data.
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

    // 1. Revoke every live QuickBooks grant while we still hold the tokens.
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

    // 2. Cancel billing so nobody is charged after their account is gone.
    const stripeSubscriptionId = user.subscription?.stripeSubscriptionId;
    if (stripeSubscriptionId) {
      try {
        await getStripe().subscriptions.cancel(stripeSubscriptionId);
      } catch (err) {
        // Log loudly: this is the one failure a human genuinely needs to
        // know about, because it leaves a live subscription behind.
        console.error(
          `account/delete: could not cancel Stripe subscription ${stripeSubscriptionId}:`,
          err instanceof Error ? err.message : "Unknown error"
        );
      }
    }

    // 3. Delete the account. Cascades handle connections, jobs, cost
    //    entries, invoices, digests, insights, feedback, referral codes and
    //    email events - see the onDelete: Cascade rules in schema.prisma.
    await prisma.user.delete({ where: { id: user.id } });

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
