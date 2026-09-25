// Thin wrapper around Intuit's OAuth2 + Accounting API.
// Kept dependency-light and explicit (rather than fully hidden behind the
// `intuit-oauth` SDK's internals) so it's easy to reason about what's actually
// happening to a customer's tokens at each step.

const QBO_SCOPE = "com.intuit.quickbooks.accounting";
/** OpenID Connect scopes for Sign in with Intuit. */
export const OPENID_SCOPES = "openid profile email";
/** QuickBooks access plus the signed-in person's Intuit identity (App Store "Get integration now"). */
export const CONNECT_WITH_OPENID_SCOPES = `${QBO_SCOPE} ${OPENID_SCOPES}`;

function isSandbox() {
  return (process.env.QBO_ENVIRONMENT ?? "sandbox") === "sandbox";
}

function apiBaseUrl() {
  return isSandbox()
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";
}

/**
 * Thrown whenever QuickBooks tells us a token is no longer usable and the
 * only fix is the customer reconnecting (refresh token expired/revoked, or
 * an access token rejected outright). Its `.message` is written to be shown
 * directly to the customer, since callers just forward `err.message` into
 * the API response - see the App Assessment Questionnaire's Authorization
 * and Authentication questions about handling expired/invalid tokens.
 */
export const RECONNECT_REQUIRED_MESSAGE =
  "Your QuickBooks connection has expired or was disconnected on Intuit's side. Use Reconnect QuickBooks to restore it.";

export class ReconnectRequiredError extends Error {
  constructor(message = RECONNECT_REQUIRED_MESSAGE) {
    super(message);
    this.name = "ReconnectRequiredError";
  }
}

/**
 * Whether a stored sync error means the customer must reconnect. The error
 * text is what the sync writes to lastSyncError; the older wording is
 * matched too so connections that failed before this change are recognised.
 */
export function needsReconnect(lastSyncError: string | null | undefined): boolean {
  if (!lastSyncError) return false;
  return (
    lastSyncError === RECONNECT_REQUIRED_MESSAGE ||
    lastSyncError.startsWith("Your QuickBooks connection has expired or was disconnected")
  );
}

interface DiscoveryDocument {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  userinfo_endpoint: string;
}

// Hardcoded fallback only - used if the discovery document fetch itself
// fails, so a transient network hiccup against Intuit's own discovery
// endpoint doesn't take the whole OAuth flow down. Normal operation always
// prefers the live discovery document below.
const FALLBACK_ENDPOINTS: DiscoveryDocument = {
  authorization_endpoint: "https://appcenter.intuit.com/connect/oauth2",
  token_endpoint: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
  revocation_endpoint: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
  userinfo_endpoint: "https://accounts.platform.intuit.com/v1/openid_connect/userinfo",
};

const SANDBOX_USERINFO_FALLBACK = "https://sandbox-accounts.platform.intuit.com/v1/openid_connect/userinfo";

let discoveryCache: DiscoveryDocument | null = null;
let discoveryCacheAt = 0;
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1 hour - endpoints essentially never change, this just avoids re-fetching on every request

/**
 * Fetches Intuit's OAuth2 discovery document to get the current
 * authorization/token/revocation endpoints, rather than hardcoding them -
 * this is what the App Assessment Questionnaire asks about directly.
 * Cached in memory for an hour; falls back to the documented stable URLs
 * above if the discovery document itself can't be reached.
 */
async function getDiscoveryDocument(): Promise<DiscoveryDocument> {
  const now = Date.now();
  if (discoveryCache && now - discoveryCacheAt < DISCOVERY_TTL_MS) return discoveryCache;

  const url = isSandbox()
    ? "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration"
    : "https://developer.api.intuit.com/.well-known/openid_configuration";

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`discovery document fetch failed: ${res.status}`);
    const doc = await res.json();
    if (!doc.authorization_endpoint || !doc.token_endpoint) {
      throw new Error("discovery document missing expected fields");
    }
    discoveryCache = {
      authorization_endpoint: doc.authorization_endpoint,
      token_endpoint: doc.token_endpoint,
      revocation_endpoint: doc.revocation_endpoint ?? FALLBACK_ENDPOINTS.revocation_endpoint,
      userinfo_endpoint: doc.userinfo_endpoint ?? fallbackUserinfo(),
    };
    discoveryCacheAt = now;
    return discoveryCache;
  } catch {
    return { ...FALLBACK_ENDPOINTS, userinfo_endpoint: fallbackUserinfo() };
  }
}

function fallbackUserinfo(): string {
  return isSandbox() ? SANDBOX_USERINFO_FALLBACK : FALLBACK_ENDPOINTS.userinfo_endpoint;
}

/**
 * Step 1: build the URL that sends a contractor to Intuit's login/consent screen.
 * `state` should be a signed, single-use token you can verify on callback (CSRF protection) -
 * see /api/quickbooks/connect for how it's generated and /api/quickbooks/callback for verification.
 */
export async function buildAuthorizeUrl(state: string, scope: string = QBO_SCOPE): Promise<string> {
  const { authorization_endpoint } = await getDiscoveryDocument();
  const params = new URLSearchParams({
    client_id: process.env.QBO_CLIENT_ID ?? "",
    scope,
    redirect_uri: process.env.QBO_REDIRECT_URI ?? "",
    response_type: "code",
    state,
  });
  return `${authorization_endpoint}?${params.toString()}`;
}

export interface QboTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  x_refresh_token_expires_in: number; // seconds
  /** Present when OpenID scopes were requested. */
  id_token?: string;
}

export interface IntuitUserInfo {
  /** Intuit's permanent id for the person. The only thing accounts are matched on. */
  sub: string;
  email: string | null;
  emailVerified: boolean;
  givenName: string | null;
  familyName: string | null;
}

/**
 * The signed-in Intuit user's profile, from Intuit's userinfo endpoint.
 * Called server to server with the access token just issued, so the answer
 * comes directly from Intuit. Only the fields the app uses are kept.
 */
export async function fetchIntuitUserInfo(accessToken: string): Promise<IntuitUserInfo> {
  const { userinfo_endpoint } = await getDiscoveryDocument();
  const res = await fetch(userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Intuit userinfo failed with status ${res.status} (intuit_tid: ${intuitTid(res)})`);
  }
  const body = await res.json();
  if (typeof body?.sub !== "string" || body.sub.length === 0) throw new Error("Intuit userinfo had no sub");
  return {
    sub: body.sub,
    email: typeof body.email === "string" ? body.email.trim().toLowerCase() : null,
    emailVerified: body.emailVerified === true,
    givenName: typeof body.givenName === "string" ? body.givenName : null,
    familyName: typeof body.familyName === "string" ? body.familyName : null,
  };
}

function basicAuthHeader(): string {
  const creds = `${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(creds).toString("base64")}`;
}

/**
 * Intuit's own guidance: capture the `intuit_tid` response header on every
 * call and include it with any error report, so their support team can look
 * up the exact request server-side. It's just a request-tracing ID, not
 * sensitive - safe to include in logs/messages even under the
 * never-log-credentials-or-QuickBooks-data rule elsewhere in this file.
 */
function intuitTid(res: Response): string | null {
  return res.headers.get("intuit_tid");
}

/**
 * Reads the OAuth error code out of a failed token-endpoint response, for
 * control flow only. Deliberately returns just the parsed `error` field, not
 * the raw body - callers must never log or return the full body, since
 * Intuit's error responses can echo back parts of the request.
 */
async function readOAuthErrorCode(res: Response): Promise<string | undefined> {
  try {
    const body = await res.json();
    return typeof body?.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/** Step 2: exchange the one-time `code` from the callback for real tokens. */
export async function exchangeCodeForTokens(
  code: string
): Promise<QboTokenResponse> {
  const { token_endpoint } = await getDiscoveryDocument();
  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.QBO_REDIRECT_URI ?? "",
    }),
  });

  if (!res.ok) {
    // Status + intuit_tid only in the message - never the response body
    // (see readOAuthErrorCode's comment above).
    throw new Error(`QuickBooks token exchange failed with status ${res.status} (intuit_tid: ${intuitTid(res)})`);
  }
  return res.json();
}

/**
 * Access tokens expire after ~1 hour - call this before any API request once
 * expired (see getValidAccessToken in src/lib/quickbooksSync.ts, which
 * refreshes proactively ~5 minutes before expiry rather than waiting for a
 * request to actually fail).
 *
 * If the refresh token itself has expired or been revoked, Intuit returns
 * `invalid_grant` - the customer has to reconnect, no retry will fix it, so
 * this throws ReconnectRequiredError instead of a generic error in that
 * specific case.
 */
export async function refreshTokens(refreshToken: string): Promise<QboTokenResponse> {
  const { token_endpoint } = await getDiscoveryDocument();
  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const errorCode = await readOAuthErrorCode(res);
    if (errorCode === "invalid_grant") {
      throw new ReconnectRequiredError();
    }
    throw new Error(`QuickBooks token refresh failed with status ${res.status} (intuit_tid: ${intuitTid(res)})`);
  }
  return res.json();
}

/** Generic authenticated GET against the QBO Accounting API (e.g. a SQL-like "query" endpoint call). */
export async function qboQuery(
  realmId: string,
  accessToken: string,
  query: string
): Promise<any> {
  const url = `${apiBaseUrl()}/v3/company/${realmId}/query?query=${encodeURIComponent(
    query
  )}&minorversion=70`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    // A 401 here means Intuit rejected the access token outright (e.g. the
    // customer revoked access from within QuickBooks since our last
    // refresh) - proactive expiry-based refresh won't catch that, so treat
    // it the same as an expired refresh token: the customer needs to
    // reconnect, not retry.
    if (res.status === 401) {
      throw new ReconnectRequiredError();
    }
    throw new Error(`QuickBooks API query failed with status ${res.status} (intuit_tid: ${intuitTid(res)})`);
  }
  return res.json();
}

/** QuickBooks' own cap on rows per query response. */
const QBO_PAGE_SIZE = 1000;
/** Safety stop: 200 pages is 200,000 rows of one entity, far past any contractor's books. */
const QBO_MAX_PAGES = 200;

/**
 * Runs a query and follows every page, returning all rows for `entity`.
 *
 * QuickBooks returns at most 1,000 rows per query, and the full sync used to
 * ask once with MAXRESULTS 1000 and stop. Nothing failed: a company with
 * more than 1,000 customers (which includes every non-job customer, so a
 * residential contractor gets there in a few years) or 1,000 bills simply
 * had the rest left out, silently, while the pricing page said "Unlimited
 * active jobs".
 *
 * `baseQuery` must not contain STARTPOSITION or MAXRESULTS. Rows are
 * de-duplicated by Id in case a page boundary shifts while we read.
 */
export async function qboQueryAll(
  realmId: string,
  accessToken: string,
  baseQuery: string,
  entity: string
): Promise<any[]> {
  const byId = new Map<string, any>();
  const withoutId: any[] = [];
  for (let page = 0; page < QBO_MAX_PAGES; page++) {
    const start = page * QBO_PAGE_SIZE + 1;
    const result = await qboQuery(
      realmId,
      accessToken,
      `${baseQuery} STARTPOSITION ${start} MAXRESULTS ${QBO_PAGE_SIZE}`
    );
    const rows: any[] = result?.QueryResponse?.[entity] ?? [];
    for (const row of rows) {
      if (row?.Id != null) byId.set(String(row.Id), row);
      else withoutId.push(row);
    }
    if (rows.length < QBO_PAGE_SIZE) return [...byId.values(), ...withoutId];
  }
  // Reaching here means more rows than the safety stop allows. Failing
  // loudly beats quietly syncing a partial company.
  throw new Error(
    `QuickBooks returned more than ${QBO_MAX_PAGES * QBO_PAGE_SIZE} ${entity} records. Contact support@jobprofitai.com.`
  );
}

/** Shared authenticated GET against an arbitrary Accounting API path (company-scoped). */
async function qboGet(realmId: string, accessToken: string, pathAndQuery: string): Promise<any> {
  const url = `${apiBaseUrl()}/v3/company/${realmId}/${pathAndQuery}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    if (res.status === 401) {
      throw new ReconnectRequiredError();
    }
    throw new Error(`QuickBooks API request failed with status ${res.status} (intuit_tid: ${intuitTid(res)})`);
  }
  return res.json();
}

/**
 * QuickBooks' own Profit and Loss for one customer or project, accrual
 * basis, from `startDate` to `endDate` (YYYY-MM-DD). Standard Reports API,
 * no extra scope. Used by "Check against QuickBooks" on the job page.
 */
export async function qboProfitAndLossForCustomer(
  realmId: string,
  accessToken: string,
  customerId: string,
  startDate: string,
  endDate: string
): Promise<any> {
  const params = new URLSearchParams({
    customer: customerId,
    accounting_method: "Accrual",
    start_date: startDate,
    end_date: endDate,
    minorversion: "70",
  });
  return qboGet(realmId, accessToken, `reports/ProfitAndLoss?${params.toString()}`);
}

/** Fetches the connected company's display name and basic info (standard Accounting API, no extra scope needed). */
export async function qboCompanyInfo(realmId: string, accessToken: string): Promise<any> {
  return qboGet(realmId, accessToken, `companyinfo/${realmId}?minorversion=70`);
}

/**
 * Change Data Capture: returns only entities that changed since `changedSince`,
 * across all requested entity types in one call. Standard Accounting API
 * endpoint (not a premium/restricted one) - used for incremental sync so a
 * routine re-sync doesn't have to re-pull a customer's entire transaction
 * history every time. Falls back to a full query-based sync (see the sync
 * route) if this fails or if it's been too long since the last full sync.
 */
export async function qboCdc(
  realmId: string,
  accessToken: string,
  entities: string[],
  changedSince: Date
): Promise<any> {
  const params = new URLSearchParams({
    entities: entities.join(","),
    changedSince: changedSince.toISOString(),
    minorversion: "70",
  });
  return qboGet(realmId, accessToken, `cdc?${params.toString()}`);
}

/**
 * Step (disconnect): tell Intuit to invalidate this connection's tokens.
 * Revoking the refresh token invalidates its paired access token too, so one
 * call is enough. Intuit's own UI still lets the customer manage/revoke
 * access from their QuickBooks apps page regardless, but calling this
 * ourselves on disconnect is the documented best practice and is what the
 * App Assessment Questionnaire asks whether you do.
 */
export async function revokeToken(token: string): Promise<void> {
  const { revocation_endpoint } = await getDiscoveryDocument();
  const res = await fetch(revocation_endpoint, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ token }),
  });

  if (!res.ok) {
    // Not fatal to the disconnect flow - the token may already be expired/
    // revoked on Intuit's side (e.g. the customer disconnected from within
    // QuickBooks itself first). Log the status only, never the response
    // body - Intuit error responses can echo back parts of the request
    // (including the token itself), and logging that would violate the
    // "never log credentials or QuickBooks data" security requirement.
    console.error(`QuickBooks token revoke failed with status ${res.status} (intuit_tid: ${intuitTid(res)})`);
  }
}

/**
 * Detects whether this company tracks job cost via Projects or via Classes -
 * contractors set this up differently, and the Week 1 plan flags this as
 * something to confirm per-customer. We check for it once at first sync
 * rather than assuming.
 */
export async function detectCostTrackingMode(
  realmId: string,
  accessToken: string
): Promise<"projects" | "classes" | "unknown"> {
  const projects = await qboQuery(realmId, accessToken, "SELECT COUNT(*) FROM Customer WHERE Job = true");
  const projectCount = projects?.QueryResponse?.totalCount ?? 0;
  if (projectCount > 0) return "projects";

  const classes = await qboQuery(realmId, accessToken, "SELECT COUNT(*) FROM Class");
  const classCount = classes?.QueryResponse?.totalCount ?? 0;
  if (classCount > 0) return "classes";

  return "unknown";
}
