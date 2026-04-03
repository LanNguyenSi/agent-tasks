import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
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
