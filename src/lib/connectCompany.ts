import { prisma } from "@/lib/prisma";
import { detectCostTrackingMode, qboCompanyInfo, revokeToken, type QboTokenResponse } from "@/lib/quickbooks";
import { encryptToken, hashRealmId, legacyHashRealmId } from "@/lib/crypto";
import { canConnectAnotherCompany, getEntitlements } from "@/lib/entitlements";
import { tryMarkQuickBooksConnected } from "@/lib/trial";
import { sendEmail } from "@/lib/email/client";
import { connectAttemptBlockedEmail } from "@/lib/email/templates";

/**
 * Attaches a QuickBooks company to an account after Intuit's consent screen.
 * Shared by the ordinary Connect button and the QuickBooks App Store flow.
 *
 * Refuses, and revokes the new tokens, when:
 *   - the company is already connected to a DIFFERENT account. It used to
 *     move silently to whoever connected last, taking its history with it,
 *     while the previous owner kept paying for an empty account. Now the
 *     owner is emailed and has to disconnect it first.
 *   - the account is on a free trial and this company has already been
 *     through a trial on another account (one trial per company).
 *   - the account's plan has no room for another company.
 */
export type AttachResult =
  | { ok: true; connectionId: string }
  | { ok: false; code: "already_connected" | "trial_used" | "plan_limit" | "verify_failed"; message: string };

export async function attachCompany(input: {
  ownerId: string;
  realmId: string;
  tokens: QboTokenResponse;
  reconnectId?: string | null;
}): Promise<AttachResult> {
  const { ownerId, realmId, tokens } = input;
  const now = Date.now();
  if (!/^\d{1,32}$/.test(realmId)) {
    return { ok: false, code: "verify_failed", message: "QuickBooks didn't say which company was connected. Please try again." };
  }
  const realmIdHash = hashRealmId(realmId);

  // The company id arrives in the callback URL, which the browser controls.
  // Before it is trusted for anything, confirm the new tokens are really
  // for that company: QuickBooks refuses a company they weren't issued for.
  // Without this, someone could authorize their own company and swap in
  // another company's id to take over its row and history here.
  let companyInfo: any;
  try {
    companyInfo = await qboCompanyInfo(realmId, tokens.access_token);
  } catch {
    return { ok: false, code: "verify_failed", message: "We couldn't confirm that QuickBooks company with Intuit. Please try connecting again." };
  }

  const found =
    (await prisma.quickBooksConnection.findUnique({ where: { realmIdHash } })) ??
    (await prisma.quickBooksConnection.findUnique({ where: { realmIdHash: legacyHashRealmId(realmId) } }));
  let existing = found;

  // A company that was disconnected from ANOTHER account is changing hands.
  // The previous account keeps its own history (the row is set aside under
  // a "moved:" key, out of every lookup) and this account starts clean:
  // the estimates, budgets and briefs typed there are not handed over.
  const movedPrefix = `moved:${realmIdHash}:`;
  if (found && found.userId !== ownerId && found.disconnectedAt) {
    await prisma.quickBooksConnection.update({ where: { id: found.id }, data: { realmIdHash: `${movedPrefix}${found.id}` } });
    existing = null;
  }
  if (!existing) {
    // This account's own earlier history for the company, from before it
    // was set aside, comes back.
    existing = await prisma.quickBooksConnection.findFirst({
      where: { userId: ownerId, realmIdHash: { startsWith: movedPrefix } },
      orderBy: { connectedAt: "desc" },
    });
  }
  const connectedByOthersBefore =
    (found != null && found.userId !== ownerId) ||
    (await prisma.quickBooksConnection.count({ where: { realmIdHash: { startsWith: movedPrefix }, userId: { not: ownerId } } })) > 0;

  const refuse = async (
    code: "already_connected" | "trial_used" | "plan_limit",
    message: string,
    opts: { revoke: boolean } = { revoke: true }
  ): Promise<AttachResult> => {
    // We hold a fresh grant we are not going to use. Give it back, unless
    // the company is live on another account: Intuit may treat revoking any
    // grant for a company as disconnecting the app from that company
    // (not verified either way), which would cut off the account that
    // legitimately has it. The unused tokens are simply not stored.
    if (opts.revoke) await revokeToken(tokens.refresh_token).catch(() => {});
    return { ok: false, code, message };
  };

  if (found && found.userId !== ownerId && !found.disconnectedAt) {
    try {
      const owner = await prisma.user.findUnique({ where: { id: found.userId }, select: { email: true } });
      if (owner?.email) {
        const email = connectAttemptBlockedEmail(found.companyName ?? "Your QuickBooks company");
        await sendEmail({ to: owner.email, ...email });
      }
    } catch {
      // The refusal stands whether or not the notice goes out.
    }
    return refuse(
      "already_connected",
      "That QuickBooks company is already connected to another JobProfitAI account. Its owner has been told. To move it, disconnect it in that account first.",
      { revoke: false }
    );
  }

  const entitlements = await getEntitlements(ownerId);
  if (entitlements.trialing) {
    const trial = await prisma.realmTrial.findUnique({ where: { realmIdHash } });
    // The account that started the company's trial may always come back to
    // it; otherwise any earlier account (trial or paid) means no new trial.
    const usedElsewhere = trial != null ? trial.firstUserId !== ownerId : connectedByOthersBefore;
    if (usedElsewhere) {
      return refuse(
        "trial_used",
        "That QuickBooks company has already had a free trial of JobProfitAI. Choose a plan to connect it."
      );
    }
  }

  // Plan room, unless this company is already on this account (a reconnect).
  // Only a live one: bringing back a company this account disconnected
  // takes a place on the plan like any other.
  const isThisAccountsCompany = existing?.userId === ownerId && !existing.disconnectedAt;
  if (!isThisAccountsCompany && !input.reconnectId) {
    const permission = await canConnectAnotherCompany(ownerId);
    if (!permission.allowed) return refuse("plan_limit", permission.reason ?? "Your plan has no room for another company.");
  }

  const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { email: true, timeZone: true } });
  // The weekly brief goes to the account owner unless Settings says otherwise.
  const defaultRecipients = owner?.email ? [owner.email] : [];
  const ownershipChanged = Boolean(existing && existing.userId !== ownerId);

  const tokenData = {
    accessToken: encryptToken(tokens.access_token),
    refreshToken: encryptToken(tokens.refresh_token),
    accessTokenExpiresAt: new Date(now + tokens.expires_in * 1000),
    refreshTokenExpiresAt: new Date(now + tokens.x_refresh_token_expires_in * 1000),
  };

  const connection = existing
    ? await prisma.quickBooksConnection.update({
        where: { id: existing.id },
        data: {
          userId: ownerId,
          realmIdHash, // upgrades a row stored under the older plain hash
          ...tokenData,
          disconnectedAt: null,
          // A fresh grant clears the error that sent them here.
          lastSyncStatus: null,
          lastSyncError: null,
          // Only when the company changes hands (its previous owner
          // disconnected it): the new owner's address replaces the old
          // recipients, so one owner's figures never keep going to another.
          ...(ownershipChanged ? { emailRecipients: defaultRecipients } : {}),
        },
      })
    : await prisma.quickBooksConnection.create({
        data: {
          userId: ownerId,
          realmId: encryptToken(realmId),
          realmIdHash,
          environment: process.env.QBO_ENVIRONMENT ?? "sandbox",
          ...tokenData,
          emailRecipients: defaultRecipients,
          ...(owner?.timeZone ? { emailTimezone: owner.timeZone } : {}),
        },
      });

  // A reconnect that ended with a DIFFERENT company chosen on Intuit's
  // screen replaces the dead connection rather than adding to it.
  if (input.reconnectId && input.reconnectId !== connection.id) {
    await prisma.quickBooksConnection.updateMany({
      where: { id: input.reconnectId, userId: ownerId, disconnectedAt: null },
      data: { disconnectedAt: new Date() },
    });
  }

  if (entitlements.trialing) {
    await prisma.realmTrial.upsert({
      where: { realmIdHash },
      create: { realmIdHash, firstUserId: ownerId },
      update: {},
    });
  }

  try {
    const mode = await detectCostTrackingMode(realmId, tokens.access_token);
    await prisma.quickBooksConnection.update({ where: { id: connection.id }, data: { costTrackingMode: mode } });
  } catch {
    // Non-fatal.
  }

  const companyName: string | undefined = companyInfo?.CompanyInfo?.CompanyName ?? companyInfo?.CompanyInfo?.LegalName;
  if (companyName) {
    await prisma.quickBooksConnection.update({ where: { id: connection.id }, data: { companyName } });
  }

  // Half of trial "activation" (the other half is a first analysis).
  await tryMarkQuickBooksConnected(ownerId);

  return { ok: true, connectionId: connection.id };
}
