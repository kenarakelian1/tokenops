import { Hono } from "hono";
import { z } from "zod";
import { requireSession } from "../auth/middleware.js";
import type { AuthRepo } from "../auth/repo.js";

export type SettingsRouteVariables = {
  authRepo: AuthRepo;
  userId: string;
};

const settingsSchema = z.object({
  budgetUsdMonthly: z.number().nonnegative().nullable(),
});

export const settingsRoutes = new Hono<{ Variables: SettingsRouteVariables }>();

/** Session: update user settings (budget). */
settingsRoutes.put("/", requireSession, async (c) => {
  const repo = c.get("authRepo");
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "invalid_body", details: parsed.error.flatten() },
      400,
    );
  }

  const budget =
    parsed.data.budgetUsdMonthly == null
      ? null
      : String(parsed.data.budgetUsdMonthly);

  await repo.updateBudgetUsdMonthly(userId, budget);
  const user = await repo.getUserById(userId);
  return c.json({
    budgetUsdMonthly:
      user?.budgetUsdMonthly != null ? Number(user.budgetUsdMonthly) : null,
  });
});
