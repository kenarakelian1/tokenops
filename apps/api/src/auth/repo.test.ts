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
});
