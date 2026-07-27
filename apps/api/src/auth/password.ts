import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

/** scrypt key length in bytes */
const KEYLEN = 64;
/** salt length in bytes */
const SALTLEN = 16;

/**
 * Hash a password with scrypt.
 * Stored format: `scrypt$<salt_b64>$<hash_b64>`
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALTLEN);
  const derived = (await scryptAsync(password, salt, KEYLEN)) as Buffer;
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/**
 * Verify a password against a stored scrypt hash.
 * Uses timing-safe comparison.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }
  const salt = Buffer.from(parts[1], "base64");
  const expected = Buffer.from(parts[2], "base64");
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }
  const derived = (await scryptAsync(password, salt, expected.length)) as Buffer;
  if (derived.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(derived, expected);
}
