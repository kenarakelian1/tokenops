import { Hono } from "hono";
import type { Db } from "./db/client.js";
import {
  createDrizzleAuthRepo,
  type AuthRepo,
} from "./auth/repo.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";

export type AppDeps = {
  db: Db;
  /** Override for tests (in-memory). Defaults to Drizzle-backed repo. */
  authRepo?: AuthRepo;
};

export type AppVariables = {
  db: Db;
  authRepo: AuthRepo;
  userId: string;
};

export function createApp(deps: AppDeps): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  const authRepo = deps.authRepo ?? createDrizzleAuthRepo(deps.db);

  app.use("*", async (c, next) => {
    c.set("db", deps.db);
    c.set("authRepo", authRepo);
    await next();
  });

  app.route("/", healthRoutes);
  app.route("/v1/auth", authRoutes);

  return app;
}

export { requireSession, requirePat } from "./auth/middleware.js";
