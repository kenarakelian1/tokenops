import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createApp } from "../app.js";
import { requirePat, requireSession } from "./middleware.js";
import { hashPassword, verifyPassword } from "./password.js";
import { createPat, generatePatToken, hashToken, verifyPat } from "./pat.js";
import { createMemoryAuthRepo, type AuthRepo } from "./repo.js";
import {
  createSession,
  getSession,
  deleteSession,
  SESSION_COOKIE,
} from "./session.js";

describe("password", () => {
  it("roundtrips", async () => {
    const h = await hashPassword("secret-pass-1");
    expect(await verifyPassword("secret-pass-1", h)).toBe(true);
    expect(await verifyPassword("nope", h)).toBe(false);
  });

  it("produces scrypt-prefixed distinct hashes", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });
});

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
    const user = await repo.insertUser(
      "agent@example.com",
      await hashPassword("password1"),
    );
    const { token, id } = await createPat(repo, user.id, "ci");
    expect(id).toBeTruthy();
    expect(token.startsWith("tok_")).toBe(true);
    expect(await verifyPat(repo, token)).toBe(user.id);
    expect(await verifyPat(repo, "tok_nope")).toBeNull();
    expect(await verifyPat(repo, "not-a-pat")).toBeNull();
  });
});

describe("session", () => {
  it("createSession / getSession / deleteSession", async () => {
    const repo = createMemoryAuthRepo();
    const user = await repo.insertUser(
      "s@example.com",
      await hashPassword("password1"),
    );
    const session = await createSession(repo, user.id);
    const loaded = await getSession(repo, session.id);
    expect(loaded?.userId).toBe(user.id);
    await deleteSession(repo, session.id);
    expect(await getSession(repo, session.id)).toBeNull();
  });
});

describe("middleware", () => {
  type Vars = { authRepo: AuthRepo; userId: string };

  it("requirePat accepts Bearer tok_ and rejects bad tokens", async () => {
    const repo = createMemoryAuthRepo();
    const user = await repo.insertUser(
      "pat@example.com",
      await hashPassword("password1"),
    );
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

  it("requireSession accepts session cookie", async () => {
    const repo = createMemoryAuthRepo();
    const user = await repo.insertUser(
      "sess@example.com",
      await hashPassword("password1"),
    );
    const session = await createSession(repo, user.id);

    const app = new Hono<{ Variables: Vars }>();
    app.use("*", async (c, next) => {
      c.set("authRepo", repo);
      await next();
    });
    app.get("/me", requireSession, (c) => c.json({ userId: c.get("userId") }));

    const ok = await app.request("/me", {
      headers: { cookie: `${SESSION_COOKIE}=${session.id}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ userId: user.id });

    const bad = await app.request("/me");
    expect(bad.status).toBe(401);
  });
});

describe("auth routes", () => {
  function appWithMemory() {
    const authRepo = createMemoryAuthRepo();
    const app = createApp({ db: null as never, authRepo });
    return { app, authRepo };
  }

  function cookieFrom(res: Response): string | undefined {
    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) return undefined;
    const match = setCookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
    return match?.[1];
  }

  it("register bootstrap when zero users", async () => {
    const { app } = appWithMemory();
    const res = await app.request("/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "owner@example.com",
        password: "password1",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.email).toBe("owner@example.com");
    expect(cookieFrom(res)).toBeTruthy();
  });

  it("register returns 403 when a user already exists", async () => {
    const { app, authRepo } = appWithMemory();
    await authRepo.insertUser(
      "existing@example.com",
      await hashPassword("password1"),
    );
    const res = await app.request("/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "other@example.com",
        password: "password1",
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "registration_closed" });
  });

  it("login sets cookie", async () => {
    const { app, authRepo } = appWithMemory();
    await authRepo.insertUser(
      "user@example.com",
      await hashPassword("secret-pass-1"),
    );

    const res = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "user@example.com",
        password: "secret-pass-1",
      }),
    });
    expect(res.status).toBe(200);
    const cookie = cookieFrom(res);
    expect(cookie).toBeTruthy();
    expect(await res.json()).toMatchObject({ email: "user@example.com" });
  });

  it("login rejects bad password", async () => {
    const { app, authRepo } = appWithMemory();
    await authRepo.insertUser(
      "user@example.com",
      await hashPassword("secret-pass-1"),
    );
    const res = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "user@example.com",
        password: "wrong-password",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("login rejects a Clerk-linked user with no password hash", async () => {
    const { app, authRepo } = appWithMemory();
    await authRepo.insertClerkUser("clerkonly@example.com", "user_clerk_only");

    const res = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "clerkonly@example.com",
        password: "whatever123",
      }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_credentials" });
  });

  it("me requires session; works with cookie", async () => {
    const { app } = appWithMemory();
    const reg = await app.request("/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "me@example.com",
        password: "password1",
      }),
    });
    const cookie = cookieFrom(reg);
    expect(cookie).toBeTruthy();

    const unauth = await app.request("/v1/auth/me");
    expect(unauth.status).toBe(401);

    const me = await app.request("/v1/auth/me", {
      headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "me@example.com" });
  });

  it("create PAT with session returns token once", async () => {
    const { app } = appWithMemory();
    const reg = await app.request("/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "pat@example.com",
        password: "password1",
      }),
    });
    const cookie = cookieFrom(reg)!;

    const patRes = await app.request("/v1/auth/pats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=${cookie}`,
      },
      body: JSON.stringify({ name: "agent" }),
    });
    expect(patRes.status).toBe(201);
    const body = (await patRes.json()) as { token: string; id: string };
    expect(body.id).toBeTruthy();
    expect(body.token.startsWith("tok_")).toBe(true);
  });

  it("logout clears session", async () => {
    const { app } = appWithMemory();
    const reg = await app.request("/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "out@example.com",
        password: "password1",
      }),
    });
    const cookie = cookieFrom(reg)!;

    const logout = await app.request("/v1/auth/logout", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(logout.status).toBe(200);

    const me = await app.request("/v1/auth/me", {
      headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(me.status).toBe(401);
  });
});
