import type { MiddlewareHandler } from "hono";
import type { ClerkVerifier } from "./clerk.js";
import { EmailConflictError, resolveUserId } from "./provision.js";
import type { AuthRepo } from "./repo.js";
import { verifyPat } from "./pat.js";

export type AuthVariables = {
  authRepo: AuthRepo;
  clerkVerifier: ClerkVerifier;
  userId: string;
};

type AuthEnv = { Variables: AuthVariables };

/**
 * Require a Clerk session JWT on `Authorization: Bearer`.
 *
 * PATs share this header, so `tok_`-prefixed values are rejected outright
 * rather than handed to Clerk — an agent credential must never authenticate
 * a dashboard route.
 */
export const requireUser: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const token = header.slice("Bearer ".length).trim();
  if (token.startsWith("tok_")) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const verifier = c.get("clerkVerifier");
  const identity = await verifier.verifyToken(token);
  if (!identity) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let userId: string;
  try {
    userId = await resolveUserId(
      c.get("authRepo"),
      verifier,
      identity.clerkUserId,
    );
  } catch (err) {
    // A verified Clerk identity that fails to provision is a real outage
    // (or a genuine account conflict), never a login problem — silently
    // downgrading to 401 would hide both behind "unauthenticated".
    if (err instanceof EmailConflictError) {
      return c.json({ error: "email_conflict" }, 409);
    }
    console.error(
      `Provisioning failed for Clerk user ${identity.clerkUserId}:`,
      err,
    );
    throw err;
  }

  c.set("userId", userId);
  await next();
};

/**
 * Require `Authorization: Bearer tok_...` personal access token.
 * Sets `userId` on context.
 */
export const requirePat: MiddlewareHandler<AuthEnv> = async (c, next) => {
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
