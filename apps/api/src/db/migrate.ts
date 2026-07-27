import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { loadEnv } from "../env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default migrations folder: apps/api/drizzle (two levels up from src/db). */
export function migrationsFolder(
  fromDir: string = join(__dirname, "../../drizzle"),
): string {
  return fromDir;
}

export async function runMigrations(
  databaseUrl: string,
  folder: string = migrationsFolder(),
): Promise<void> {
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  await runMigrations(env.DATABASE_URL);
  console.log("Migrations applied.");
}

function isExecutedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isExecutedDirectly()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
