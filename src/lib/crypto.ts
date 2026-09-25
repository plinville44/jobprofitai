import crypto from "crypto";

// QuickBooks OAuth tokens are the single most sensitive thing this app stores -
// they grant read access to a customer's real financial data. We encrypt them
// at the application layer before they ever touch the database, so a DB dump
// or backup leak alone isn't enough to use them.
//
// Requires a 32-byte key in TOKEN_ENCRYPTION_KEY (base64). Generate with:
//   openssl rand -base64 32

const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  const b64 = process.env.TOKEN_ENCRYPTION_KEY;
  if (!b64) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32`."
    );
  }
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  return key;
}

export function encryptToken(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store iv + authTag + ciphertext together, base64-encoded, so it's one string column.
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptToken(stored: string): string {
  const raw = Buffer.from(stored, "base64");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);

  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

// Deterministic hash of a QuickBooks realm (company) ID, used only as a
// lookup key: the realm ID itself is stored encrypted (random IV, so not
// searchable), and this is what "is this company already connected" looks
// up.
//
// Keyed (HMAC-SHA256 with the token encryption key) rather than a plain
// SHA-256. Realm IDs are numbers from a fairly small range, so a plain hash
// of one could be reversed by trying them all; without the server key it
// can't. The "h2:" prefix keeps these apart from the older plain hashes,
// which legacyHashRealmId still computes so existing rows can be found and
// upgraded on their next connect (see /api/quickbooks/callback).
export function hashRealmId(realmId: string): string {
  return "h2:" + crypto.createHmac("sha256", getKey()).update(`realm:${realmId}`).digest("hex");
}

export function legacyHashRealmId(realmId: string): string {
  return crypto.createHash("sha256").update(realmId).digest("hex");
}
