import type { Context, MiddlewareHandler, Next } from "hono";
import { getCookie } from "hono/cookie";
import type { AuthRepo } from "./repo.js";
import { getSession, SESSION_COOKIE } from "./session.js";
import { verifyPat } from "./pat.js";

export type AuthVariables = {
  authRepo: AuthRepo;
  userId: string;
};

type AuthEnv = { Variables: AuthVariables };

/**
 * Require a valid dashboard session cookie.
 * Sets `userId` on context.
 */
export const requireSession: MiddlewareHandler<AuthEnv> = async (
  c: Context<AuthEnv>,
  next: Next,
) => {
  const repo = c.get("authRepo");
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const session = await getSession(repo, token);
  if (!session) {
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("userId", session.userId);
  await next();
};

/**
 * Require `Authorization: Bearer tok_...` personal access token.
 * Sets `userId` on context.
 */
export const requirePat: MiddlewareHandler<AuthEnv> = async (
  c: Context<AuthEnv>,
  next: Next,
) => {
  const repo = c.get("authRepo");
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const token = header.slice("Bearer ".length).trim();
  const userId = await verifyPat(repo, token);
  if (!userId) {
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("userId", userId);
  await next();
};
