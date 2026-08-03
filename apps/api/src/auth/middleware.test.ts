import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createFakeVerifier } from "./clerk.js";
import { createMemoryAuthRepo } from "./repo.js";
import { requireUser } from "./middleware.js";

function appWith(repo = createMemoryAuthRepo()) {
  const verifier = createFakeVerifier({
    "token-alice": { clerkUserId: "user_alice", email: "alice@example.com" },
  });
  const app = new Hono<any>();
  app.use("*", async (c, next) => {
    c.set("authRepo", repo);
    c.set("clerkVerifier", verifier);
    await next();
  });
  app.get("/who", requireUser, (c) => c.json({ userId: c.get("userId") }));
  return app;
}

describe("requireUser", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await appWith().request("/who");
    expect(res.status).toBe(401);
  });

  it("rejects an invalid token", async () => {
    const res = await appWith().request("/who", {
      headers: { Authorization: "Bearer token-bogus" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a PAT on a dashboard route", async () => {
    const res = await appWith().request("/who", {
      headers: { Authorization: "Bearer tok_looks_like_a_pat" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts a Clerk token and sets userId", async () => {
    const repo = createMemoryAuthRepo();
    const res = await appWith(repo).request("/who", {
      headers: { Authorization: "Bearer token-alice" },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { userId: string };
    expect((await repo.getUserByClerkId("user_alice"))?.id).toBe(body.userId);
  });

  it("fails loudly when provisioning breaks rather than falling through", async () => {
    // A valid token whose row cannot be created must not become an
    // unauthenticated request: that would silently downgrade auth.
    const repo = createMemoryAuthRepo();
    repo.insertClerkUser = async () => {
      throw new Error("database down");
    };

    const res = await appWith(repo).request("/who", {
      headers: { Authorization: "Bearer token-alice" },
    });
    expect(res.status).toBe(500);
    expect(res.status).not.toBe(401);
  });

  it("returns 409 email_conflict when the identity's email is already linked elsewhere", async () => {
    // alice@example.com is already claimed by a different, already-linked
    // Clerk identity. Provisioning user_alice must not adopt or duplicate
    // that row — it must refuse loudly (see EmailConflictError).
    const repo = createMemoryAuthRepo();
    await repo.insertClerkUser("alice@example.com", "user_someone_else");

    const res = await appWith(repo).request("/who", {
      headers: { Authorization: "Bearer token-alice" },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "email_conflict" });
  });
});
