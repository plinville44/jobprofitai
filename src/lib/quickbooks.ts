// Thin wrapper around Intuit's OAuth2 + Accounting API.
// Kept dependency-light and explicit (rather than fully hidden behind the
// `intuit-oauth` SDK's internals) so it's easy to reason about what's actually
// happening to a customer's tokens at each step.

const QBO_SCOPE = "com.intuit.quickbooks.accounting";

function isSandbox() {
  return (process.env.QBO_ENVIRONMENT ?? "sandbox") === "sandbox";
}

function authBaseUrl() {
  return "https://appcenter.intuit.com/connect/oauth2";
}

function tokenUrl() {
  return "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
}

function apiBaseUrl() {
  return isSandbox()
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";
}

/**
 * Step 1: build the URL that sends a contractor to Intuit's login/consent screen.
 * `state` should be a signed, single-use token you can verify on callback (CSRF protection) -
 * see /api/quickbooks/connect for how it's generated and /api/quickbooks/callback for verification.
 */
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.QBO_CLIENT_ID ?? "",
    scope: QBO_SCOPE,
    redirect_uri: process.env.QBO_REDIRECT_URI ?? "",
    response_type: "code",
    state,
  });
  return `${authBaseUrl()}?${params.toString()}`;
}

export interface QboTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  x_refresh_token_expires_in: number; // seconds
}

function basicAuthHeader(): string {
  const creds = `${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(creds).toString("base64")}`;
}

/** Step 2: exchange the one-time `code` from the callback for real tokens. */
export async function exchangeCodeForTokens(
  code: string
): Promise<QboTokenResponse> {
  const res = await fetch(tokenUrl(), {
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
    throw new Error(`QuickBooks token exchange failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Access tokens expire after ~1 hour - call this before any API request once expired. */
export async function refreshTokens(refreshToken: string): Promise<QboTokenResponse> {
  const res = await fetch(tokenUrl(), {
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
    throw new Error(`QuickBooks token refresh failed: ${res.status} ${await res.text()}`);
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
    throw new Error(`QuickBooks API query failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
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
  const res = await fetch("https://developer.api.intuit.com/v2/oauth2/tokens/revoke", {
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
    // QuickBooks itself first). Log and continue so the local disconnect
    // still succeeds.
    console.error(`QuickBooks token revoke failed: ${res.status} ${await res.text()}`);
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
