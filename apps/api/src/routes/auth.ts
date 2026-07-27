import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { createPat } from "../auth/pat.js";
import { requireSession } from "../auth/middleware.js";
import type { AuthRepo } from "../auth/repo.js";
import {
  createSession,
  deleteSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "../auth/session.js";

export type AuthRouteVariables = {
  authRepo: AuthRepo;
  userId: string;
};

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const createPatSchema = z.object({
  name: z.string().min(1).max(128),
});

export const authRoutes = new Hono<{ Variables: AuthRouteVariables }>();

/** Bootstrap register — only when zero users exist. */
authRoutes.post("/register", async (c) => {
  const repo = c.get("authRepo");
  const body = await c.req.json().catch(() => null);
  const parsed = credentialsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "invalid_body", details: parsed.error.flatten() },
      400,
    );
  }

  const count = await repo.countUsers();
  if (count > 0) {
    return c.json({ error: "registration_closed" }, 403);
  }

  const { email, password } = parsed.data;
  const passwordHash = await hashPassword(password);
  const user = await repo.insertUser(email.toLowerCase(), passwordHash);

  const session = await createSession(repo, user.id);
  setCookie(c, SESSION_COOKIE, session.id, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    expires: session.expiresAt,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });

  return c.json({ id: user.id, email: user.email }, 201);
});

authRoutes.post("/login", async (c) => {
  const repo = c.get("authRepo");
  const body = await c.req.json().catch(() => null);
  const parsed = credentialsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "invalid_body", details: parsed.error.flatten() },
      400,
    );
  }

  const email = parsed.data.email.toLowerCase();
  const user = await repo.getUserByEmail(email);
  if (!user) {
    return c.json({ error: "invalid_credentials" }, 401);
  }

  const ok = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!ok) {
    return c.json({ error: "invalid_credentials" }, 401);
  }

  const session = await createSession(repo, user.id);
  setCookie(c, SESSION_COOKIE, session.id, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    expires: session.expiresAt,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });

  return c.json({ id: user.id, email: user.email });
});

authRoutes.post("/logout", async (c) => {
  const repo = c.get("authRepo");
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await deleteSession(repo, token);
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

authRoutes.post("/pats", requireSession, async (c) => {
  const repo = c.get("authRepo");
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  const parsed = createPatSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "invalid_body", details: parsed.error.flatten() },
      400,
    );
  }

  const { token, id } = await createPat(repo, userId, parsed.data.name);
  return c.json({ token, id }, 201);
});

authRoutes.get("/me", requireSession, async (c) => {
  const repo = c.get("authRepo");
  const userId = c.get("userId");
  const user = await repo.getUserById(userId);
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return c.json({
    id: user.id,
    email: user.email,
    budgetUsdMonthly: user.budgetUsdMonthly,
  });
});
