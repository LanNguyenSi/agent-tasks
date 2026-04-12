/**
 * AES-256-GCM encryption for SSO client secrets at rest.
 *
 * Format: base64(iv[12] || ciphertext || tag[16])
 * Key: 32 raw bytes, provided via SSO_ENCRYPTION_KEY as hex (64 chars)
 *      or base64 (44 chars with padding). Empty key disables encryption and
 *      the service will throw — callers must ensure the key is configured
 *      before writing SsoConnection rows.
 */

import { webcrypto } from "node:crypto";

const IV_LENGTH = 12;

function decodeKey(raw: string): Uint8Array {
  if (!raw) {
    throw new Error("SSO_ENCRYPTION_KEY is not configured");
  }
  let bytes: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    bytes = Buffer.from(raw, "hex");
  } else {
    bytes = Buffer.from(raw, "base64");
  }
  if (bytes.length !== 32) {
    throw new Error("SSO_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return new Uint8Array(bytes);
}

async function importKey(raw: string): Promise<CryptoKey> {
  return webcrypto.subtle.importKey(
    "raw",
    decodeKey(raw),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSecret(plaintext: string, rawKey: string): Promise<string> {
  const key = await importKey(rawKey);
  const iv = webcrypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ct = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return Buffer.from(out).toString("base64");
}

export async function decryptSecret(encoded: string, rawKey: string): Promise<string> {
  const key = await importKey(rawKey);
  const buf = Buffer.from(encoded, "base64");
  if (buf.length <= IV_LENGTH) {
    throw new Error("Invalid encrypted secret payload");
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const ct = buf.subarray(IV_LENGTH);
  const pt = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ct,
  );
  return new TextDecoder().decode(pt);
}
