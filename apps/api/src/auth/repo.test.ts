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

    await repo.linkClerkId(legacy.id, "user_clerk_legacy");
    expect(await repo.getUnlinkedUserByEmail("legacy@example.com")).toBeNull();
  });

  it("relinking a user to a new clerk id retires the old lookup key", async () => {
    const repo = createMemoryAuthRepo();
    const user = await repo.insertClerkUser("relink@example.com", null);

    await repo.linkClerkId(user.id, "user_clerk_a");
    expect((await repo.getUserByClerkId("user_clerk_a"))?.id).toBe(user.id);

    await repo.linkClerkId(user.id, "user_clerk_b");
    expect(await repo.getUserByClerkId("user_clerk_a")).toBeNull();
    expect((await repo.getUserByClerkId("user_clerk_b"))?.id).toBe(user.id);
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
    const created = await repo.insertUser("Mixed@Example.com", "some-hash");
    expect(created.email).toBe("mixed@example.com");

    const found = await repo.getUserByEmail("MIXED@EXAMPLE.COM");
    expect(found?.id).toBe(created.id);
  });
});
