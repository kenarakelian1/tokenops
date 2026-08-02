import { describe, expect, it } from "vitest";
import { createFakeVerifier, type ClerkVerifier } from "./clerk.js";
import { createMemoryAuthRepo } from "./repo.js";
import type { AuthRepo } from "./repo.js";
import { EmailConflictError, resolveUserId } from "./provision.js";

const verifier = createFakeVerifier({
  "token-alice": { clerkUserId: "user_alice", email: "alice@example.com" },
  "token-legacy": { clerkUserId: "user_legacy", email: "owner@example.com" },
});

describe("resolveUserId", () => {
  it("creates a row for an unseen clerk identity", async () => {
    const repo = createMemoryAuthRepo();
    const id = await resolveUserId(repo, verifier, "user_alice");

    const row = await repo.getUserByClerkId("user_alice");
    expect(row?.id).toBe(id);
    expect(row?.email).toBe("alice@example.com");
  });

  it("reuses the row on later requests instead of duplicating", async () => {
    const repo = createMemoryAuthRepo();
    const first = await resolveUserId(repo, verifier, "user_alice");
    const second = await resolveUserId(repo, verifier, "user_alice");
    expect(second).toBe(first);
  });

  it("adopts a pre-Clerk row with the same email, preserving its id", async () => {
    const repo = createMemoryAuthRepo();
    const legacy = await repo.insertClerkUser("owner@example.com", null);

    const id = await resolveUserId(repo, verifier, "user_legacy");

    // Same id means PATs, machines, events and aggregates still resolve.
    expect(id).toBe(legacy.id);
    expect((await repo.getUserByClerkId("user_legacy"))?.id).toBe(legacy.id);
  });

  it("does not steal a row already linked to a different clerk identity", async () => {
    const repo = createMemoryAuthRepo();
    const taken = await repo.insertClerkUser("owner@example.com", "user_someone_else");

    // `email` is unique on `users`, so the only two outcomes here are
    // "adopt the taken row" (account takeover — forbidden) or "reject the
    // request". A silent third row sharing that email cannot exist against
    // the real schema, so we assert the safe failure instead.
    //
    // Assert the specific type, not just "something threw": deleting the
    // guard in provision.ts leaves `insertClerkUser` throwing a bare
    // `Error("email already exists")` from the repo, which would still
    // satisfy `.rejects.toThrow()` — this test must fail if the guard goes
    // away, so it pins the guard's own typed error.
    await expect(resolveUserId(repo, verifier, "user_legacy")).rejects.toBeInstanceOf(
      EmailConflictError,
    );

    // The pre-existing row must be completely untouched by the attempt.
    const stillTaken = await repo.getUserByClerkId("user_someone_else");
    expect(stillTaken?.id).toBe(taken.id);
    expect(stillTaken?.email).toBe("owner@example.com");
  });

  it("resolves a lost create race to the winner's row instead of throwing", async () => {
    // Two concurrent first-time requests for the same brand-new Clerk
    // identity (e.g. a dashboard's first load firing several authenticated
    // requests in parallel) both pass getUserByClerkId -> null and
    // getUserByEmail -> null before either writes. Only one insert can
    // succeed (clerk_user_id and email are both unique); the loser must
    // resolve to the winner's row, not surface a raw unique-violation.
    const repo = createMemoryAuthRepo();
    let insertAttempts = 0;
    const racyRepo: AuthRepo = {
      ...repo,
      async insertClerkUser(email, clerkUserId) {
        insertAttempts += 1;
        if (insertAttempts === 1) {
          // A concurrent request "wins" first, committing the row this
          // call is also trying to create.
          await repo.insertClerkUser(email, clerkUserId);
          throw new Error(
            'duplicate key value violates unique constraint "users_clerk_user_id_key"',
          );
        }
        return repo.insertClerkUser(email, clerkUserId);
      },
    };

    const id = await resolveUserId(racyRepo, verifier, "user_alice");

    const winner = await repo.getUserByClerkId("user_alice");
    expect(winner).not.toBeNull();
    expect(id).toBe(winner?.id);
    expect(insertAttempts).toBe(1); // no blind retry-insert; resolved via lookup
  });

  it("resolves a lost adopt race (same identity) to the winner's row", async () => {
    // Two concurrent requests for the same identity both see the legacy
    // row as unlinked and both attempt to adopt it. linkClerkId only
    // succeeds while clerk_user_id is still NULL, so the loser gets
    // `false` — but since the *same* clerkUserId won, resolving via
    // getUserByClerkId must return that same row, not a new one.
    const repo = createMemoryAuthRepo();
    const legacy = await repo.insertClerkUser("owner@example.com", null);

    let linkAttempts = 0;
    const racyRepo: AuthRepo = {
      ...repo,
      async linkClerkId(userId, clerkUserId) {
        linkAttempts += 1;
        if (linkAttempts === 1) {
          // A concurrent request for this same identity wins the link first.
          await repo.linkClerkId(userId, clerkUserId);
          return false;
        }
        return repo.linkClerkId(userId, clerkUserId);
      },
    };

    const id = await resolveUserId(racyRepo, verifier, "user_legacy");

    expect(id).toBe(legacy.id);
    expect((await repo.getUserByClerkId("user_legacy"))?.id).toBe(legacy.id);
  });

  it("throws a conflict rather than an id when a different identity wins the adopt race", async () => {
    // The dangerous case Finding 4 describes: a different Clerk identity
    // claims the row microseconds before this one's linkClerkId call would
    // have. getUserByClerkId("user_legacy") comes back empty (this
    // identity never won anything), so resolveUserId must not hand back
    // the now-stolen row's id — it must refuse.
    const repo = createMemoryAuthRepo();
    const legacy = await repo.insertClerkUser("owner@example.com", null);

    const racyRepo: AuthRepo = {
      ...repo,
      async linkClerkId(userId) {
        await repo.linkClerkId(userId, "user_attacker");
        return false;
      },
    };

    await expect(
      resolveUserId(racyRepo, verifier, "user_legacy"),
    ).rejects.toBeInstanceOf(EmailConflictError);

    // The row now belongs to whoever actually won the race, and only to them.
    expect((await repo.getUserByClerkId("user_attacker"))?.id).toBe(legacy.id);
    expect(await repo.getUserByClerkId("user_legacy")).toBeNull();
  });

  it("makes zero Clerk calls on the hot path (already-linked identity)", async () => {
    const repo = createMemoryAuthRepo();
    let fetchEmailCalls = 0;
    const countingVerifier: ClerkVerifier = {
      verifyToken: (token) => verifier.verifyToken(token),
      async fetchEmail(clerkUserId) {
        fetchEmailCalls += 1;
        return verifier.fetchEmail(clerkUserId);
      },
    };

    const first = await resolveUserId(repo, countingVerifier, "user_alice");
    expect(fetchEmailCalls).toBe(1); // provisioning the new row required one lookup

    const second = await resolveUserId(repo, countingVerifier, "user_alice");
    expect(second).toBe(first);
    expect(fetchEmailCalls).toBe(1); // still 1: the hot path made no Clerk call
  });
});
