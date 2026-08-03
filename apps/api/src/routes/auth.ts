import { Hono } from "hono";
import { z } from "zod";
import { createPat } from "../auth/pat.js";
import { requireUser } from "../auth/middleware.js";
import type { AuthRepo } from "../auth/repo.js";
import type { ClerkVerifier } from "../auth/clerk.js";

export type AuthRouteVariables = {
  authRepo: AuthRepo;
  clerkVerifier: ClerkVerifier;
  userId: string;
};

const createPatSchema = z.object({
  name: z.string().min(1).max(128),
});

export const authRoutes = new Hono<{ Variables: AuthRouteVariables }>();

authRoutes.post("/pats", requireUser, async (c) => {
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

authRoutes.get("/me", requireUser, async (c) => {
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
