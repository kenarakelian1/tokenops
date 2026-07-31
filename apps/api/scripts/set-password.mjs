#!/usr/bin/env node
/**
 * Set a TokenOps user's password.
 *
 * TokenOps has no password-reset flow by design: it is single-user and holds no
 * email transport. Without this script a forgotten password means a lost
 * instance, since /v1/auth/register refuses to run once any user exists.
 *
 * Usage (password is prompted, never passed as an argument so it stays out of
 * shell history and process listings):
 *
 *   # Railway — the Postgres service exposes DATABASE_PUBLIC_URL
 *   railway run --service Postgres node apps/api/scripts/set-password.mjs you@example.com
 *
 *   # Compose / self-host
 *   DATABASE_URL=postgres://tokenops:tokenops@localhost:5432/tokenops \
 *     node apps/api/scripts/set-password.mjs you@example.com
 *
 * Existing PATs survive; agents keep shipping. All sessions are dropped, so
 * every browser must sign in again.
 */
import { randomBytes, scrypt } from "node:crypto";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import postgres from "postgres";

const scryptAsync = promisify(scrypt);

/** Must match apps/api/src/auth/password.ts — `scrypt$<salt_b64>$<hash_b64>`. */
const KEYLEN = 64;
const SALTLEN = 16;

async function hashPassword(password) {
  const salt = randomBytes(SALTLEN);
  const derived = await scryptAsync(password, salt, KEYLEN);
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("usage: node apps/api/scripts/set-password.mjs <email>");
  process.exit(64);
}

const url = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error(
    "No DATABASE_PUBLIC_URL or DATABASE_URL in the environment.\n" +
      "On Railway the private DATABASE_URL (postgres.railway.internal) is not\n" +
      "reachable from a laptop — run against the Postgres service so\n" +
      "DATABASE_PUBLIC_URL is injected:\n" +
      "  railway run --service Postgres node apps/api/scripts/set-password.mjs <email>",
  );
  process.exit(78);
}

const password = await prompt(`New password for ${email} (min 8 chars): `);
if (password.length < 8) {
  console.error("Password must be at least 8 characters (the API enforces this).");
  process.exit(65);
}

const sql = postgres(url, { ssl: "prefer", max: 1 });
try {
  const passwordHash = await hashPassword(password);
  const updated = await sql`
    update users set password_hash = ${passwordHash}
    where email = ${email}
    returning id, email
  `;

  if (updated.length === 0) {
    const existing = await sql`select email from users order by created_at`;
    console.error(`No user with email ${email}.`);
    console.error(
      existing.length
        ? `Known accounts: ${existing.map((u) => u.email).join(", ")}`
        : "This instance has no users at all — POST /v1/auth/register instead.",
    );
    process.exitCode = 66;
  } else {
    // Old sessions still authenticate until they expire; drop them so a reset
    // actually locks out whoever prompted it.
    const dropped = await sql`
      delete from sessions where user_id = ${updated[0].id} returning id
    `;
    console.log(`Password updated for ${updated[0].email}`);
    console.log(`Sessions invalidated: ${dropped.length}`);
    console.log("Sign in at the dashboard with the new password.");
  }
} finally {
  await sql.end();
}
