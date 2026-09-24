import { randomBytes } from "crypto";
import { prisma } from "./prisma";
import { hashToken } from "./passwordReset";
import { getEntitlements } from "./entitlements";

/**
 * Team logins.
 *
 * An account owner invites someone by email (an office manager, a project
 * manager, their bookkeeper). The invitation is a single-use link, stored
 * only as a SHA-256 hash like password reset links. Accepting it gives that
 * person their own login into the owner's account: the same companies and
 * the same plan. Billing, the team list and deleting the account stay with
 * the owner. See src/lib/account.ts for how every page and route resolves
 * whose data a signed-in person sees.
 *
 * Rules, all enforced here rather than in the routes:
 *   - Only as many logins as the plan allows (pending invites count).
 *   - One account per person: someone who already belongs to a team, owns
 *     a QuickBooks company, pays for a plan, or has invited a team of their
 *     own cannot join another account with the same login.
 *   - The invite must be accepted by a login with the invited address.
 *   - An invite can be re-sent, but not more than once every few minutes,
 *     so the form cannot be used to flood someone's inbox.
 */

export const INVITE_TTL_DAYS = 7;
const RESEND_COOLDOWN_MS = 5 * 60_000;
/**
 * Invitation emails one owner can send per hour, however they're sent
 * (new, re-sent, or cancelled and sent again). Stops the form being used
 * to flood someone's inbox from our sending domain.
 */
export const MAX_INVITE_EMAILS_PER_HOUR = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type InviteResult =
  | { ok: true; token: string; inviteId: string; email: string; expiresAt: Date }
  | { ok: false; error: string; status: number };

export async function createInvite(ownerId: string, rawEmail: unknown, now = new Date()): Promise<InviteResult> {
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) {
    return { ok: false, error: "Enter a valid email address.", status: 400 };
  }

  const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { email: true, emailVerifiedAt: true } });
  if (!owner) return { ok: false, error: "Account not found.", status: 404 };
  if (!owner.emailVerifiedAt) {
    return { ok: false, error: "Confirm your own email address first (check your inbox), then invite people.", status: 403 };
  }
  const recentSends = await prisma.emailEvent.count({
    where: { userId: ownerId, emailType: "team_invite", sentAt: { gt: new Date(now.getTime() - 3_600_000) } },
  });
  if (recentSends >= MAX_INVITE_EMAILS_PER_HOUR) {
    return { ok: false, error: "That's a lot of invitations in an hour. Please try again later.", status: 429 };
  }
  if (owner.email.toLowerCase() === email) {
    return { ok: false, error: "That's your own address. You already have access.", status: 400 };
  }

  const entitlements = await getEntitlements(ownerId);
  if (!entitlements.active) {
    return { ok: false, error: "Choose a plan to add team members.", status: 402 };
  }

  const existing = await prisma.teamMember.findFirst({ where: { ownerUserId: ownerId, email } });
  if (existing?.acceptedAt) {
    return { ok: false, error: "That person is already on your team.", status: 409 };
  }
  if (existing && now.getTime() - existing.invitedAt.getTime() < RESEND_COOLDOWN_MS) {
    return { ok: false, error: "An invitation was just sent to that address. Give it a few minutes.", status: 429 };
  }

  // A live pending invitation already holds a place; re-sending it doesn't
  // take another. A new or expired one needs a free place.
  const holdsPlace = existing != null && existing.expiresAt.getTime() > now.getTime();
  if (!holdsPlace) {
    const used = await prisma.teamMember.count({
      where: {
        ownerUserId: ownerId,
        OR: [{ acceptedAt: { not: null } }, { expiresAt: { gt: now } }],
      },
    });
    const max = entitlements.limits.maxTeamMembers;
    if (used >= max) {
      return {
        ok: false,
        error: `Your plan includes ${max} team ${max === 1 ? "login" : "logins"} and they're all in use or invited. Remove one first.`,
        status: 402,
      };
    }
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + INVITE_TTL_DAYS * 86_400_000);
  const data = { tokenHash: hashToken(token), invitedAt: now, expiresAt };
  const invite = existing
    ? await prisma.teamMember.update({ where: { id: existing.id }, data })
    : await prisma.teamMember.create({ data: { ownerUserId: ownerId, email, ...data } });

  return { ok: true, token, inviteId: invite.id, email, expiresAt };
}

export interface InviteView {
  id: string;
  ownerUserId: string;
  email: string;
  ownerName: string | null;
  ownerEmail: string;
}

/** A still-usable invitation for a raw token, or null (unknown, used or expired). */
export async function findUsableInvite(token: unknown, now = new Date()): Promise<InviteView | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const invite = await prisma.teamMember.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!invite || invite.acceptedAt || invite.expiresAt.getTime() <= now.getTime()) return null;
  const owner = await prisma.user.findUnique({
    where: { id: invite.ownerUserId },
    select: { name: true, email: true },
  });
  if (!owner) return null;
  return { id: invite.id, ownerUserId: invite.ownerUserId, email: invite.email, ownerName: owner.name, ownerEmail: owner.email };
}

export type AcceptResult = { ok: true; ownerUserId: string } | { ok: false; error: string; status: number };

/**
 * Joins `userId` to the team the invitation is for. The caller has already
 * established who `userId` is (a signed-in session, or a login it just
 * created from the invitation itself).
 */
export async function acceptInvite(token: unknown, userId: string, now = new Date()): Promise<AcceptResult> {
  const invite = await findUsableInvite(token, now);
  if (!invite) {
    return { ok: false, error: "This invitation has expired or was already used. Ask for a new one.", status: 410 };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, emailVerifiedAt: true },
  });
  if (!user) return { ok: false, error: "Account not found.", status: 404 };
  if (user.email.toLowerCase() !== invite.email) {
    return {
      ok: false,
      error: `This invitation is for ${invite.email}. Sign in with that address to accept it.`,
      status: 403,
    };
  }
  if (user.id === invite.ownerUserId) {
    return { ok: false, error: "You can't join your own account.", status: 400 };
  }

  const [membership, connections, subscription, ownTeam] = await Promise.all([
    prisma.teamMember.findUnique({ where: { memberUserId: user.id } }),
    prisma.quickBooksConnection.count({ where: { userId: user.id, disconnectedAt: null } }),
    prisma.subscription.findUnique({ where: { userId: user.id } }),
    prisma.teamMember.count({ where: { ownerUserId: user.id, acceptedAt: { not: null } } }),
  ]);
  if (membership?.acceptedAt) {
    return {
      ok: false,
      error: "Your login already belongs to another JobProfitAI team. Ask its owner to remove you first.",
      status: 409,
    };
  }
  if (connections > 0 || subscription?.stripeSubscriptionId || ownTeam > 0) {
    return {
      ok: false,
      error:
        "Your login has its own JobProfitAI account (a connected company, a paid plan or a team of its own), so it can't join another one. Ask to be invited at a different address, or email support and we'll help.",
      status: 409,
    };
  }

  try {
    await prisma.teamMember.update({
      where: { id: invite.id },
      data: { memberUserId: user.id, acceptedAt: now },
    });
  } catch (err) {
    // Two invitations accepted at the same moment: the second loses.
    if ((err as { code?: string })?.code === "P2002") {
      return { ok: false, error: "Your login already belongs to another JobProfitAI team.", status: 409 };
    }
    throw err;
  }

  // Tidy up what the login no longer needs. A free trial of its own would
  // only send it "connect your QuickBooks" reminders; the invitation link
  // arriving in the inbox proves the address, so it counts as verified.
  if (subscription && !subscription.stripeSubscriptionId) {
    await prisma.subscription.delete({ where: { userId: user.id } });
  }
  if (!user.emailVerifiedAt) {
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: now } });
  }
  // Any other invitations to this login are moot now, and so are any it
  // had sent itself: a team member can't have a team of their own.
  await prisma.teamMember.deleteMany({ where: { email: invite.email, acceptedAt: null } });
  await prisma.teamMember.deleteMany({ where: { ownerUserId: user.id, acceptedAt: null } });

  return { ok: true, ownerUserId: invite.ownerUserId };
}

export interface TeamRow {
  id: string;
  email: string;
  name: string | null;
  status: "active" | "invited" | "expired";
  invitedAt: Date;
  acceptedAt: Date | null;
}

export async function listTeam(ownerId: string, now = new Date()): Promise<TeamRow[]> {
  const rows = await prisma.teamMember.findMany({
    where: { ownerUserId: ownerId },
    orderBy: { invitedAt: "asc" },
    include: { member: { select: { name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.member?.name ?? null,
    status: r.acceptedAt ? "active" : r.expiresAt.getTime() > now.getTime() ? "invited" : "expired",
    invitedAt: r.invitedAt,
    acceptedAt: r.acceptedAt,
  }));
}

/** Records an invitation email, for the hourly cap above and the email log. */
export async function recordInviteEmail(ownerId: string, inviteId: string, toEmail: string, ok: boolean, now = new Date()) {
  await prisma.emailEvent.create({
    data: {
      userId: ownerId,
      emailType: "team_invite",
      dedupeKey: `team_invite:${inviteId}:${now.getTime()}`,
      toEmail,
      status: ok ? "sent" : "failed",
    },
  });
}
