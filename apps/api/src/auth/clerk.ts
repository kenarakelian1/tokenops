import { createClerkClient, verifyToken } from "@clerk/backend";

export type ClerkIdentity = { clerkUserId: string };

export type ClerkVerifier = {
  /**
   * Verify a Clerk session JWT. Networkless when `jwtKey` is configured;
   * otherwise Clerk fetches and caches the JWKS. Either way this must not
   * call Clerk on every request.
   */
  verifyToken(token: string): Promise<ClerkIdentity | null>;
  /**
   * Look up a user's primary email. Clerk's default session token carries no
   * email claim, so this is a Backend API call — only ever made when a local
   * user row is being created or adopted, never on a cache hit.
   */
  fetchEmail(clerkUserId: string): Promise<string>;
};

export function createClerkVerifier(opts: {
  secretKey: string;
  jwtKey?: string;
}): ClerkVerifier {
  const client = createClerkClient({ secretKey: opts.secretKey });

  return {
    async verifyToken(token) {
      try {
        const payload = await verifyToken(token, {
          secretKey: opts.secretKey,
          jwtKey: opts.jwtKey,
        });
        return payload.sub ? { clerkUserId: payload.sub } : null;
      } catch {
        // Invalid signature, expired, malformed: all are simply "not authed".
        return null;
      }
    },

    async fetchEmail(clerkUserId) {
      const user = await client.users.getUser(clerkUserId);
      const primary = user.emailAddresses.find(
        (e) => e.id === user.primaryEmailAddressId,
      );
      const email = primary?.emailAddress ?? user.emailAddresses[0]?.emailAddress;
      if (!email) {
        throw new Error(`Clerk user ${clerkUserId} has no email address`);
      }
      return email.toLowerCase();
    },
  };
}

/** In-memory verifier for tests. Keeps the suite offline. */
export function createFakeVerifier(
  users: Record<string, { clerkUserId: string; email: string }>,
): ClerkVerifier {
  const byClerkId = new Map(
    Object.values(users).map((u) => [u.clerkUserId, u.email]),
  );
  return {
    async verifyToken(token) {
      const hit = users[token];
      return hit ? { clerkUserId: hit.clerkUserId } : null;
    },
    async fetchEmail(clerkUserId) {
      const email = byClerkId.get(clerkUserId);
      if (!email) throw new Error(`no fake user ${clerkUserId}`);
      // Must normalize exactly as createClerkVerifier does. Otherwise a
      // mixed-case fixture email would pass a test here while the same
      // input fails against production, where emails are canonically
      // lowercase (see repo.ts) — masking exactly the bug this double
      // exists to catch.
      return email.toLowerCase();
    },
  };
}
