import { randomBytes, scrypt as scryptCallback, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, hexHash] = storedHash.split(":");
  if (!salt || !hexHash) return false;

  const stored = Buffer.from(hexHash, "hex");
  const derived = (await scrypt(password, salt, stored.length)) as Buffer;

  if (stored.length !== derived.length) {
    return false;
  }

  return timingSafeEqual(stored, derived);
}

// A fixed, well-formed hash used solely to equalize the timing of the login
// endpoint's "no such user / no password set" branch with its "wrong password"
// branch. Without it, a missing account returns 401 *before* paying the
// ~50-200ms scrypt cost a real account pays, turning response time into a
// user-enumeration oracle. The format (32-hex-char salt : 128-hex-char digest)
// matches a real hash so verifyPassword runs the full scrypt + timing-safe
// compare rather than its malformed-input early return. Computed once at module
// load (synchronously — this runs at import, never per request).
export const DUMMY_PASSWORD_HASH = `${"a".repeat(32)}:${scryptSync(
  "agent-tasks/login-timing-equalizer",
  "a".repeat(32),
  KEY_LENGTH,
).toString("hex")}`;

// Pay scrypt's cost without revealing whether a user exists. Call on the
// no-user login path before returning 401 so timing matches verifyPassword().
// The result is intentionally discarded — it never matches a real password.
export async function fakeVerifyPassword(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_PASSWORD_HASH);
}
