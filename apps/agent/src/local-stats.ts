import { DatabaseSync } from "node:sqlite";

export type LocalStats = {
  today: {
    inputTokens: number;
    outputTokens: number;
    estimatedUsd: number;
    eventCount: number;
  };
  byApp: Array<{ app: string; inputTokens: number; outputTokens: number }>;
  byModel: Array<{ model: string; inputTokens: number; outputTokens: number }>;
  queue: { pending: number; lastError: string | null };
  recent: Array<{
    at: string;
    app: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }>;
};

type PayloadRow = { payload: string };

/** Add tokens for `key` into `map`, creating the bucket on first use. */
function bump(
  map: Map<string, { inputTokens: number; outputTokens: number }>,
  key: string,
  input: number,
  output: number,
): void {
  const bucket = map.get(key) ?? { inputTokens: 0, outputTokens: 0 };
  bucket.inputTokens += input;
  bucket.outputTokens += output;
  map.set(key, bucket);
}

function emptyStats(): LocalStats {
  return {
    today: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, eventCount: 0 },
    byApp: [],
    byModel: [],
    queue: { pending: 0, lastError: null },
    recent: [],
  };
}

/** Local-day boundary, so "today" matches what the user's clock shows. */
function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Read rollups directly from the agent's outbox.
 *
 * Counts BOTH pending and sent rows. `markSent` (apps/agent/src/outbox.ts)
 * only flips `status` to 'sent' and never deletes the row, so sent events
 * keep their payloads -- that is what makes a local "today" total possible
 * without a second table. It also means this table grows without bound, so
 * every query here is bounded by date or LIMIT.
 *
 * Uses `node:sqlite` (not `better-sqlite3`) to match `Outbox`, which reads
 * that way specifically to avoid a native-build-tool dependency.
 *
 * Never throws: this backs a UI that must not go blank. A missing database
 * (the agent has never run) or a missing/corrupt table returns an all-zero
 * `LocalStats`, and individual malformed payload rows (partial writes) are
 * skipped rather than propagated.
 */
export function readLocalStats(dbPath: string, now: Date = new Date()): LocalStats {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    // No database file yet -- the agent has never run.
    return emptyStats();
  }

  try {
    const since = startOfLocalDay(now).toISOString();

    let rows: PayloadRow[];
    try {
      rows = db
        .prepare(
          `SELECT payload FROM outbox
           WHERE json_valid(payload)
             AND json_extract(payload, '$.timestamp') >= ?
           ORDER BY json_extract(payload, '$.timestamp') DESC`,
        )
        .all(since) as PayloadRow[];
    } catch {
      // Table doesn't exist (or some other query-time failure).
      return emptyStats();
    }

    const today = { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, eventCount: 0 };
    const byApp = new Map<string, { inputTokens: number; outputTokens: number }>();
    const byModel = new Map<string, { inputTokens: number; outputTokens: number }>();
    const recent: LocalStats["recent"] = [];

    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload);
      } catch {
        continue; // A partially written row must not take the window down.
      }
      if (parsed === null || typeof parsed !== "object") continue;
      const e = parsed as Record<string, unknown>;

      const input = Number(e.inputTokens) || 0;
      const output = Number(e.outputTokens) || 0;
      const app = typeof e.app === "string" ? e.app : "unknown";
      const model = typeof e.model === "string" ? e.model : "unknown";
      const at = typeof e.timestamp === "string" ? e.timestamp : "";

      today.inputTokens += input;
      today.outputTokens += output;
      today.estimatedUsd += Number(e.costUsd) || 0; // costUsd is nullable (and may be absent on malformed rows)
      today.eventCount += 1;

      bump(byApp, app, input, output);
      bump(byModel, model, input, output);

      if (recent.length < 20) {
        recent.push({ at, app, model, inputTokens: input, outputTokens: output });
      }
    }

    // Polled every ~2s while the agent may be mid-write to this same file, so
    // a transient SQLITE_BUSY (or any other query-time failure) here must
    // degrade to a stale-but-safe queue reading rather than throw.
    let pending = 0;
    try {
      pending =
        (
          db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`).get() as
            | { n: number }
            | undefined
        )?.n ?? 0;
    } catch {
      pending = 0;
    }

    let lastError: string | null = null;
    try {
      lastError =
        (
          db
            .prepare(
              `SELECT last_error FROM outbox
               WHERE status = 'pending' AND last_error IS NOT NULL
               ORDER BY created_at DESC LIMIT 1`,
            )
            .get() as { last_error: string } | undefined
        )?.last_error ?? null;
    } catch {
      lastError = null;
    }

    return {
      today,
      byApp: [...byApp].map(([app, v]) => ({ app, ...v })),
      byModel: [...byModel].map(([model, v]) => ({ model, ...v })),
      queue: { pending, lastError },
      recent,
    };
  } finally {
    db.close();
  }
}
