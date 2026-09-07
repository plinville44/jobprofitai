import crypto from "crypto";
import type { Referral } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { REFERRAL_QUALIFY_DAYS, priceCentsForStoredPlan } from "@/lib/plans";
import { applyCustomerCredit } from "@/lib/stripe/billing";

// The customer referral program: refer a paying customer, earn one free
// month of your own current plan as an account credit.
//
// The integrity rules that matter, and where each is actually enforced:
//
//   * A referred account can be attributed to exactly ONE referrer, ever.
//     Enforced by Referral.referredUserId being @unique - not by a check
//     that a race could slip past.
//   * You cannot refer yourself. Checked here, and unavoidable anyway since
//     a referrer's own account already has a code and would fail the unique
//     constraint against itself.
//   * A qualifying referral produces exactly one reward. Enforced by
//     ReferralReward.referralId being @unique, so a Stripe webhook retry
//     that re-runs qualification inserts nothing the second time.
//   * A reward is only earned after the referred customer has been
//     successfully paid for 30 days with no refund or chargeback.

/**
 * Deliberately excludes 0/O/1/I/L and vowels: these codes get read aloud,
 * texted, and hand-typed, and an ambiguous character is a lost referral.
 */
const CODE_ALPHABET = "23456789BCDFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 7;

function randomCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/** Codes are stored and compared uppercase, so links are case-insensitive. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

async function createUniqueCode(
  data: { kind: "customer"; userId: string } | { kind: "partner"; partnerId: string }
): Promise<string> {
  // 28^7 ≈ 13 billion combinations, so a collision is vanishingly unlikely -
  // but retrying a few times costs nothing and removes the failure mode
  // entirely rather than leaving it to chance.
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode();
    try {
      await prisma.referralCode.create({
        data:
          data.kind === "customer"
            ? { code, kind: "customer", userId: data.userId }
            : { code, kind: "partner", partnerId: data.partnerId },
      });
      return code;
    } catch (err) {
      const code2 = (err as { code?: string })?.code;
      if (code2 !== "P2002") throw err;
      // P2002 on `code` means a collision (retry). P2002 on userId/partnerId
      // means a concurrent request already made this owner's code - return it.
      const existing =
        data.kind === "customer"
          ? await prisma.referralCode.findUnique({ where: { userId: data.userId } })
          : await prisma.referralCode.findUnique({ where: { partnerId: data.partnerId } });
      if (existing) return existing.code;
    }
  }
  throw new Error("Could not generate a unique referral code.");
}

/** A customer's referral code, created lazily on first use. */
export async function getOrCreateCustomerReferralCode(userId: string): Promise<string> {
  const existing = await prisma.referralCode.findUnique({ where: { userId } });
  if (existing) return existing.code;
  return createUniqueCode({ kind: "customer", userId });
}

/** A partner firm's referral code, created when the partner is approved. */
export async function getOrCreatePartnerReferralCode(partnerId: string): Promise<string> {
  const existing = await prisma.referralCode.findUnique({ where: { partnerId } });
  if (existing) return existing.code;
  return createUniqueCode({ kind: "partner", partnerId });
}

/**
 * Name of the httpOnly cookie that carries a referral code from /r/[code]
 * through to signup. Lives here rather than in the route file because
 * Next.js route handlers may only export HTTP methods and a fixed set of
 * config keys - exporting anything else from a route.ts is a build error.
 */
export const REFERRAL_COOKIE = "jpai_ref";

/** How long a referral click stays attributable. */
export const REFERRAL_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** Public referral URL for a code. */
export function referralUrl(code: string): string {
  const base = (process.env.APP_URL ?? "https://jobprofitai.com").replace(/\/+$/, "");
  return `${base}/r/${code}`;
}

// --- Attribution ---------------------------------------------------------

export type AttributionResult =
  | { attributed: true; referral: Referral }
  | { attributed: false; reason: string };

/**
 * Records that a newly created account came in through a referral code.
 * Called from the signup route immediately after the user is created.
 *
 * Never throws: a referral that can't be attributed (bad code, self-referral,
 * already attributed) must never block someone from creating an account.
 * The signup succeeds and the referral is simply not credited.
 */
export async function attributeReferral(
  referredUserId: string,
  rawCode: string | null | undefined
): Promise<AttributionResult> {
  if (!rawCode) return { attributed: false, reason: "No referral code supplied." };

  try {
    const code = normalizeCode(rawCode);
    const referralCode = await prisma.referralCode.findUnique({ where: { code } });
    if (!referralCode) return { attributed: false, reason: "Unknown referral code." };

    // The owning partner is loaded with its own query rather than an
    // `include`. Slightly more code, but the relationship being checked here
    // decides whether commission gets paid, so it's worth it being an
    // explicit, obvious lookup rather than a nested option flag.
    const partner = referralCode.partnerId
      ? await prisma.partner.findUnique({ where: { id: referralCode.partnerId } })
      : null;

    // Self-referral: the code's owner signing up through their own link.
    if (referralCode.userId && referralCode.userId === referredUserId) {
      return { attributed: false, reason: "You can't refer yourself." };
    }
    if (partner && partner.userId === referredUserId) {
      return { attributed: false, reason: "You can't refer yourself." };
    }

    // Partner codes only attribute while the partner is approved and in good
    // standing - a rejected or suspended partner shouldn't keep accruing
    // referrals from links already out in the world.
    if (referralCode.kind === "partner" && partner?.status !== "approved") {
      return { attributed: false, reason: "This partner link isn't active." };
    }

    const referral = await prisma.referral.create({
      data: {
        referralCodeId: referralCode.id,
        kind: referralCode.kind,
        referrerUserId: referralCode.userId,
        partnerId: referralCode.partnerId,
        referredUserId,
        status: "signed_up",
      },
    });

    return { attributed: true, referral };
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      // referredUserId unique violation: this account is already attributed.
      return { attributed: false, reason: "This account has already been referred." };
    }
    console.error(
      "referrals: attribution failed:",
      err instanceof Error ? err.message : "Unknown error"
    );
    return { attributed: false, reason: "Referral could not be recorded." };
  }
}

/** The referral that brought this account in, if any. */
export async function getReferralForUser(userId: string) {
  return prisma.referral.findUnique({ where: { referredUserId: userId } });
}

// --- Lifecycle transitions ----------------------------------------------

/**
 * Marks a referral as converted the first time the referred customer pays.
 * Only moves a referral forward from "signed_up", and only sets firstPaidAt
 * once, so replaying an invoice event is a no-op.
 */
export async function markReferralPaid(
  referredUserId: string,
  paidAt: Date
): Promise<Referral | null> {
  const referral = await prisma.referral.findUnique({ where: { referredUserId } });
  if (!referral) return null;
  if (referral.firstPaidAt) return referral;
  if (referral.status === "disqualified") return referral;

  return prisma.referral.update({
    where: { id: referral.id },
    data: { status: "paid", firstPaidAt: paidAt },
  });
}

/**
 * Refund / chargeback handling. Disqualifies the referral and voids an
 * already-earned reward. If the reward had already been credited in Stripe,
 * the credit is deliberately NOT clawed back automatically - reversing money
 * on a customer's balance without a human looking at it is the kind of
 * action that turns one billing dispute into two. The reward is marked
 * voided so it shows in the admin view for a decision.
 */
export async function disqualifyReferral(
  referredUserId: string,
  reason: string,
  now: Date = new Date()
): Promise<void> {
  const referral = await prisma.referral.findUnique({ where: { referredUserId } });
  if (!referral || referral.status === "disqualified") return;

  const reward = await prisma.referralReward.findUnique({
    where: { referralId: referral.id },
  });

  await prisma.$transaction(async (tx) => {
    await tx.referral.update({
      where: { id: referral.id },
      data: { status: "disqualified", disqualifiedAt: now, disqualifiedReason: reason },
    });

    if (reward && reward.status !== "voided") {
      await tx.referralReward.update({
        where: { id: reward.id },
        data: { status: "voided", voidedAt: now, voidReason: reason },
      });
    }
  });
}

// --- Qualification and rewards ------------------------------------------

export interface QualifyResult {
  referralId: string;
  rewardId: string;
  referrerUserId: string;
  amountCents: number;
  plan: string;
  creditApplied: boolean;
}

/**
 * Finds customer referrals that have now been paid for 30 days and issues
 * the referrer's reward. Safe to run on every cron tick.
 *
 * Runs as: create the reward row first (the @unique on referralId is what
 * makes this exactly-once), THEN call Stripe. Deliberately not the other way
 * around and deliberately not inside a transaction - a Stripe call inside a
 * database transaction holds a connection open across a network round trip,
 * and a crash between the two would leave money moved with no record of it.
 * This ordering can only ever fail "safe": a reward row with no credit yet,
 * which the next run picks up.
 */
export async function qualifyDueReferrals(now: Date = new Date()): Promise<QualifyResult[]> {
  const cutoff = new Date(now.getTime() - REFERRAL_QUALIFY_DAYS * 86_400_000);

  const due = await prisma.referral.findMany({
    where: {
      kind: "customer",
      status: "paid",
      firstPaidAt: { not: null, lte: cutoff },
      qualifiedAt: null,
      reward: null,
      referrerUserId: { not: null },
    },
    take: 200,
  });

  const results: QualifyResult[] = [];

  for (const referral of due) {
    try {
      // Re-check that the referred customer is STILL paying. Someone who
      // subscribed and cancelled inside the 30-day window shouldn't earn
      // anyone a free month. A missing referredUserId means that account was
      // deleted, which is likewise not a qualifying outcome.
      const referredSubscription = referral.referredUserId
        ? await prisma.subscription.findUnique({
            where: { userId: referral.referredUserId },
            select: { status: true },
          })
        : null;
      const referredStatus = referredSubscription?.status;
      if (referredStatus !== "active" && referredStatus !== "past_due") {
        await prisma.referral.update({
          where: { id: referral.id },
          data: {
            status: "disqualified",
            disqualifiedAt: now,
            disqualifiedReason: `Referred account was ${referredStatus ?? "not subscribed"} at the 30-day qualification check.`,
          },
        });
        continue;
      }

      const referrerUserId = referral.referrerUserId!;
      const referrerSub = await prisma.subscription.findUnique({
        where: { userId: referrerUserId },
      });

      // The reward is one month of the referrer's CURRENT plan, priced at
      // the moment it qualifies and then frozen on the reward row.
      const plan = referrerSub?.plan ?? "profit_intelligence";
      const amountCents = priceCentsForStoredPlan(plan);

      const reward = await prisma.$transaction(async (tx) => {
        const created = await tx.referralReward.create({
          data: {
            referralId: referral.id,
            referrerUserId,
            amountCents,
            plan,
            status: "pending",
          },
        });
        await tx.referral.update({
          where: { id: referral.id },
          data: { status: "qualified", qualifiedAt: now },
        });
        return created;
      });

      const creditApplied = await tryApplyReward(reward.id);

      results.push({
        referralId: referral.id,
        rewardId: reward.id,
        referrerUserId,
        amountCents,
        plan,
        creditApplied,
      });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") continue; // already rewarded
      console.error(
        `referrals: qualification failed for referral ${referral.id}:`,
        err instanceof Error ? err.message : "Unknown error"
      );
    }
  }

  return results;
}

/**
 * Pushes a pending reward onto the referrer's Stripe customer balance.
 *
 * Returns false (rather than throwing) when the referrer has no Stripe
 * customer yet - a trialing customer can absolutely earn a referral reward
 * before they ever subscribe, and it should sit waiting for them rather than
 * being lost. applyPendingRewardsForUser() below picks those up at checkout.
 *
 * The Stripe idempotency key is the reward id, so even if this is called
 * twice for the same reward, Stripe issues the credit once.
 */
export async function tryApplyReward(rewardId: string): Promise<boolean> {
  const reward = await prisma.referralReward.findUnique({ where: { id: rewardId } });
  if (!reward || reward.status !== "pending") return false;

  const referrerSubscription = await prisma.subscription.findUnique({
    where: { userId: reward.referrerUserId },
    select: { stripeCustomerId: true },
  });
  const customerId = referrerSubscription?.stripeCustomerId;
  if (!customerId) return false; // stays pending until they have a Stripe customer

  try {
    const txn = await applyCustomerCredit({
      customerId,
      amountCents: reward.amountCents,
      description: "JobProfitAI referral reward - one free month",
      idempotencyKey: `referral-reward:${reward.id}`,
      metadata: { rewardId: reward.id, referralId: reward.referralId },
    });

    await prisma.referralReward.update({
      where: { id: reward.id },
      data: { status: "applied", appliedAt: new Date(), stripeBalanceTxnId: txn.id },
    });
    return true;
  } catch (err) {
    console.error(
      `referrals: could not apply credit for reward ${rewardId}:`,
      err instanceof Error ? err.message : "Unknown error"
    );
    return false; // left pending; retried on the next cron run
  }
}

/**
 * Applies any rewards that were earned while the referrer had no Stripe
 * customer. Called right after a successful checkout, so credits earned
 * during someone's trial land on their very first invoice.
 */
export async function applyPendingRewardsForUser(userId: string): Promise<number> {
  const pending = await prisma.referralReward.findMany({
    where: { referrerUserId: userId, status: "pending" },
    select: { id: true },
  });

  let applied = 0;
  for (const reward of pending) {
    if (await tryApplyReward(reward.id)) applied++;
  }
  return applied;
}

// --- Reporting -----------------------------------------------------------

export interface ReferralSummary {
  code: string;
  url: string;
  signedUp: number;
  paying: number;
  qualified: number;
  pendingRewardCents: number;
  appliedRewardCents: number;
  totalEarnedCents: number;
}

/** Everything the in-app referral dashboard needs, for one customer. */
export async function getReferralSummary(userId: string): Promise<ReferralSummary> {
  const code = await getOrCreateCustomerReferralCode(userId);

  const [referrals, rewards] = await Promise.all([
    prisma.referral.findMany({
      where: { referrerUserId: userId },
      select: { status: true },
    }),
    prisma.referralReward.findMany({
      where: { referrerUserId: userId },
      select: { status: true, amountCents: true },
    }),
  ]);

  const sum = (status: string) =>
    rewards.filter((r) => r.status === status).reduce((t, r) => t + r.amountCents, 0);

  return {
    code,
    url: referralUrl(code),
    signedUp: referrals.length,
    paying: referrals.filter((r) => r.status === "paid" || r.status === "qualified").length,
    qualified: referrals.filter((r) => r.status === "qualified").length,
    pendingRewardCents: sum("pending"),
    appliedRewardCents: sum("applied"),
    totalEarnedCents: sum("pending") + sum("applied"),
  };
}

/**
 * Referral history rows for the dashboard.
 *
 * PRIVACY: deliberately returns no identifying detail about the referred
 * business - no name, no email, no company. A referrer is entitled to know
 * their link converted and that they earned a credit; they are not entitled
 * to another contractor's account details just because they shared a link.
 */
export async function getReferralHistory(userId: string) {
  const referrals = await prisma.referral.findMany({
    where: { referrerUserId: userId },
    orderBy: { signedUpAt: "desc" },
    take: 100,
  });

  const rewards = await prisma.referralReward.findMany({
    where: { referralId: { in: referrals.map((r) => r.id) } },
  });
  const rewardByReferral = new Map(rewards.map((reward) => [reward.referralId, reward]));

  return referrals.map((r) => {
    const reward = rewardByReferral.get(r.id);
    return {
      id: r.id,
      status: r.status,
      signedUpAt: r.signedUpAt,
      firstPaidAt: r.firstPaidAt,
      qualifiedAt: r.qualifiedAt,
      rewardStatus: reward?.status ?? null,
      rewardAmountCents: reward?.amountCents ?? null,
      rewardAppliedAt: reward?.appliedAt ?? null,
    };
  });
}
