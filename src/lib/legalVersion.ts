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
 */
export const LEGAL_LAST_UPDATED = "October 8, 2026";
export const ACCEPTANCE_VERSION = "2026-10-08";

/**
 * The day the data-retention rules (src/lib/dataRetention.ts) took effect.
 * Set it to the day they go live, once, and never move it later after that:
 * it decides when the first deletions happen for companies disconnected, and
 * accounts that lapsed, before the rules existed.
 */
export const RETENTION_RULES_START = "2026-10-08";
