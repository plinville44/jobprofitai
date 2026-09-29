import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccount, listCompanies, refuseClient } from "@/lib/account";
import { createInvite, INVITE_TTL_DAYS, recordInviteEmail } from "@/lib/team";
import { sendEmail } from "@/lib/email/client";
import { appUrl, teamInviteEmail } from "@/lib/email/templates";

/**
 * POST /api/team/invite { email, clientConnectionId? }
 *
 * Owner only. Creates (or re-sends) an invitation and emails the link. The
 * raw token exists only in that email; the database holds its hash. With
 * clientConnectionId it's a view-only client login for that one company
 * (Firm plan).
 */
export async function POST(req: NextRequest) {
  const account = await getAccount();
  if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const refused = refuseClient(account);
  if (refused) return refused;
  if (account.role !== "owner") {
    return NextResponse.json({ error: "Only the account owner can invite team members." }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const clientConnectionId = typeof body?.clientConnectionId === "string" && body.clientConnectionId ? body.clientConnectionId : null;
  const result = await createInvite(account.ownerId, body?.email, new Date(), { clientConnectionId });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  const [owner, companies] = await Promise.all([
    prisma.user.findUnique({ where: { id: account.ownerId }, select: { name: true, email: true } }),
    listCompanies(account),
  ]);
  const clientCompany = clientConnectionId ? companies.find((c) => c.id === clientConnectionId) ?? null : null;
  const email = teamInviteEmail({
    inviterName: owner?.name ?? null,
    inviterEmail: owner?.email ?? "",
    companyName: clientCompany ? clientCompany.companyName : companies.length === 1 ? companies[0].companyName : null,
    acceptUrl: appUrl(`/invite/${result.token}`),
    expiryDays: INVITE_TTL_DAYS,
    viewOnly: clientConnectionId != null,
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
