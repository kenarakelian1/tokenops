import { describe, expect, it } from "vitest";
import { createFakeVerifier } from "./clerk.js";

describe("createFakeVerifier", () => {
  const verifier = createFakeVerifier({
    "token-alice": { clerkUserId: "user_alice", email: "alice@example.com" },
  });

  it("resolves a known token to its clerk user id", async () => {
    expect(await verifier.verifyToken("token-alice")).toEqual({
      clerkUserId: "user_alice",
    });
  });

  it("returns null for an unknown token", async () => {
    expect(await verifier.verifyToken("token-nope")).toBeNull();
  });

  it("returns the email for a known clerk user id", async () => {
    expect(await verifier.fetchEmail("user_alice")).toBe("alice@example.com");
  });

  it("throws when asked for an unknown user's email", async () => {
    await expect(verifier.fetchEmail("user_nope")).rejects.toThrow();
  });

  it("lowercases a mixed-case fixture email, matching the real verifier", async () => {
    const mixedCaseVerifier = createFakeVerifier({
      "token-bob": { clerkUserId: "user_bob", email: "Bob@Example.COM" },
    });
    expect(await mixedCaseVerifier.fetchEmail("user_bob")).toBe(
      "bob@example.com",
    );
  });
});
