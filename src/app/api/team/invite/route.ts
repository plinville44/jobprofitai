import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccount, listCompanies } from "@/lib/account";
import { createInvite, INVITE_TTL_DAYS, recordInviteEmail } from "@/lib/team";
import { sendEmail } from "@/lib/email/client";
import { appUrl, teamInviteEmail } from "@/lib/email/templates";

/**
 * POST /api/team/invite { email }
 *
 * Owner only. Creates (or re-sends) an invitation and emails the link. The
 * raw token exists only in that email; the database holds its hash.
 */
export async function POST(req: NextRequest) {
  const account = await getAccount();
  if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (account.role !== "owner") {
    return NextResponse.json({ error: "Only the account owner can invite team members." }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const result = await createInvite(account.ownerId, body?.email);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  const [owner, companies] = await Promise.all([
    prisma.user.findUnique({ where: { id: account.ownerId }, select: { name: true, email: true } }),
    listCompanies(account.ownerId),
  ]);
  const email = teamInviteEmail({
    inviterName: owner?.name ?? null,
    inviterEmail: owner?.email ?? "",
    companyName: companies.length === 1 ? companies[0].companyName : null,
    acceptUrl: appUrl(`/invite/${result.token}`),
    expiryDays: INVITE_TTL_DAYS,
  });
  const sent = await sendEmail({ to: result.email, ...email, replyTo: owner?.email });
  await recordInviteEmail(account.ownerId, result.inviteId, result.email, sent.ok).catch(() => {});
  if (!sent.ok) {
    return NextResponse.json(
      { error: "The invitation was saved but the email didn't send. Try Resend in a few minutes." },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true });
}
