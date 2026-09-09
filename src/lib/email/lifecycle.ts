import { prisma } from "@/lib/prisma";
import { PLANS, isPlanId } from "@/lib/plans";
import { sendEmail, sendLifecycleEmail, SUPPORT_EMAIL, type SendEmailResult } from "./client";
import * as T from "./templates";

// Every lifecycle email trigger in one place, each with an explicit dedupe
// key. Nothing else in the app calls sendLifecycleEmail() directly, so the
// full set of things JobProfitAI will ever email a customer is auditable by
// reading this one file.
//
// Dedupe keys are the important detail. Each encodes the specific lifecycle
// INSTANT an email belongs to, not just the user - so:
//   * an hourly cron re-running sends nothing twice, and
//   * a legitimately new instant (a trial extended to a new date, a second
//     invoice failing months later) is correctly treated as a new email
//     rather than being suppressed forever by an old key.

interface Contact {
  email: string;
  name: string | null;
}

async function contactFor(userId: string): Promise<Contact | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true },
  });
  return user ?? null;
}

/** ISO day stamp, used where "once per day" is the right granularity. */
function dayStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// --- Trial ---------------------------------------------------------------

export async function sendTrialWelcome(userId: string): Promise<SendEmailResult> {
  const contact = await contactFor(userId);
  if (!contact) return { ok: false, error: "User not found" };
  const email = T.trialWelcomeEmail(contact.name);

  return sendLifecycleEmail({
    userId,
    emailType: "trial_welcome",
    // One welcome per account, ever.
    dedupeKey: `trial_welcome:${userId}`,
    to: contact.email,
    ...email,
  });
}

export async function sendSetupReminder(userId: string, daysLeft: number): Promise<SendEmailResult> {
  const contact = await contactFor(userId);
  if (!contact) return { ok: false, error: "User not found" };
  const email = T.setupReminderEmail(contact.name, daysLeft);

  return sendLifecycleEmail({
    userId,
    emailType: "setup_reminder",
    dedupeKey: `setup_reminder:${userId}`,
    to: contact.email,
    ...email,
  });
}

export async function sendAnalysisReady(
  userId: string,
  companyName: string
): Promise<SendEmailResult> {
  const contact = await contactFor(userId);
  if (!contact) return { ok: false, error: "User not found" };
  const email = T.analysisReadyEmail(companyName);

  return sendLifecycleEmail({
    userId,
    emailType: "analysis_ready",
    dedupeKey: `analysis_ready:${userId}`,
    to: contact.email,
    ...email,
  });
}

/**
 * The day-12 email. Which version goes out depends on whether the account is
 * eligible for the feedback extension - an unactivated account gets the
 * plain "choose a plan" version rather than an offer it can't accept.
 *
 * The dedupe key includes the trial end date, which is what makes the
 * extension flow work correctly: after a trial is extended, trialEndsAt
 * changes, so the account can legitimately receive one more "ending soon"
 * email for its new date without the original key blocking it.
 */
export async function sendTrialEndingSoon(params: {
  userId: string;
  trialEndsAt: Date;
  daysLeft: number;
  offerExtension: boolean;
  extensionWouldEndAt: Date | null;
}): Promise<SendEmailResult> {
  const contact = await contactFor(params.userId);
  if (!contact) return { ok: false, error: "User not found" };

  const email =
    params.offerExtension && params.extensionWouldEndAt
      ? T.trialEndingWithOfferEmail(params.daysLeft, params.extensionWouldEndAt)
      : T.trialEndingNoOfferEmail(params.daysLeft, params.trialEndsAt);

  return sendLifecycleEmail({
    userId: params.userId,
    emailType: params.offerExtension ? "trial_ending_offer" : "trial_ending_soon",
    dedupeKey: `trial_ending:${params.userId}:${dayStamp(params.trialEndsAt)}`,
    to: contact.email,
    ...email,
  });
}

export async function sendTrialExtended(
  userId: string,
  newTrialEndsAt: Date
): Promise<SendEmailResult> {
  const contact = await contactFor(userId);
  if (!contact) return { ok: false, error: "User not found" };
  const email = T.trialExtendedEmail(newTrialEndsAt);

  return sendLifecycleEmail({
    userId,
    emailType: "trial_extended",
    // The extension can only happen once, so the user id alone is enough.
    dedupeKey: `trial_extended:${userId}`,
    to: contact.email,
    ...email,
  });
}

export async function sendTrialExpired(
  userId: string,
  trialEndsAt: Date
): Promise<SendEmailResult> {
  const contact = await contactFor(userId);
  if (!contact) return { ok: false, error: "User not found" };
  const email = T.trialExpiredEmail();

  return sendLifecycleEmail({
    userId,
    emailType: "trial_expired",
    // Keyed to the expiry date, so an extended-then-expired trial can send
    // this once for the extended date too.
    dedupeKey: `trial_expired:${userId}:${dayStamp(trialEndsAt)}`,
    to: contact.email,
    ...email,
  });
}

/**
 * Deliberately entirely separate from the trial extension. Sent only to
 * accounts with genuine sustained usage, and it asks - it does not trade
 * anything for it, and nothing about the account changes either way.
 */
export async function sendTestimonialRequest(userId: string): Promise<SendEmailResult> {
  const contact = await contactFor(userId);
  if (!contact) return { ok: false, error: "User not found" };
  const email = T.testimonialRequestEmail(contact.name);

  return sendLifecycleEmail({
    userId,
    emailType: "testimonial_request",
    dedupeKey: `testimonial_request:${userId}`,
    to: contact.email,
    ...email,
  });
}

// --- Billing -------------------------------------------------------------

export async function sendSubscriptionConfirmed(
  userId: string,
  plan: string,
  stripeSubscriptionId: string
): Promise<SendEmailResult> {
  const contact = await contactFor(userId);
  if (!contact) return { ok: false, error: "User not found" };

  const def = isPlanId(plan) ? PLANS[plan] : PLANS.profit_intelligence;
  const email = T.subscriptionConfirmedEmail(def.name, def.priceLabel);

  return sendLifecycleEmail({
    userId,
    emailType: "subscription_confirmed",
    // Keyed to the subscription so resubscribing after a cancellation
    // correctly sends a fresh welcome.
    dedupeKey: `subscription_confirmed:${userId}:${stripeSubscriptionId}`,
    to: contact.email,
    ...email,
  });
}

export async function sendPaymentFailed(
  userId: string,
  plan: string,
  stripeInvoiceId: string
): Promise<SendEmailResult> {
  const contact = await contactFor(userId);
  if (!contact) return { ok: false, error: "User not found" };

  const def = isPlanId(plan) ? PLANS[plan] : PLANS.profit_intelligence;
  const email = T.paymentFailedEmail(def.name);

  return sendLifecycleEmail({
    userId,
    emailType: "payment_failed",
    // Per invoice: Stripe retries the same invoice several times and we only
    // want to email about it once, but a different invoice failing later is
    // genuinely new information.
    dedupeKey: `payment_failed:${userId}:${stripeInvoiceId}`,
    to: contact.email,
    ...email,
  });
}

export async function sendSubscriptionCanceled(
  userId: string,
  stripeSubscriptionId: string,
  accessUntil: Date | null
): Promise<SendEmailResult> {
  const contact = await contactFor(userId);
  if (!contact) return { ok: false, error: "User not found" };
  const email = T.subscriptionCanceledEmail(accessUntil);

  return sendLifecycleEmail({
    userId,
    emailType: "subscription_canceled",
    dedupeKey: `subscription_canceled:${userId}:${stripeSubscriptionId}`,
    to: contact.email,
    ...email,
  });
}

// --- Customer referrals --------------------------------------------------

export async function sendReferralSignup(
  referrerUserId: string,
  referralId: string
): Promise<SendEmailResult> {
  const contact = await contactFor(referrerUserId);
  if (!contact) return { ok: false, error: "User not found" };
  const email = T.referralSignupEmail();

  return sendLifecycleEmail({
    userId: referrerUserId,
    emailType: "referral_signup",
    dedupeKey: `referral_signup:${referralId}`,
    to: contact.email,
    ...email,
  });
}

export async function sendReferralConverted(
  referrerUserId: string,
  referralId: string
): Promise<SendEmailResult> {
  const contact = await contactFor(referrerUserId);
  if (!contact) return { ok: false, error: "User not found" };
  const email = T.referralConvertedEmail();

  return sendLifecycleEmail({
    userId: referrerUserId,
    emailType: "referral_converted",
    dedupeKey: `referral_converted:${referralId}`,
    to: contact.email,
    ...email,
  });
}

export async function sendReferralRewardEarned(params: {
  referrerUserId: string;
  rewardId: string;
  amountCents: number;
  applied: boolean;
}): Promise<SendEmailResult> {
  const contact = await contactFor(params.referrerUserId);
  if (!contact) return { ok: false, error: "User not found" };
  const email = T.referralRewardEarnedEmail(params.amountCents, params.applied);

  return sendLifecycleEmail({
    userId: params.referrerUserId,
    emailType: "referral_reward_earned",
    dedupeKey: `referral_reward_earned:${params.rewardId}`,
    to: contact.email,
    ...email,
  });
}

// --- Partner program -----------------------------------------------------

export async function sendPartnerApplicationReceived(
  userId: string,
  partnerId: string,
  firmName: string
): Promise<SendEmailResult> {
  const contact = await contactFor(userId);
  if (!contact) return { ok: false, error: "User not found" };
  const email = T.partnerApplicationReceivedEmail(firmName);

  return sendLifecycleEmail({
    userId,
    emailType: "partner_application_received",
    dedupeKey: `partner_application_received:${partnerId}`,
    to: contact.email,
    ...email,
  });
}

export async function sendPartnerApproved(
  userId: string,
  partnerId: string,
  firmName: string,
  url: string
): Promise<SendEmailResult> {
  const contact = await contactFor(userId);
  if (!contact) return { ok: false, error: "User not found" };
  const email = T.partnerApprovedEmail(firmName, url);

  return sendLifecycleEmail({
    userId,
    emailType: "partner_approved",
    dedupeKey: `partner_approved:${partnerId}`,
    to: contact.email,
    ...email,
  });
}

export async function sendPartnerNewSignup(
  partnerUserId: string,
  referralId: string
): Promise<SendEmailResult> {
  const contact = await contactFor(partnerUserId);
  if (!contact) return { ok: false, error: "User not found" };
  const email = T.partnerNewSignupEmail();

  return sendLifecycleEmail({
    userId: partnerUserId,
    emailType: "partner_new_signup",
    dedupeKey: `partner_new_signup:${referralId}`,
    to: contact.email,
    ...email,
  });
}

export async function sendPartnerNewPayingClient(params: {
  partnerUserId: string;
  referralId: string;
  payingClients: number;
  ratePct: number;
}): Promise<SendEmailResult> {
  const contact = await contactFor(params.partnerUserId);
  if (!contact) return { ok: false, error: "User not found" };
  const email = T.partnerNewPayingClientEmail(params.payingClients, params.ratePct);

  return sendLifecycleEmail({
    userId: params.partnerUserId,
    emailType: "partner_new_paying_client",
    dedupeKey: `partner_new_paying_client:${params.referralId}`,
    to: contact.email,
    ...email,
  });
}

export async function sendPartnerTierUpgrade(params: {
  partnerUserId: string;
  partnerId: string;
  tierKey: string;
  ratePct: number;
  payingClients: number;
}): Promise<SendEmailResult> {
  const contact = await contactFor(params.partnerUserId);
  if (!contact) return { ok: false, error: "User not found" };
  const email = T.partnerTierUpgradeEmail(params.ratePct, params.payingClients);

  return sendLifecycleEmail({
    userId: params.partnerUserId,
    emailType: "partner_tier_upgrade",
    // Keyed to the tier, so each upgrade is announced exactly once even if
    // the partner's client count oscillates around a threshold.
    dedupeKey: `partner_tier_upgrade:${params.partnerId}:${params.tierKey}`,
    to: contact.email,
    ...email,
  });
}

export async function sendPartnerCommissionEarned(params: {
  partnerUserId: string;
  stripeInvoiceId: string;
  amountCents: number;
  monthNumber: number;
}): Promise<SendEmailResult> {
  const contact = await contactFor(params.partnerUserId);
  if (!contact) return { ok: false, error: "User not found" };
  const email = T.partnerCommissionEarnedEmail(params.amountCents, params.monthNumber);

  return sendLifecycleEmail({
    userId: params.partnerUserId,
    emailType: "partner_commission_earned",
    // Per invoice - the same guarantee that stops duplicate commissions
    // stops duplicate commission emails.
    dedupeKey: `partner_commission_earned:${params.stripeInvoiceId}`,
    to: contact.email,
    ...email,
  });
}

export async function sendPartnerPayoutRecorded(params: {
  partnerUserId: string;
  payoutRef: string;
  amountCents: number;
  note: string | null;
}): Promise<SendEmailResult> {
  const contact = await contactFor(params.partnerUserId);
  if (!contact) return { ok: false, error: "User not found" };
  const email = T.partnerPayoutRecordedEmail(params.amountCents, params.note);

  return sendLifecycleEmail({
    userId: params.partnerUserId,
    emailType: "partner_payout_recorded",
    dedupeKey: `partner_payout_recorded:${params.payoutRef}`,
    to: contact.email,
    ...email,
  });
}

// --- Contact form --------------------------------------------------------

/**
 * The internal notification. Goes to CONTACT_TO_EMAIL, which is
 * support@jobprofitai.com in production - never a personal address.
 * Reply-To is set to the person who filled in the form so replying from the
 * support inbox reaches them directly.
 *
 * Not idempotent by dedupe key, on purpose: each submission is a distinct
 * event and two genuine enquiries from the same person must both arrive.
 * The ContactSubmission row is the durable record either way.
 */
export async function sendContactNotification(input: {
  name: string;
  company?: string | null;
  email: string;
  phone?: string | null;
  reason: string;
  message: string;
}): Promise<SendEmailResult> {
  const to = process.env.CONTACT_TO_EMAIL?.trim() || SUPPORT_EMAIL;
  const email = T.contactNotificationEmail(input);

  return sendEmail({
    to,
    replyTo: input.email,
    ...email,
  });
}

/** Confirmation to the person who submitted the form. */
export async function sendContactConfirmation(input: {
  name: string;
  email: string;
}): Promise<SendEmailResult> {
  const email = T.contactConfirmationEmail(input.name);
  return sendEmail({
    to: input.email,
    replyTo: SUPPORT_EMAIL,
    ...email,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// ACCOUNT SECURITY
// ─────────────────────────────────────────────────────────────────────────

/**
 * The reset link.
 *
 * Recipient details are passed in rather than looked up by id, because the
 * caller has just resolved this account by email address and re-querying
 * would only add a chance of sending to the wrong place.
 *
 * The dedupe key includes the token's expiry, which is unique per request to
 * the millisecond. So the EmailEvent audit row still exists for every reset,
 * but an accidental double-submit of the same request cannot send twice.
 */
export async function sendPasswordReset(input: {
  userId: string;
  email: string;
  token: string;
  expiresAt: Date;
  expiryMinutes: number;
}): Promise<SendEmailResult> {
  const resetUrl = T.appUrl(`/reset-password?token=${encodeURIComponent(input.token)}`);
  const email = T.passwordResetEmail(resetUrl, input.expiryMinutes);

  return sendLifecycleEmail({
    userId: input.userId,
    emailType: "password_reset",
    dedupeKey: `password_reset:${input.userId}:${input.expiresAt.toISOString()}`,
    to: input.email,
    replyTo: SUPPORT_EMAIL,
    ...email,
  });
}

/**
 * Sent after a password actually changes.
 *
 * This is the account's alarm bell: if someone else reset the password, this
 * message is the only way the real owner finds out. It is deliberately sent
 * to the address on the account, not to whoever performed the reset.
 */
export async function sendPasswordChanged(input: {
  userId: string;
  email: string;
  changedAt: Date;
}): Promise<SendEmailResult> {
  const email = T.passwordChangedEmail();

  return sendLifecycleEmail({
    userId: input.userId,
    emailType: "password_changed",
    dedupeKey: `password_changed:${input.userId}:${input.changedAt.toISOString()}`,
    to: input.email,
    replyTo: SUPPORT_EMAIL,
    ...email,
  });
}
