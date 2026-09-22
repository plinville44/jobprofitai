// Deterministic clean-up of the AI-written part of the Weekly Profit Brief.
//
// The prompt asks for all of this. This makes it true whether or not the
// model listened, because the text goes straight into a customer's inbox.

/**
 * - Drops a leading "Subject:" line. Asked for a "headline take", the model
 *   sometimes writes itself an email subject, which then arrived as the
 *   first line of the body under the real subject.
 * - Drops a leading greeting ("Hi team,"), which reads oddly beneath a
 *   deterministic section.
 * - Replaces em and en dashes. House style is no dashes as punctuation in
 *   any copy; a spaced dash becomes a comma, a bare one (a range such as
 *   "Jan–Mar") becomes a hyphen.
 */
export function cleanDigestText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  while (lines.length > 0) {
    const first = lines[0].trim();
    if (first === "" || /^subject\s*:/i.test(first) || /^(hi|hello|hey|good (morning|afternoon))\b.*,$/i.test(first)) {
      lines.shift();
      continue;
    }
    break;
  }

  return lines
    .join("\n")
    .replace(/[ \t]+[—–][ \t]+/g, ", ")
    .replace(/[—–]/g, "-")
    .trim();
}
