import { Hono } from "hono";
import type { Db } from "./db/client.js";
import { healthRoutes } from "./routes/health.js";

export type AppDeps = {
  db: Db;
};

export type AppVariables = {
  db: Db;
};

export function createApp(deps: AppDeps): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use("*", async (c, next) => {
    c.set("db", deps.db);
    await next();
  });

  app.route("/", healthRoutes);

  return app;
}
