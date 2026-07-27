import { createHash, randomBytes } from "node:crypto";
import type { AuthRepo } from "./repo.js";

/**
 * Generate a personal access token with `tok_` prefix.
 * The raw token is shown once; only the SHA-256 hash is stored.
 */
export function generatePatToken(): string {
  return `tok_${randomBytes(32).toString("base64url")}`;
}

/** SHA-256 hex digest of a token (64 chars). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Create a PAT for a user. Returns the raw token (show once) and id.
 */
export async function createPat(
  repo: AuthRepo,
  userId: string,
  name: string,
): Promise<{ token: string; id: string }> {
  const token = generatePatToken();
  const tokenHash = hashToken(token);
  const { id } = await repo.insertPat(userId, name, tokenHash);
  return { token, id };
}

/**
 * Verify a raw PAT. Returns userId if valid and not revoked, else null.
 */
export async function verifyPat(
  repo: AuthRepo,
  token: string,
): Promise<string | null> {
  if (!token.startsWith("tok_")) {
    return null;
  }
  const tokenHash = hashToken(token);
  const row = await repo.getPatByTokenHash(tokenHash);
  if (!row || row.revokedAt != null) {
    return null;
  }
  return row.userId;
}
