import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SESSION_SECRET: z.string().min(1, "SESSION_SECRET is required"),
  BOOTSTRAP_EMAIL: z.string().email().optional(),
  BOOTSTRAP_PASSWORD: z.string().min(1).optional(),
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
   * Prefer same-origin reverse proxy (empty) so cookies work without CORS.
   */
  CORS_ORIGIN: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(
  processEnv: NodeJS.ProcessEnv = process.env,
): Env {
  return envSchema.parse(processEnv);
}
