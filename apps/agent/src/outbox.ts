import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { UsageEvent } from "@tokenops/shared";
import { defaultTokenopsDir } from "./config.js";

export type OutboxStatus = "pending" | "sent" | "failed";

export type OutboxRow = {
  eventId: string;
  payload: UsageEvent;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
};

/** Default outbox path: `~/.tokenops/outbox.db`. */
export function defaultOutboxPath(): string {
  return join(defaultTokenopsDir(), "outbox.db");
}

/**
 * Durable SQLite outbox for usage events awaiting cloud ingest.
 * Uses Node built-in `node:sqlite` (better-sqlite3 requires native build tools).
 */
export class Outbox {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        event_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_status_created
        ON outbox (status, created_at);
    `);
  }

  /** Enqueue an event as pending. Idempotent on eventId (replace payload if re-queued). */
  enqueue(event: UsageEvent): void {
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO outbox (event_id, payload, status, attempts, last_error, created_at)
         VALUES (?, ?, 'pending', 0, NULL, ?)
         ON CONFLICT(event_id) DO UPDATE SET
           payload = excluded.payload,
           status = 'pending',
           last_error = NULL`,
      )
      .run(event.eventId, JSON.stringify(event), createdAt);
  }

  /** List pending events oldest-first, up to `limit`. */
  listPending(limit: number): UsageEvent[] {
    const rows = this.db
      .prepare(
        `SELECT payload FROM outbox
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit) as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload) as UsageEvent);
  }

  /** Mark events as successfully sent. */
  markSent(ids: string[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE outbox SET status = 'sent', last_error = NULL WHERE event_id = ?`,
    );
    for (const id of ids) {
      stmt.run(id);
    }
  }

  /**
   * Record a flush failure: bump attempts and last_error.
   * Status stays `pending` so backoff flush can retry.
   */
  markFailed(id: string, err: string): void {
    this.db
      .prepare(
        `UPDATE outbox
         SET status = 'pending',
             attempts = attempts + 1,
             last_error = ?
         WHERE event_id = ?`,
      )
      .run(err, id);
  }

  /** Count of pending rows (for heartbeats / status). */
  pendingCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`)
      .get() as { n: number };
    return row.n;
  }

  /**
   * Most recent non-null last_error among pending rows (for `tokenops status`).
   * Returns null when no failures recorded.
   */
  latestError(): string | null {
    const row = this.db
      .prepare(
        `SELECT last_error FROM outbox
         WHERE last_error IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get() as { last_error: string } | undefined;
    return row?.last_error ?? null;
  }

  close(): void {
    this.db.close();
  }
}
