/**
 * Takes QuickBooks data, credentials and personal details out of text that
 * leaves the app's own memory: error reports to Sentry (src/lib/monitoring.ts),
 * server log lines (src/lib/logScrub.ts) and error messages shown in the
 * browser (src/lib/publicError.ts). One module, so all three follow the same
 * rules.
 */

/** Most messages are a line; a long one is cut, which also bounds what a scrub might miss. */
const MAX_TEXT = 500;

/**
 * Takes personal details and secrets out of a piece of text before it goes
 * to Sentry: email addresses, bearer and basic credentials, JWTs, name=value
 * pairs that look like secrets, URL query strings, quoted text (where error
 * messages from libraries echo back values, such as a bad piece of JSON),
 * long token-like strings and IDs, IP addresses, amounts and long numbers.
 * Then cuts it to about 500 characters.
 *
 * Intuit's intuit_tid is kept: it's a request ID, not a secret, and the app
 * already logs it with QuickBooks errors so Intuit's support can trace them.
 */
export function scrubText(input: unknown, maxLength: number = MAX_TEXT): string {
  // Cut before scrubbing as well as after, so a very long value (a request
  // header, say) can't make the patterns below slow.
  const text = (typeof input === "string" ? input : String(input ?? "")).slice(0, maxLength * 2);
  // Odd-numbered parts are "intuit_tid: <id>", left as they are.
  const parts = text.split(/(intuit_tid:\s*[A-Za-z0-9-]{1,64})/);
  const scrubbed = parts.map((part, i) => (i % 2 === 1 ? part : scrubPart(part))).join("");
  return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength - 3)}...` : scrubbed;
}

function scrubPart(s: string): string {
  return (
    s
      // A URL's query string and fragment: codes, tokens, search terms.
      .replace(/\b((?:https?|wss?):\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, "$1")
      // Bounded parts, so a long run of letters with an "@" can't backtrack for long.
      .replace(/[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,10}[A-Za-z]{2,24}\b/g, "[email]")
      .replace(/\b(Bearer|Basic)\s+[^\s"',;)]+/gi, "$1 [redacted]")
      .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, "[token]")
      .replace(
        /\b([\w.-]*(?:token|secret|password|passwd|session|cookie|auth|key|code|signature|sig)[\w.-]*)\s*=\s*[^\s&"',;)]+/gi,
        "$1=[redacted]"
      )
      // Quoted text. Single quotes only when the text inside has a space,
      // so a property name in a TypeError ('companyName') stays readable,
      // and an apostrophe ("couldn't") is never taken for a quote.
      .replace(/"[^"\n]*"/g, '"[redacted]"')
      .replace(/“[^”\n]*”/g, "“[redacted]”")
      .replace(/(^|[\s(:,=[])'([^'\n]*\s[^'\n]*)'(?=$|[\s),.;:\]])/g, "$1'[redacted]'")
      // Tokens, API keys, database IDs: 24 or more letters, digits, - and _.
      .replace(/[A-Za-z0-9_-]{24,}/g, "[token]")
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[ip]")
      .replace(/\$\s?-?\d[\d,]*(?:\.\d+)?/g, "[amount]")
      .replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, "[number]")
      .replace(/\b\d+\.\d+\b/g, "[number]")
      // QuickBooks company IDs, account and phone numbers, amounts in cents.
      .replace(/\b\d{5,}\b/g, "[number]")
  );
}

/**
 * Database errors can print the whole query, values and all, so only the
 * error's code and the call that failed are kept from them.
 */
export function errorMessage(err: { name: string; message: string; code?: unknown }): string {
  if (err.name.startsWith("PrismaClient")) {
    const code = typeof err.code === "string" && /^P\d{4}$/.test(err.code) ? err.code : null;
    const call = /`(prisma\.\w+\.\w+)\(\)`/.exec(err.message)?.[1];
    return ["Database error", code, call ? `in ${call}()` : null].filter(Boolean).join(" ");
  }
  return scrubText(err.message);
}

export function describeError(err: unknown): { type: string; value: string; stack?: string } {
  if (err !== null && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    const e = err as { name?: unknown; message: string; stack?: unknown; code?: unknown; constructor?: { name?: unknown } };
    let name = typeof e.name === "string" ? e.name : "Error";
    if (name === "Error" && typeof e.constructor?.name === "string" && e.constructor.name !== "Object") name = e.constructor.name;
    const type = /^[A-Za-z_$][\w$.]{0,99}$/.test(name) ? name : "Error";
    return {
      type,
      value: errorMessage({ name: type, message: e.message, code: e.code }),
      stack: typeof e.stack === "string" ? e.stack : undefined,
    };
  }
  // A thrown string or object could be anything, so only its type is said.
  return { type: "NonErrorThrown", value: `A value of type ${err === null ? "null" : typeof err} was thrown instead of an Error` };
}

/**
 * An error described the way an error report describes it: its kind and its
 * scrubbed message (for a database error, only the code and the call). For
 * log lines and anything else that shouldn't carry the raw message.
 */
export function safeErrorText(err: unknown): string {
  const { type, value } = describeError(err);
  return `${type}: ${value}`;
}

