import { randomBytes } from "node:crypto";
import type { AuthRepo } from "./repo.js";

/** Cookie name for dashboard session. */
export const SESSION_COOKIE = "tokenops_session";

/** Default session TTL: 30 days. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionRecord = {
  id: string;
  userId: string;
  expiresAt: Date;
};

/**
 * Create a new opaque session for the user.
 * Session id is a high-entropy random string stored as the cookie value.
 */
export async function createSession(
  repo: AuthRepo,
  userId: string,
  ttlMs: number = SESSION_TTL_MS,
): Promise<SessionRecord> {
  const id = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs);
  await repo.insertSession(id, userId, expiresAt);
  return { id, userId, expiresAt };
}

/**
 * Load a session by token. Returns null if missing or expired.
 * Expired sessions are deleted opportunistically.
 */
export async function getSession(
  repo: AuthRepo,
  token: string,
): Promise<SessionRecord | null> {
  if (!token) {
    return null;
  }
  const row = await repo.getSession(token);
  if (!row) {
    return null;
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    await repo.deleteSession(token);
    return null;
  }
  return { id: token, userId: row.userId, expiresAt: row.expiresAt };
}

/** Delete a session (logout). */
export async function deleteSession(
  repo: AuthRepo,
  token: string,
): Promise<void> {
  await repo.deleteSession(token);
}
