import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { loadEnv } from "./env.js";
import { startAggregateRulesJob } from "./jobs/aggregate-rules.js";
import { startExpireContentJob } from "./jobs/expire-content.js";
import { startSessionRulesJob } from "./jobs/session-rules.js";
import { createDrizzleEventsRepo } from "./services/events-repo.js";

async function main(): Promise<void> {
  const env = loadEnv();
  await runMigrations(env.DATABASE_URL);
  const { db } = createDb(env.DATABASE_URL);
  const app = createApp({
    db,
    hostedLimits: env.HOSTED_LIMITS,
    corsOrigin: env.CORS_ORIGIN,
  });

  startExpireContentJob(db);
  startAggregateRulesJob(db, createDrizzleEventsRepo(db));
  startSessionRulesJob(db, createDrizzleEventsRepo(db));

  serve(
    {
      fetch: app.fetch,
      port: env.PORT,
      hostname: env.HOST,
    },
    (info) => {
      console.log(`tokenops api listening on http://${info.address}:${info.port}`);
    },
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
