import { describe, expect, it } from "vitest";
import { createFakeVerifier, type ClerkVerifier } from "./clerk.js";
import { createMemoryAuthRepo } from "./repo.js";
import { resolveUserId } from "./provision.js";

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
    await expect(resolveUserId(repo, verifier, "user_legacy")).rejects.toThrow();

    // The pre-existing row must be completely untouched by the attempt.
    const stillTaken = await repo.getUserByClerkId("user_someone_else");
    expect(stillTaken?.id).toBe(taken.id);
    expect(stillTaken?.email).toBe("owner@example.com");
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
