/**
 * The legal documents' versions, in one place.
 *
 * LEGAL_UPDATED is the "Last updated" date each document prints: the day
 * its own text last changed. Move a document's date only when its text
 * changes, so a customer never reads a new date on words that are the same
 * as before. LEGAL_LAST_UPDATED is the newest of them, the last change to
 * any of the four.
 *
 * ACCEPTANCE_VERSION is the version a login must have agreed to. Bump it only
 * for a material change that people should accept again: every login is
 * then asked once, at its next visit to the app (/accept-terms), and the
 * acceptance is recorded (src/lib/termsAcceptance.ts). Before bumping it,
 * save the new text in legal-archive/ under the same date.
 *
 * Whenever any date here moves, save all four documents, as the site then
 * shows them, in legal-archive/ under the new LEGAL_LAST_UPDATED, so every
 * wording ever published is on record (legal-archive/README.md).
 *
 * Nothing since 2026-10-14 was material, so that stays the version people
 * agree to. Every change since was to the Privacy Policy's "Videos"
 * section: October 26, 2026 added it, October 27 said the videos play from
 * our own website, and October 28 said which videos our emails link to on
 * YouTube and that the player links there if a video can't load. The other
 * three documents' text is unchanged since October 14, the date they print.
 */
export const LEGAL_UPDATED = {
  terms: "October 14, 2026",
  privacy: "October 28, 2026",
  dpa: "October 14, 2026",
  "privacy-choices": "October 14, 2026",
} as const;

/** One of the four documents, named as its page and its legal-archive file are. */
export type LegalDocument = keyof typeof LEGAL_UPDATED;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A printed date ("October 28, 2026") as the YYYY-MM-DD its archive folder is named for. */
export function legalDateKey(printed: string): string {
  const m = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(printed);
  const month = m ? MONTHS.indexOf(m[1]) + 1 : 0;
  if (!m || month === 0) throw new Error(`Not a legal date: ${printed}`);
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** A YYYY-MM-DD key as a printed date: "2026-10-14" reads "October 14, 2026". */
export function legalDatePrinted(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  if (!m || !month) throw new Error(`Not a legal date key: ${key}`);
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

/** The newest "Last updated" date among these documents (all four by default). */
export function newestLegalUpdate(docs: LegalDocument[] = Object.keys(LEGAL_UPDATED) as LegalDocument[]): string {
  return docs.map((d) => LEGAL_UPDATED[d]).reduce((a, b) => (legalDateKey(b) > legalDateKey(a) ? b : a));
}

/** The last change to any of the legal documents. */
export const LEGAL_LAST_UPDATED = newestLegalUpdate();
export const ACCEPTANCE_VERSION = "2026-10-14";

/**
 * The earliest day the data-retention rules (src/lib/dataRetention.ts) can
 * count from. The real start is recorded by the first lifecycle run in
 * production (retentionRulesStart in src/lib/companyData.ts), so companies
 * disconnected, and accounts that lapsed, before the rules went live get the
 * full 30 (or 90) days from launch day, whatever day that turns out to be.
 */
export const RETENTION_RULES_START = "2026-10-14";
