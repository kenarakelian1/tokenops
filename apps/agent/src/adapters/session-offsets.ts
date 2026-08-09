import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Per-file read offsets for Claude Code session files.
 *
 * There are ~1,500 session files totalling well over a gigabyte, and the
 * largest is tens of megabytes. Without a persisted offset a restart re-reads
 * everything; with one, each poll reads only what was appended.
 *
 * `size` is stored alongside the offset so the watcher can detect truncation
 * or replacement (a file smaller than its recorded offset was rotated, and
 * must be re-read from the start).
 *
 * Uses Node's built-in `node:sqlite`, same as Outbox — better-sqlite3 needs
 * native build tools the agent deliberately avoids.
 */
export class SessionOffsets {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_offsets (
        path TEXT PRIMARY KEY,
        offset INTEGER NOT NULL,
        size INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  get(path: string): { offset: number; size: number } | null {
    const row = this.db
      .prepare(`SELECT offset, size FROM session_offsets WHERE path = ?`)
      .get(path) as { offset: number; size: number } | undefined;
    return row ? { offset: Number(row.offset), size: Number(row.size) } : null;
  }

  set(path: string, offset: number, size: number): void {
    this.db
      .prepare(
        `INSERT INTO session_offsets (path, offset, size, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           offset = excluded.offset,
           size = excluded.size,
           updated_at = excluded.updated_at`,
      )
      .run(path, offset, size, new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}
