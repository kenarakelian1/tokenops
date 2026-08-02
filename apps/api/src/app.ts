import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Db } from "./db/client.js";
import { createClerkVerifier, type ClerkVerifier } from "./auth/clerk.js";
import {
  createDrizzleAuthRepo,
  type AuthRepo,
} from "./auth/repo.js";
import {
  createDrizzleEventsRepo,
  type EventsRepo,
} from "./services/events-repo.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { eventsRoutes } from "./routes/events.js";
import { aggregatesRoutes } from "./routes/aggregates.js";
import { recommendationsRoutes } from "./routes/recommendations.js";
import { heartbeatsRoutes } from "./routes/heartbeats.js";
import { machinesRoutes } from "./routes/machines.js";
import { settingsRoutes } from "./routes/settings.js";

export type AppDeps = {
  db: Db;
  /** Override for tests (in-memory). Defaults to Drizzle-backed repo. */
  authRepo?: AuthRepo;
  /** Override for tests (in-memory). Defaults to Drizzle-backed repo. */
  eventsRepo?: EventsRepo;
  /** Override for tests (fake, offline). Defaults to a real Clerk-backed verifier. */
  clerkVerifier?: ClerkVerifier;
  /** When true, enforce max 3 machines. Defaults to HOSTED_LIMITS env. */
  hostedLimits?: boolean;
  /**
   * When set, enable credentialed CORS for this origin.
   * Prefer same-origin reverse proxy (omit) for cookie sessions.
   */
  corsOrigin?: string;
};

export type AppVariables = {
  db: Db;
  authRepo: AuthRepo;
  eventsRepo: EventsRepo;
  clerkVerifier: ClerkVerifier;
  hostedLimits: boolean;
  userId: string;
};

export function createApp(deps: AppDeps): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  const authRepo = deps.authRepo ?? createDrizzleAuthRepo(deps.db);
  const eventsRepo = deps.eventsRepo ?? createDrizzleEventsRepo(deps.db);
  const clerkVerifier =
    deps.clerkVerifier ??
    createClerkVerifier({
      secretKey: process.env.CLERK_SECRET_KEY!,
      jwtKey: process.env.CLERK_JWT_KEY,
    });
  const hostedLimits =
    deps.hostedLimits ?? process.env.HOSTED_LIMITS === "true";
  const corsOrigin =
    deps.corsOrigin ?? process.env.CORS_ORIGIN ?? undefined;

  if (corsOrigin) {
    app.use(
      "*",
      cors({
        origin: corsOrigin,
        credentials: true,
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
      }),
    );
  }

  app.use("*", async (c, next) => {
    c.set("db", deps.db);
    c.set("authRepo", authRepo);
    c.set("eventsRepo", eventsRepo);
    c.set("clerkVerifier", clerkVerifier);
    c.set("hostedLimits", hostedLimits);
    await next();
  });

  app.route("/", healthRoutes);
  app.route("/v1/auth", authRoutes);
  app.route("/v1/events", eventsRoutes);
  app.route("/v1/aggregates", aggregatesRoutes);
  app.route("/v1/recommendations", recommendationsRoutes);
  app.route("/v1/heartbeats", heartbeatsRoutes);
  app.route("/v1/machines", machinesRoutes);
  app.route("/v1/settings", settingsRoutes);

  return app;
}

export { requireUser, requirePat } from "./auth/middleware.js";
