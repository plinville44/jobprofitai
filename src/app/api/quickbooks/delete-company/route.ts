import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getAccount, refuseClient } from "@/lib/account";
import { verifyPassword } from "@/lib/auth";
import { deleteCompanyData } from "@/lib/companyData";

/**
 * POST /api/quickbooks/delete-company  { connectionId, password, confirm: "DELETE" }
 *
 * Permanently deletes one QuickBooks company's data from the account,
 * connected or already disconnected, without touching the account or its
 * other companies. A firm uses it when a client leaves; anyone uses it to
 * have a company's data deleted now instead of 30 days after disconnecting.
 * Owner only, with the password and the word DELETE, like deleting the
 * account. See src/lib/companyData.ts.
 */
export const runtime = "nodejs";

const Schema = z.object({
  connectionId: z.string().min(1),
  password: z.string().min(1, "Enter your password to confirm."),
  confirm: z.literal("DELETE", { errorMap: () => ({ message: "Type DELETE to confirm." }) }),
});

export async function POST(req: NextRequest) {
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const refused = refuseClient(account);
    if (refused) return refused;
    if (account.role !== "owner") {
      return NextResponse.json({ error: "Only the account owner can delete a company's data." }, { status: 403 });
    }

    const parsed = Schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
    }

    const owner = await prisma.user.findUnique({ where: { id: account.ownerId }, select: { passwordHash: true } });
    if (!owner || !(await verifyPassword(parsed.data.password, owner.passwordHash))) {
      return NextResponse.json({ error: "That password isn't correct." }, { status: 401 });
    }

    const connection = await prisma.quickBooksConnection.findUnique({ where: { id: parsed.data.connectionId } });
    if (!connection || connection.userId !== account.ownerId) {
      return NextResponse.json({ error: "Company not found." }, { status: 404 });
    }

    await deleteCompanyData(connection);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("quickbooks/delete-company failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json(
      { error: "We couldn't delete that company's data. Email support@jobprofitai.com and we'll handle it." },
      { status: 500 }
    );
  }
}
