// Pin the local-day boundary to UTC so "today" tests are deterministic
// regardless of the host machine's timezone. Must run before any Date
// objects below are constructed.
process.env.TZ = "UTC";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageEvent } from "@tokenops/shared";
import { Outbox } from "./outbox.js";
import { readLocalStats } from "./local-stats.js";

let dir: string;
let dbPath: string;

function event(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    timestamp: "2026-08-04T12:00:00.000Z",
    machineId: "m1",
    machineName: "desktop",
    app: "openai-proxy",
    provider: "openai",
    model: "gpt-4o-mini",
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.001,
    features: {
      promptChars: 0,
      responseChars: 0,
      messageCount: 0,
      codeFenceCount: 0,
      largePasteScore: 0,
      fileDumpScore: 0,
      modelTier: "small",
    },
    hasContent: false,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tokenops-stats-"));
  dbPath = join(dir, "outbox.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readLocalStats", () => {
  const now = new Date("2026-08-04T18:00:00.000Z");

  it("returns zeroes for an empty database", () => {
    new Outbox(dbPath).close();
    const stats = readLocalStats(dbPath, now);
    expect(stats.today.inputTokens).toBe(0);
    expect(stats.today.eventCount).toBe(0);
    expect(stats.byApp).toEqual([]);
    expect(stats.recent).toEqual([]);
  });

  it("returns zeroes when the outbox database does not exist yet", () => {
    // The agent has never run: dbPath was never created, not even the file.
    const stats = readLocalStats(dbPath, now);
    expect(stats).toEqual({
      today: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, eventCount: 0 },
      byApp: [],
      byModel: [],
      queue: { pending: 0, lastError: null },
      recent: [],
    });
  });

  it("returns zeroes when the file exists but the outbox table is missing", () => {
    // Distinct from the "no file at all" case above: here `new DatabaseSync`
    // succeeds (the file is a valid, openable sqlite database) but the
    // `outbox` table itself is absent, so the query -- not the open -- fails.
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE unrelated (id INTEGER)");
    db.close();

    const stats = readLocalStats(dbPath, now);
    expect(stats).toEqual({
      today: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, eventCount: 0 },
      byApp: [],
      byModel: [],
      queue: { pending: 0, lastError: null },
      recent: [],
    });
  });

  it("counts sent events, not just pending ones", () => {
    const outbox = new Outbox(dbPath);
    const e = event();
    outbox.enqueue(e);
    outbox.markSent([e.eventId]);
    outbox.close();

    const stats = readLocalStats(dbPath, now);
    expect(stats.today.eventCount).toBe(1);
    expect(stats.today.inputTokens).toBe(100);
    expect(stats.today.outputTokens).toBe(50);
  });

  it("excludes events from a previous day", () => {
    const outbox = new Outbox(dbPath);
    outbox.enqueue(event({ timestamp: "2026-08-03T23:59:59.000Z" }));
    outbox.enqueue(event({ timestamp: "2026-08-04T00:00:01.000Z" }));
    outbox.close();

    const stats = readLocalStats(dbPath, now);
    expect(stats.today.eventCount).toBe(1);
  });

  it("buckets a late-night event by the local day, not the UTC day", () => {
    // The whole reason startOfLocalDay uses local Date getters instead of
    // UTC ones is so the day boundary follows the user's own clock. Prove it
    // under a real non-zero offset (America/New_York, this machine's own
    // zone) rather than the file-wide TZ=UTC pin used everywhere else, which
    // would let a UTC-vs-local bug pass silently. Scoped to this test only.
    const originalTz = process.env.TZ;
    process.env.TZ = "America/New_York"; // EDT = UTC-4 in August
    try {
      // Local midnight on Aug 4 EDT is 2026-08-04T04:00:00.000Z. A UTC-day
      // implementation would instead put the boundary at 2026-08-04T00:00:00Z
      // and wrongly count both events below as "today".
      const outbox = new Outbox(dbPath);
      outbox.enqueue(event({ timestamp: "2026-08-04T03:59:59.000Z" })); // 11:59:59pm Aug 3 EDT
      outbox.enqueue(event({ timestamp: "2026-08-04T04:00:01.000Z" })); // 12:00:01am Aug 4 EDT
      outbox.close();

      // `now` (2026-08-04T18:00:00.000Z) is 2:00pm Aug 4 EDT -- still Aug 4
      // locally, so the local-day boundary above is the one in effect.
      const stats = readLocalStats(dbPath, now);
      expect(stats.today.eventCount).toBe(1);
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it("groups by app and by model", () => {
    const outbox = new Outbox(dbPath);
    outbox.enqueue(event({ app: "openai-proxy", model: "gpt-4o-mini" }));
    outbox.enqueue(event({ app: "claude-code", model: "claude-sonnet-4" }));
    outbox.enqueue(event({ app: "claude-code", model: "claude-sonnet-4" }));
    outbox.close();

    const stats = readLocalStats(dbPath, now);
    const claude = stats.byApp.find((r) => r.app === "claude-code");
    expect(claude?.inputTokens).toBe(200);
    expect(stats.byModel.map((r) => r.model).sort()).toEqual([
      "claude-sonnet-4",
      "gpt-4o-mini",
    ]);
  });

  it("sums a null costUsd as zero rather than NaN", () => {
    const outbox = new Outbox(dbPath);
    outbox.enqueue(event({ costUsd: null }));
    outbox.close();

    const stats = readLocalStats(dbPath, now);
    expect(stats.today.estimatedUsd).toBe(0);
    expect(Number.isNaN(stats.today.estimatedUsd)).toBe(false);
  });

  it("does not let a missing costUsd field poison the running total", () => {
    // A genuinely naive `total += e.costUsd` only breaks once a value is
    // `undefined` rather than JSON `null` (null coerces to 0 under `+`;
    // undefined does not). Exercise that case directly, alongside a normal
    // numeric row, so a dropped guard shows up as NaN instead of quietly
    // matching by accident.
    const outbox = new Outbox(dbPath);
    const { costUsd: _drop, ...withoutCostUsd } = event();
    outbox.enqueue(withoutCostUsd as UsageEvent);
    outbox.enqueue(event({ costUsd: 0.5 }));
    outbox.close();

    const stats = readLocalStats(dbPath, now);
    expect(Number.isNaN(stats.today.estimatedUsd)).toBe(false);
    expect(stats.today.estimatedUsd).toBe(0.5);
  });

  it("skips malformed payload rows instead of throwing", () => {
    const outbox = new Outbox(dbPath);
    outbox.enqueue(event());
    outbox.close();

    // Corrupt one row directly, the way a partial write would. `node:sqlite`
    // is the same driver the outbox uses (Outbox does not use
    // better-sqlite3), so it is imported statically here -- no dynamic
    // import, and no non-async-callback pitfall to work around.
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `INSERT INTO outbox (event_id, payload, status, attempts, last_error, created_at)
       VALUES ('bad', 'not json', 'pending', 0, NULL, ?)`,
    ).run(new Date().toISOString());
    db.close();

    const stats = readLocalStats(dbPath, now);
    expect(stats.today.eventCount).toBe(1);
  });

  it("degrades the queue view instead of throwing when the queue queries fail", () => {
    // The desktop window polls this every ~2s while the agent may be
    // mid-write to the same file, so a transient SQLITE_BUSY (or any other
    // query-time failure) on the pending/lastError queries must not blank
    // the window. Simulate it by dropping a column those queries need but
    // the payload scan (`rows`) never references, so today/byApp/etc still
    // compute correctly while only `queue` degrades.
    const outbox = new Outbox(dbPath);
    const e = event();
    outbox.enqueue(e);
    outbox.close();

    // (Renaming rather than dropping: the outbox schema has an index on
    // `status`, and node:sqlite's DROP COLUMN cannot rebuild it in place.)
    const db = new DatabaseSync(dbPath);
    db.exec("ALTER TABLE outbox RENAME COLUMN status TO status_old");
    db.close();

    const stats = readLocalStats(dbPath, now);
    expect(stats.today.eventCount).toBe(1);
    expect(stats.today.inputTokens).toBe(100);
    expect(stats.queue).toEqual({ pending: 0, lastError: null });
  });

  it("reports queue depth and the latest error", () => {
    const outbox = new Outbox(dbPath);
    const e = event();
    outbox.enqueue(e);
    outbox.markFailed(e.eventId, "cloud unreachable");
    outbox.close();

    const stats = readLocalStats(dbPath, now);
    expect(stats.queue.pending).toBe(1);
    expect(stats.queue.lastError).toBe("cloud unreachable");
  });

  it("returns recent events newest first, capped at 20", () => {
    const outbox = new Outbox(dbPath);
    for (let i = 0; i < 25; i++) {
      outbox.enqueue(event({ timestamp: `2026-08-04T12:00:${String(i).padStart(2, "0")}.000Z` }));
    }
    outbox.close();

    const stats = readLocalStats(dbPath, now);
    expect(stats.recent).toHaveLength(20);
    expect(stats.recent[0]!.at > stats.recent[1]!.at).toBe(true);
  });
});
