#!/usr/bin/env node
/**
 * Delete every currently-open `frontier_trivial` recommendation.
 *
 * Why delete rather than dismiss: these rows are bogus, produced by a job
 * that deduped on event id instead of rule+window and so emitted one
 * "identical" card per run. Setting status='dismissed' would record a user
 * judgement ("I looked at this and don't want it") that never happened.
 * Delete removes rows that should never have existed; dismiss is for a
 * user's real decision on a real finding.
 *
 * This only targets `frontier_trivial` rows, and only ones still `open` —
 * a user may have already dismissed one, in which case it's not touched.
 *
 * Prints the open-frontier_trivial count before and after so the operator
 * can confirm the delete did what it says.
 *
 * Do NOT run this against production from here — deploying/running this
 * against the live database is a separate deploy step, not part of this
 * task.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node apps/api/scripts/clear-stale-recommendations.mjs
 */
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";

loadDotenv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "DATABASE_URL is required (set it in the environment or apps/api/.env).",
  );
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });

async function countOpenFrontierTrivial() {
  const [row] = await sql`
    SELECT count(*)::int AS count
    FROM recommendations
    WHERE rule_id = 'frontier_trivial' AND status = 'open'
  `;
  return row.count;
}

async function main() {
  const before = await countOpenFrontierTrivial();
  console.log(`Open frontier_trivial recommendations before: ${before}`);

  const deleted = await sql`
    DELETE FROM recommendations
    WHERE rule_id = 'frontier_trivial' AND status = 'open'
    RETURNING id
  `;
  console.log(`Deleted: ${deleted.length}`);

  const after = await countOpenFrontierTrivial();
  console.log(`Open frontier_trivial recommendations after: ${after}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 5 });
  });
