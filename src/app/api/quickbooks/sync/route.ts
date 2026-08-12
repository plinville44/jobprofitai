import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { qboQuery, refreshTokens } from "@/lib/quickbooks";
import { encryptToken, decryptToken } from "@/lib/crypto";

/**
 * POST /api/quickbooks/sync  { connectionId }
 *
 * Pulls this connection's job-costing data from QuickBooks and writes it into
 * our own tables (Job / CostEntry / InvoiceSummary), so the profitability
 * engine and digest generator can run against local data rather than hitting
 * the QBO API live every time.
 *
 * This is intentionally a manual-trigger endpoint for now (Week 1 scope).
 * Wiring it to a weekly cron (Vercel Cron or similar) is Week 2 work, once
 * this path has been proven against a real Sandbox company.
 */
export async function POST(req: NextRequest) {
  try {
    return await runSync(req);
  } catch (err) {
    // Same reasoning as /api/digest/generate: always return JSON on failure
    // so the dashboard button shows a real error instead of hanging forever.
    // Log only the error message, never the full error object - Intuit's
    // security review explicitly prohibits logging customer QuickBooks data
    // or credentials, and some SDK error objects embed the request/response
    // body (which could contain either) in fields beyond `.message`.
    console.error("quickbooks/sync failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sync failed." },
      { status: 500 }
    );
  }
}

async function runSync(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { connectionId } = await req.json();
  const connection = await prisma.quickBooksConnection.findUnique({
    where: { id: connectionId },
  });

  if (!connection || connection.userId !== session.userId) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  const accessToken = await getValidAccessToken(connection);
  const realmId = decryptToken(connection.realmId);

  // --- 1. Jobs (Projects mode: sub-customers with Job=true) ---
  const customerResult = await qboQuery(
    realmId,
    accessToken,
    "SELECT Id, DisplayName, Job, ParentRef, Active FROM Customer WHERE Job = true MAXRESULTS 1000"
  );
  const projectJobs = customerResult?.QueryResponse?.Customer ?? [];

  for (const c of projectJobs) {
    await prisma.job.upsert({
      where: { connectionId_qboId: { connectionId: connection.id, qboId: c.Id } },
      create: {
        connectionId: connection.id,
        qboId: c.Id,
        name: c.DisplayName,
        status: c.Active ? "open" : "closed",
      },
      update: {
        name: c.DisplayName,
        status: c.Active ? "open" : "closed",
      },
    });
  }

  // --- 2. Actual costs: Purchases (covers Expense/Check/CreditCard-type spend) ---
  const purchaseResult = await qboQuery(
    realmId,
    accessToken,
    "SELECT Id, TxnDate, TotalAmt, Line FROM Purchase MAXRESULTS 1000"
  );
  const purchases = purchaseResult?.QueryResponse?.Purchase ?? [];

  for (const purchase of purchases) {
    for (const line of purchase.Line ?? []) {
      const jobRef = line?.AccountBasedExpenseLineDetail?.CustomerRef?.value;
      if (!jobRef) continue; // not tagged to a job - skip, it's overhead

      const job = await prisma.job.findUnique({
        where: { connectionId_qboId: { connectionId: connection.id, qboId: jobRef } },
      });
      if (!job) continue;

      await prisma.costEntry.upsert({
        where: { id: `${purchase.Id}-${line.Id}` }, // deterministic id, safe to re-run
        create: {
          id: `${purchase.Id}-${line.Id}`,
          jobId: job.id,
          qboSourceType: "Purchase",
          qboSourceId: purchase.Id,
          category: categorize(line?.AccountBasedExpenseLineDetail?.AccountRef?.name),
          description: line?.Description ?? null,
          amount: line?.Amount ?? 0,
          txnDate: new Date(purchase.TxnDate),
        },
        update: {
          amount: line?.Amount ?? 0,
        },
      });
    }
  }

  // --- 3. Actual revenue: Invoices tagged to a job ---
  const invoiceResult = await qboQuery(
    realmId,
    accessToken,
    "SELECT Id, TxnDate, TotalAmt, Balance, CustomerRef FROM Invoice MAXRESULTS 1000"
  );
  const invoices = invoiceResult?.QueryResponse?.Invoice ?? [];

  for (const inv of invoices) {
    const job = await prisma.job.findUnique({
      where: { connectionId_qboId: { connectionId: connection.id, qboId: inv.CustomerRef?.value } },
    });
    if (!job) continue;

    await prisma.invoiceSummary.upsert({
      where: { id: inv.Id },
      create: {
        id: inv.Id,
        jobId: job.id,
        qboInvoiceId: inv.Id,
        amount: inv.TotalAmt ?? 0,
        status: inv.Balance > 0 ? "open" : "paid",
        txnDate: new Date(inv.TxnDate),
      },
      update: {
        amount: inv.TotalAmt ?? 0,
        status: inv.Balance > 0 ? "open" : "paid",
      },
    });
  }

  await prisma.quickBooksConnection.update({
    where: { id: connection.id },
    data: { lastSyncedAt: new Date(), companyName: connection.companyName },
  });

  return NextResponse.json({
    ok: true,
    jobsSynced: projectJobs.length,
    purchasesSynced: purchases.length,
    invoicesSynced: invoices.length,
  });
}

/** Maps a QBO expense account name to one of our four cost categories. Loose
 * on purpose - contractors name accounts inconsistently, and a mis-bucketed
 * cost is far less harmful than a missing one. Refine as real data comes in
 * during Week 3 beta testing. */
function categorize(accountName: string | undefined): string {
  const name = (accountName ?? "").toLowerCase();
  if (name.includes("labor") || name.includes("payroll") || name.includes("wage")) return "labor";
  if (name.includes("material") || name.includes("supply") || name.includes("supplies")) return "materials";
  if (name.includes("subcontractor") || name.includes("sub-contractor") || name.includes("sub ")) return "subcontractor";
  if (name.includes("overhead") || name.includes("admin")) return "overhead";
  return "other";
}

async function getValidAccessToken(connection: {
  id: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
}): Promise<string> {
  // Refresh a little early (5 min buffer) rather than racing the exact expiry instant.
  const stillValid = connection.accessTokenExpiresAt.getTime() - Date.now() > 5 * 60 * 1000;
  if (stillValid) return decryptToken(connection.accessToken);

  const refreshed = await refreshTokens(decryptToken(connection.refreshToken));
  const now = Date.now();

  await prisma.quickBooksConnection.update({
    where: { id: connection.id },
    data: {
      accessToken: encryptToken(refreshed.access_token),
      refreshToken: encryptToken(refreshed.refresh_token),
      accessTokenExpiresAt: new Date(now + refreshed.expires_in * 1000),
      refreshTokenExpiresAt: new Date(now + refreshed.x_refresh_token_expires_in * 1000),
    },
  });

  return refreshed.access_token;
}
