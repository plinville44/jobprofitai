import { safeErrorText, scrubText } from "./scrub";

/**
 * Keeps QuickBooks data, credentials and personal details out of the server
 * logs (Vercel's runtime logs). Intuit's security requirements: "You must
 * not log any user's credentials or QuickBooks data."
 *
 * Every console.log, info, warn, error and debug call in the server, ours
 * and Next.js's own (an uncaught error in a page is printed through
 * console.error), passes through scrubLogArg first:
 *  - text is scrubbed the same way as an error report (scrubText in
 *    src/lib/scrub.ts: quoted text such as an email's subject, amounts,
 *    email addresses, tokens, long numbers and URL query strings go), except
 *    that our own record IDs (cuid, "c" and 24 lowercase letters and digits)
 *    and Intuit's intuit_tid are kept, so a failure can still be traced;
 *  - an Error keeps its kind, its scrubbed message (for a database error,
 *    only the code and the call, since those print the query's values), its
 *    stack frames, which are only function names and file positions, and
 *    the digest Next.js shows on its error page;
 *  - a line is cut at 2,000 characters, and quoted text is always taken out
 *    (so a quoted label reads "[redacted]" too);
 *  - any other object is left out, since it could hold anything.
 *
 * Installed once per server instance by register() in src/instrumentation.ts.
 */

const CUID = /\bc[a-z0-9]{24}\b/g;
const METHODS = ["log", "info", "warn", "error", "debug"] as const;
const INSTALLED = Symbol.for("jobprofitai.logScrub");
/** Longer than an error report's 500 characters: a log line can say more. */
const MAX_LOG_TEXT = 2000;

/**
 * Runs a scrub with our own record IDs taken out first and put back after,
 * so they survive the "long token-like string" rule. A placeholder the
 * length limit cut in half is dropped.
 */
function keepingIds(text: string, scrub: (marked: string) => string): string {
  const ids: string[] = [];
  const marked = text.replace(CUID, (id) => {
    ids.push(id);
    return `\u0000ID${ids.length - 1}\u0000`;
  });
  return scrub(marked)
    .replace(/\u0000ID(\d+)\u0000/g, (_, i: string) => ids[Number(i)] ?? "")
    .replace(/\u0000(?:ID\d*)?/g, "");
}

/** Log text, scrubbed, with our own record IDs kept. */
export function scrubLogText(text: string): string {
  return keepingIds(text, (marked) => scrubText(marked, MAX_LOG_TEXT));
}

function stackFrames(stack: unknown): string {
  if (typeof stack !== "string") return "";
  const frames = stack.split("\n").filter((line) => /^\s+at /.test(line)).slice(0, 15);
  return frames.length ? `\n${frames.join("\n")}` : "";
}

/**
 * An error for the log: its kind and scrubbed message (record IDs kept), its
 * stack frames, and the digest Next.js shows on its error page, so a
 * customer's "Digest: ..." can be found in the logs. The digest is a hash.
 */
function errorForLog(err: Error): string {
  const code = (err as { code?: unknown }).code;
  const text = keepingIds(err.message, (marked) =>
    safeErrorText({ name: err.name, message: marked, code, constructor: err.constructor })
  );
  const digest = (err as { digest?: unknown }).digest;
  const digestText = typeof digest === "string" && /^[\w-]{1,64}$/.test(digest) ? ` (digest: ${digest})` : "";
  return text + digestText + stackFrames(err.stack);
}

export function scrubLogArg(arg: unknown): unknown {
  if (arg == null || typeof arg === "number" || typeof arg === "boolean" || typeof arg === "bigint") return arg;
  if (typeof arg === "string") return scrubLogText(arg);
  if (arg instanceof Error) return errorForLog(arg);
  if (typeof arg === "object") {
    const name = (arg as { constructor?: { name?: unknown } }).constructor?.name;
    return `[${typeof name === "string" && /^\w{1,40}$/.test(name) ? name : "object"} left out of the log]`;
  }
  return `[${typeof arg} left out of the log]`;
}

type ConsoleMethod = (...args: unknown[]) => void;

/** Replaces the console's methods with scrubbing ones. Safe to call more than once. */
export function installLogScrubbing(target: Console = console): void {
  const flagged = target as unknown as Record<symbol, boolean>;
  if (flagged[INSTALLED]) return;
  for (const method of METHODS) {
    const original = (target[method] as ConsoleMethod).bind(target);
    (target as unknown as Record<string, ConsoleMethod>)[method] = (...args: unknown[]) => {
      let safe: unknown[];
      try {
        safe = args.map(scrubLogArg);
      } catch {
        safe = ["[log line left out: it couldn't be checked]"];
      }
      original(...safe);
    };
  }
  flagged[INSTALLED] = true;
}
