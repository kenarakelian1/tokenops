import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

/**
 * Docker Compose / shell often pass optional vars as "" when unset.
 * Zod `.optional()` only accepts `undefined`, not empty string — normalize first.
 */
export function emptyToUndefined(
  env: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = value === "" ? undefined : value;
  }
  return out;
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  /**
   * Clerk Backend API secret key. Required at boot — without it the API
   * cannot verify any dashboard session, so failing fast here surfaces the
   * cause in ten seconds instead of a 500 on first request. Get one from
   * the Clerk dashboard (see README.md for setup instructions).
   */
  CLERK_SECRET_KEY: z
    .string({
      error: "CLERK_SECRET_KEY is required — see README.md for Clerk setup",
    })
    .min(1, "CLERK_SECRET_KEY is required — see README.md for Clerk setup"),
  /** Optional: pins Clerk JWT verification to a specific instance key, enabling networkless verification. */
  CLERK_JWT_KEY: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  /** When "true", enforce free-tier machine limit and 30d raw event retention. */
  HOSTED_LIMITS: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  /** Override raw usage_events retention (days). Unset = unlimited (self-host) or 30 when HOSTED_LIMITS. */
  RAW_EVENT_RETENTION_DAYS: z.coerce.number().int().nonnegative().optional(),
  /**
   * Browser origin allowed for credentialed CORS (e.g. https://app.example.com).
   * Prefer same-origin reverse proxy (empty) so the dashboard and API share
   * an origin without needing CORS at all.
   */
  CORS_ORIGIN: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(
  processEnv: NodeJS.ProcessEnv = process.env,
): Env {
  return envSchema.parse(emptyToUndefined(processEnv));
}
