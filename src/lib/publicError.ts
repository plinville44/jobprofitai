import { scrubText } from "./scrub";

// The app's own errors whose messages are written for the customer.
const FOR_PEOPLE = new Set([
  "ReconnectRequiredError",
  "QboTemporarilyUnavailableError",
  "SyncBusyError",
  "SyncAlreadyRunningError",
  "SummaryOutOfTimeError",
  "SummaryRemovedError",
  "CheckoutBlockedError",
]);

/**
 * Whether a plain Error's message reads like a sentence written for a
 * person, the way the app's own messages are ("Couldn't read your QuickBooks
 * chart of accounts, so nothing was changed. The next sync will try
 * again."): it starts with a capital letter and ends with a full stop or
 * question mark, and has no code in it (backticks, an UPPER_CASE setting
 * name, an error code such as ENOTFOUND, "status 500"). Messages from
 * Node.js, libraries and the network don't look like that ("getaddrinfo
 * ENOTFOUND", "Unsupported state or unable to authenticate data",
 * "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.").
 */
function readsLikeASentence(message: string): boolean {
  return (
    /^[A-Z][a-z']/.test(message) &&
    /[.?]$/.test(message) &&
    !/[`{}<>\\]|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\bE[A-Z]{3,}\b|\bstatus \d{3}\b/.test(message)
  );
}

/**
 * The text to show the person when a route fails: the error's own message
 * when it's one written for people, otherwise the route's plain fallback. A
 * message is passed on only when it's short, nothing in it would be scrubbed
 * from an error report, and it comes from one of the app's own customer
 * errors or reads like a sentence written for a person. So no setting name,
 * internal detail, value or token reaches the browser.
 */
export function publicErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error) || !err.message || err.message.length > 300) return fallback;
  if (scrubText(err.message) !== err.message) return fallback;
  if (FOR_PEOPLE.has(err.name)) return err.message;
  return err.name === "Error" && readsLikeASentence(err.message) ? err.message : fallback;
}
