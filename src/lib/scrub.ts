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
  const full = typeof input === "string" ? input : String(input ?? "");
  // Cut before scrubbing as well as after, so a very long value (a request
  // header, say) can't make the patterns below slow. The cut goes back to
  // the last space, so no half of a value is left that the patterns no
  // longer recognise ("ow" of an email address, the start of a key): a cut
  // through the middle let those through once the text before them shrank
  // (audit Oct 27, SEC5).
  let text = full.slice(0, maxLength * 4);
  if (full.length > text.length) {
    // Back to the last space near the end, else to the last character near
    // the end that can't be part of an address or key. With neither, the
    // whole run the cut landed in, 400 characters or more with no break,
    // becomes [token]: the token rule below would leave the dotted end of
    // one (".bob.smith" of an address cut before its domain). Only near the
    // end (the last 400 characters, more than an address or key can be), so
    // a long message with one early space, a compact JSON body say, isn't
    // cut back to almost nothing.
    const tail = text.slice(-400);
    let at = tail.search(/\s\S*$/);
    if (at < 0) at = tail.search(/[^A-Za-z0-9._%+@-][A-Za-z0-9._%+@-]*$/);
    if (at >= 0) text = text.slice(0, text.length - tail.length + at);
    else text = `${text.slice(0, text.search(/[A-Za-z0-9._%+@-]*$/))}[token]`;
    text = withoutUnclosedQuote(text);
  }
  // A database error prints the query's values: only the call that failed
  // is kept, as errorMessage below does when it has the error itself. Our
  // routes log err.message as text, which used to get only the general rules.
  // Prisma names the call as written, so inside a transaction it's
  // tx.referral.update(), not prisma.referral.update().
  const prismaCall = PRISMA_INVOCATION.exec(text);
  if (prismaCall) text = `${text.slice(0, prismaCall.index)}Database error in ${prismaCall[1]}()`;
  // Query strings and email addresses come out of the whole text first, so
  // an ID kept below can't carry one through (sub_team@acme.com, or
  // /customers/cus_.../?name=...).
  text = withoutQueries(text).replace(EMAIL, "[email]");
  // Odd-numbered parts are kept as they are: "intuit_tid: <id>", and Stripe's
  // object IDs (an event, subscription, customer, invoice or charge), which
  // are references, not secrets, and are what a failed webhook or a
  // duplicate subscription needs to be traced (audit Oct 27, SEC4). Keys
  // (sk_, rk_, pk_, whsec_) don't match and are still taken out, and so is
  // re_, which is how Resend's API keys start as well as Stripe's refunds.
  const parts = text.split(KEEP);
  const scrubbed = parts.map((part, i) => (i % 2 === 1 ? part : scrubPart(part))).join("");
  return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength - 3)}...` : scrubbed;
}

const KEEP = /(intuit_tid:\s*[A-Za-z0-9-]{1,64}|\b(?:evt|sub|cus|in|ii|pi|ch|si|price|prod|cs)_(?:(?:live|test)_)?[A-Za-z0-9]{8,64}\b(?!@))/;

/** `Invalid \`prisma.job.findMany()\` invocation`, or tx.job.findMany() inside a transaction. */
const PRISMA_INVOCATION = /Invalid `([A-Za-z_$][\w$]{0,40}\.\w+\.\w+)\(\)` invocation/;
const PRISMA_CALL = /`([A-Za-z_$][\w$]{0,40}\.\w+\.\w+)\(\)`/;

// Bounded parts, so a long run of letters with an "@" can't backtrack for long.
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,10}[A-Za-z]{2,24}\b/g;

/** A URL's query string and fragment: codes, tokens, search terms. */
function withoutQueries(s: string): string {
  return s.replace(/\b((?:https?|wss?):\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, "$1");
}

/**
 * Text cut to length can end inside a quoted value, which the quote rules
 * below then don't see as quoted: "Smith Kitc. The open quote and what
 * follows it go.
 */
function withoutUnclosedQuote(t: string): string {
  if (((t.match(/"/g) ?? []).length & 1) === 1) t = t.slice(0, t.lastIndexOf('"'));
  const curly = t.lastIndexOf("\u201c");
  if (curly > t.lastIndexOf("\u201d")) t = t.slice(0, curly);
  // A single quote where the rule below would open one, with none after it.
  const single = /(^|[\s(:,=[])'[^']*$/.exec(t);
  if (single) t = t.slice(0, single.index + single[1].length);
  return t;
}

function scrubPart(s: string): string {
  return (
    withoutQueries(s)
      .replace(EMAIL, "[email]")
      .replace(/\b(Bearer|Basic)\s+[^\s"',;)]+/gi, "$1 [redacted]")
      .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, "[token]")
      // Bounded on both sides of the word: unbounded, a long run such as
      // "key-key-key-..." backtracked for seconds (audit Oct 27, SEC3).
      .replace(
        /\b([\w.-]{0,40}(?:token|secret|password|passwd|session|cookie|auth|key|code|signature|sig)[\w.-]{0,40})\s*=\s*[^\s&"',;)]+/gi,
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
    const call = PRISMA_CALL.exec(err.message)?.[1];
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

