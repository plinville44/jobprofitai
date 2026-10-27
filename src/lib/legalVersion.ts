/**
 * The legal documents' version, in one place.
 *
 * LEGAL_LAST_UPDATED is the "Last updated" date printed on the Terms, the
 * Privacy Policy, the Data Processing Addendum and Your Privacy Choices.
 * Change it to the day any of them changes.
 *
 * ACCEPTANCE_VERSION is the version a login must have agreed to. Bump it only
 * for a material change that people should accept again: every login is
 * then asked once, at its next visit to the app (/accept-terms), and the
 * acceptance is recorded (src/lib/termsAcceptance.ts). Before bumping it,
 * save the new text in legal-archive/ under the same date.
 *
 * A change that isn't material moves only LEGAL_LAST_UPDATED, and its text
 * is saved in legal-archive/ under the new date too, so every wording ever
 * published is on record. October 26, 2026 added the Privacy Policy's
 * "Videos" section (the click-to-play demo video, then on YouTube), and
 * October 27, 2026 changed it to say the videos play from our own website.
 * Neither needs a new acceptance: the 2026-10-14 version stays the one
 * people agree to.
 */
export const LEGAL_LAST_UPDATED = "October 27, 2026";
export const ACCEPTANCE_VERSION = "2026-10-14";

/**
 * The earliest day the data-retention rules (src/lib/dataRetention.ts) can
 * count from. The real start is recorded by the first lifecycle run in
 * production (retentionRulesStart in src/lib/companyData.ts), so companies
 * disconnected, and accounts that lapsed, before the rules went live get the
 * full 30 (or 90) days from launch day, whatever day that turns out to be.
 */
export const RETENTION_RULES_START = "2026-10-14";
