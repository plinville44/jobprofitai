/**
 * Reads an API route's source and says, for each exported handler that
 * changes something (POST, PUT, PATCH, DELETE), whether it refuses a client's
 * view-only login right after getAccount().
 *
 * The first version of this check only looked for the text "refuseClient("
 * anywhere in the file, so a guard in a GET handler, in a comment, or after
 * the handler had already written to the database all passed. This one works
 * per handler and checks the order.
 *
 * A guard is either
 *   const refused = refuseClient(account); if (refused) return refused;
 * or an owner-only check, which refuses a client too:
 *   if (account.role !== "owner") return ...
 * and nothing may be awaited between getAccount() and the guard. A handler
 * that hands its work to a function in the same file (`return runSync(req)`)
 * is checked through that function.
 *
 * Not a TypeScript parser: it skips strings, template literals and comments
 * well enough for this codebase's routes, and reports any handler exported
 * in a shape it can't read, so a new shape fails loudly instead of passing.
 */

export const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

/** The source with every comment replaced by spaces (strings kept), same length. */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const stop = skipString(src, i);
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Index just past the string or template literal starting at `start`. */
function skipString(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (quote === "`" && c === "$" && src[i + 1] === "{") {
      // A ${...} expression: its braces balance, and it can hold strings.
      i = matchClose(src, i + 1, "{", "}") + 1;
      continue;
    }
    i++;
  }
  return src.length;
}

/** Index of the bracket closing the one at `open`, skipping strings. */
function matchClose(src: string, open: number, o: string, c: string): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(src, i);
      continue;
    }
    if (ch === o) depth++;
    else if (ch === c) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return src.length;
}

/** The body (between its braces) of the function whose parameter list opens at `paren`. */
function functionBody(src: string, paren: number): { body: string; start: number } | null {
  let i = matchClose(src, paren, "(", ")") + 1;
  // Skip a return type annotation, which may itself hold braces inside <...>.
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(src, i);
      continue;
    }
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if ((ch === ">" && src[i - 1] !== "=") || ch === ")" || ch === "]") depth--;
    else if (ch === "{") {
      if (depth <= 0) break;
      i = matchClose(src, i, "{", "}") + 1;
      continue;
    }
    i++;
  }
  if (i >= src.length) return null;
  const end = matchClose(src, i, "{", "}");
  return { body: src.slice(i + 1, end), start: i + 1 };
}

const ACCOUNT_CALL = /\b(getAccount|accountFor)\(/;

export interface HandlerFinding {
  method: string;
  problem: string;
}

/**
 * Problems with the route's changing handlers; empty when every one is
 * guarded (or doesn't use the account at all, like a sign-up or a webhook).
 */
export function unguardedHandlers(source: string): HandlerFinding[] {
  const src = stripComments(source);
  const findings: HandlerFinding[] = [];
  const methods = MUTATING_METHODS.join("|");

  // Shapes this check can't follow: say so rather than pass them.
  for (const m of src.matchAll(new RegExp(`export\\s+(?:const|let|var)\\s+(${methods})\\b`, "g"))) {
    findings.push({ method: m[1], problem: "exported as a variable; write it as `export async function` so it can be checked" });
  }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const name of MUTATING_METHODS) {
      if (new RegExp(`\\b${name}\\b`).test(m[1])) {
        findings.push({ method: name, problem: "re-exported; write it as `export async function` so it can be checked" });
      }
    }
  }

  // Same-file helpers that get the account. A handler that hands its work
  // to one (`return runSync(req)`) is checked through that helper's body.
  const helpers = new Map<string, string>();
  for (const m of src.matchAll(/\bfunction\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g)) {
    if (/^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/.test(m[1])) continue;
    const fn = functionBody(src, m.index! + m[0].length - 1);
    if (fn && ACCOUNT_CALL.test(fn.body)) helpers.set(m[1], fn.body);
  }

  for (const m of src.matchAll(new RegExp(`export\\s+(?:async\\s+)?function\\s+(${methods})\\s*\\(`, "g"))) {
    const method = m[1];
    const fn = functionBody(src, m.index! + m[0].length - 1);
    if (!fn) {
      findings.push({ method, problem: "couldn't read the handler's body" });
      continue;
    }
    let problem = guardProblem(fn.body);
    if (problem === NO_ACCOUNT) {
      const via = [...helpers.keys()].find((h) => new RegExp(`\\b${h}\\(`).test(fn.body));
      problem = via ? guardProblem(helpers.get(via)!) : null;
      if (problem === NO_ACCOUNT) {
        problem = `gets the account through ${via}() in a way this check can't follow; call getAccount() and refuseClient() in the handler`;
      } else if (problem) {
        problem = `through ${via}(): ${problem}`;
      }
    }
    if (problem) findings.push({ method, problem });
  }
  return findings;
}

const NO_ACCOUNT = "no account";

/**
 * Why a function body doesn't refuse a client right after getting the
 * account, NO_ACCOUNT when it never gets it, or null when it's guarded.
 */
function guardProblem(body: string): string | null {
  const call = /(?:const|let)\s+(\w+)\s*=\s*await\s+(?:getAccount|accountFor)\(/.exec(body);
  if (!call) {
    return ACCOUNT_CALL.test(body) ? "calls getAccount() without keeping the result, so nothing can be refused" : NO_ACCOUNT;
  }
  const acc = call[1];
  const after = body.slice(call.index + call[0].length);
  const refuse = new RegExp(
    `const\\s+(\\w+)\\s*=\\s*refuseClient\\(\\s*${acc}\\s*\\)\\s*;?\\s*if\\s*\\(\\s*\\1\\s*\\)\\s*return\\s+\\1\\b`
  ).exec(after);
  const ownerOnly = new RegExp(`if\\s*\\(\\s*${acc}\\.role\\s*!==\\s*["']owner["']\\s*\\)\\s*\\{?\\s*return\\b`).exec(after);
  const guard = [refuse, ownerOnly].filter((g): g is RegExpExecArray => g != null).sort((a, b) => a.index - b.index)[0];
  if (!guard) return "never refuses a client login after getAccount()";
  if (/\bawait\b/.test(after.slice(0, guard.index))) {
    return "awaits something before refusing a client login; refuse right after getAccount()";
  }
  return null;
}
