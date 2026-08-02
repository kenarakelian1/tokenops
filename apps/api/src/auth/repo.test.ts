import { describe, expect, it } from "vitest";
import { createMemoryAuthRepo } from "./repo.js";

describe("AuthRepo Clerk lookups", () => {
  it("finds a user by clerk id", async () => {
    const repo = createMemoryAuthRepo();
    const created = await repo.insertClerkUser("a@example.com", "user_clerk_a");

    const found = await repo.getUserByClerkId("user_clerk_a");
    expect(found?.id).toBe(created.id);
    expect(found?.email).toBe("a@example.com");
  });

  it("returns null for an unknown clerk id", async () => {
    const repo = createMemoryAuthRepo();
    expect(await repo.getUserByClerkId("user_nobody")).toBeNull();
  });

  it("finds only unlinked users by email", async () => {
    const repo = createMemoryAuthRepo();
    const legacy = await repo.insertClerkUser("legacy@example.com", null);

    expect((await repo.getUnlinkedUserByEmail("legacy@example.com"))?.id).toBe(
      legacy.id,
    );

    expect(await repo.linkClerkId(legacy.id, "user_clerk_legacy")).toBe(true);
    expect(await repo.getUnlinkedUserByEmail("legacy@example.com")).toBeNull();
  });

  it("links a still-unlinked row and reports success", async () => {
    const repo = createMemoryAuthRepo();
    const user = await repo.insertClerkUser("relink@example.com", null);

    expect(await repo.linkClerkId(user.id, "user_clerk_a")).toBe(true);
    expect((await repo.getUserByClerkId("user_clerk_a"))?.id).toBe(user.id);
  });

  it("refuses to relink an already-linked row and reports no-op (adopt-at-most-once)", async () => {
    // A row's clerk_user_id is immutable via linkClerkId once set. Without
    // this guard, a second (losing) writer in a race could silently
    // overwrite the first — last-write-wins account takeover. See
    // resolveUserId in provision.ts, whose only caller-visible contract
    // depends on this.
    const repo = createMemoryAuthRepo();
    const user = await repo.insertClerkUser("relink@example.com", null);

    expect(await repo.linkClerkId(user.id, "user_clerk_a")).toBe(true);
    expect(await repo.linkClerkId(user.id, "user_clerk_b")).toBe(false);

    expect((await repo.getUserByClerkId("user_clerk_a"))?.id).toBe(user.id);
    expect(await repo.getUserByClerkId("user_clerk_b")).toBeNull();
  });

  it("rejects linking a clerk id already claimed by another user", async () => {
    const repo = createMemoryAuthRepo();
    const a = await repo.insertClerkUser("a2@example.com", "user_clerk_shared");
    const b = await repo.insertClerkUser("b2@example.com", null);

    await expect(repo.linkClerkId(b.id, "user_clerk_shared")).rejects.toThrow();
    expect((await repo.getUserByClerkId("user_clerk_shared"))?.id).toBe(a.id);
  });

  it("rejects inserting a clerk user whose clerk id is already in use", async () => {
    const repo = createMemoryAuthRepo();
    await repo.insertClerkUser("first@example.com", "user_clerk_dup");

    await expect(
      repo.insertClerkUser("second@example.com", "user_clerk_dup"),
    ).rejects.toThrow();
  });

  it("normalizes email case: mixed-case lookup finds a lowercase-stored row", async () => {
    const repo = createMemoryAuthRepo();
    const created = await repo.insertClerkUser("Mixed@Example.com", null);
    expect(created.email).toBe("mixed@example.com");

    const found = await repo.getUserByEmail("MIXED@EXAMPLE.COM");
    expect(found?.id).toBe(created.id);
  });
});
