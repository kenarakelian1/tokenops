import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createApp } from "../app.js";
import { createFakeVerifier } from "./clerk.js";
import { requirePat } from "./middleware.js";
import { createPat, generatePatToken, hashToken, verifyPat } from "./pat.js";
import { createMemoryAuthRepo, type AuthRepo } from "./repo.js";
import { createMemoryEventsRepo } from "../services/events-repo.js";

describe("pat", () => {
  it("generates tok_ prefix", () => {
    const t = generatePatToken();
    expect(t.startsWith("tok_")).toBe(true);
    expect(hashToken(t)).toHaveLength(64);
  });

  it("hashToken is stable (sha256 hex)", () => {
    const token = "tok_fixed_for_hash_stability_test";
    const h1 = hashToken(token);
    const h2 = hashToken(token);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("createPat / verifyPat roundtrip via repo", async () => {
    const repo = createMemoryAuthRepo();
    const user = await repo.insertClerkUser("agent@example.com", "user_agent");
    const { token, id } = await createPat(repo, user.id, "ci");
    expect(id).toBeTruthy();
    expect(token.startsWith("tok_")).toBe(true);
    expect(await verifyPat(repo, token)).toBe(user.id);
    expect(await verifyPat(repo, "tok_nope")).toBeNull();
    expect(await verifyPat(repo, "not-a-pat")).toBeNull();
  });
});

describe("middleware", () => {
  type Vars = { authRepo: AuthRepo; userId: string };

  it("requirePat accepts Bearer tok_ and rejects bad tokens", async () => {
    const repo = createMemoryAuthRepo();
    const user = await repo.insertClerkUser("pat@example.com", "user_pat");
    const { token } = await createPat(repo, user.id, "agent");

    const app = new Hono<{ Variables: Vars }>();
    app.use("*", async (c, next) => {
      c.set("authRepo", repo);
      await next();
    });
    app.get("/protected", requirePat, (c) =>
      c.json({ userId: c.get("userId") }),
    );

    const ok = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ userId: user.id });

    const bad = await app.request("/protected", {
      headers: { Authorization: "Bearer tok_invalid" },
    });
    expect(bad.status).toBe(401);

    const missing = await app.request("/protected");
    expect(missing.status).toBe(401);
  });
});

describe("auth routes", () => {
  function appWithMemory() {
    const authRepo = createMemoryAuthRepo();
    const eventsRepo = createMemoryEventsRepo();
    const clerkVerifier = createFakeVerifier({
      "token-alice": { clerkUserId: "user_alice", email: "alice@example.com" },
    });
    const app = createApp({
      db: null as never,
      authRepo,
      eventsRepo,
      clerkVerifier,
    });
    return { app, authRepo, clerkVerifier };
  }

  it("creates a PAT for a Clerk-authenticated user", async () => {
    const { app } = appWithMemory();

    const res = await app.request("/v1/auth/pats", {
      method: "POST",
      headers: {
        Authorization: "Bearer token-alice",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "laptop-agent" }),
    });
    expect(res.status).toBe(201);
    const { token } = (await res.json()) as { token: string };
    expect(token.startsWith("tok_")).toBe(true);
  });

  it("a PAT minted via /pats still authenticates POST /v1/events (agent path untouched)", async () => {
    const { app } = appWithMemory();

    const patRes = await app.request("/v1/auth/pats", {
      method: "POST",
      headers: {
        Authorization: "Bearer token-alice",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "laptop-agent" }),
    });
    expect(patRes.status).toBe(201);
    const { token } = (await patRes.json()) as { token: string };

    const eventsRes = await app.request("/v1/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        events: [
          {
            eventId: "e1",
            timestamp: "2026-07-01T12:00:00.000Z",
            machineId: "m1",
            machineName: "desk",
            app: "openai-proxy",
            provider: "openai",
            model: "gpt-4o-mini",
            inputTokens: 100,
            outputTokens: 50,
            costUsd: 0.001,
            features: {
              promptChars: 200,
              responseChars: 80,
              messageCount: 2,
              codeFenceCount: 0,
              largePasteScore: 0,
              fileDumpScore: 0,
              modelTier: "small",
            },
            hasContent: false,
          },
        ],
      }),
    });
    expect(eventsRes.status).toBe(200);
    expect(await eventsRes.json()).toEqual({ accepted: 1, duplicates: 0 });
  });

  it("me requires a Clerk token; works with one", async () => {
    const { app } = appWithMemory();

    const unauth = await app.request("/v1/auth/me");
    expect(unauth.status).toBe(401);

    const me = await app.request("/v1/auth/me", {
      headers: { Authorization: "Bearer token-alice" },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "alice@example.com" });
  });

  it("rejects a PAT on /v1/auth/me (dashboard route)", async () => {
    const { app, authRepo } = appWithMemory();
    const user = await authRepo.insertClerkUser(
      "agent-owner@example.com",
      "user_agent_owner",
    );
    const { token } = await createPat(authRepo, user.id, "agent");

    const res = await app.request("/v1/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});
