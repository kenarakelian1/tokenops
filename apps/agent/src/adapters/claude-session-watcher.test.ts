import { describe, it, expect, afterEach, vi } from "vitest";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageEvent } from "@tokenops/shared";
import { SessionOffsets } from "./session-offsets.js";
import { watchClaudeSessions } from "./claude-session-watcher.js";

/**
 * Node's ESM module namespace for built-ins is non-configurable, so
 * `vi.spyOn(nodeFs, "openSync")` fails with "Module namespace is not
 * configurable in ESM". `vi.mock` + `vi.hoisted` is the supported way to
 * intercept a couple of `node:fs` calls for one test at a time while every
 * other test (and the many real fs calls this suite makes — mkdtempSync,
 * writeFileSync, rmSync, ...) keeps using the real implementation.
 */
const fsControl = vi.hoisted(() => ({
  openSyncOverride: null as ((...args: unknown[]) => number) | null,
  readSyncOverride: null as ((...args: unknown[]) => number) | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: unknown[]) =>
      fsControl.openSyncOverride
        ? fsControl.openSyncOverride(...args)
        : (actual.openSync as (...a: unknown[]) => number)(...args),
    readSync: (...args: unknown[]) =>
      fsControl.readSyncOverride
        ? fsControl.readSyncOverride(...args)
        : (actual.readSync as (...a: unknown[]) => number)(...args),
  };
});

const FIXTURE = join(__dirname, "../../test/fixtures/claude-session.jsonl");
const dirs: string[] = [];

function scratch() {
  const d = mkdtempSync(join(tmpdir(), "tokenops-sessions-"));
  dirs.push(d);
  const root = join(d, "projects", "C--Users-Ken-proj");
  mkdirSync(root, { recursive: true });
  return { base: d, root: join(d, "projects"), projectDir: root };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Drain one poll cycle synchronously: start, collect, stop. */
function collectOnce(
  root: string,
  offsetsPath: string,
  over: Record<string, unknown> = {},
): { events: UsageEvent[]; logs: string[] } {
  const events: UsageEvent[] = [];
  const logs: string[] = [];
  const offsets = new SessionOffsets(offsetsPath);
  const handle = watchClaudeSessions({
    rootDir: root,
    offsets,
    machineId: "m1",
    machineName: "laptop",
    onEvent: (e) => events.push(e),
    pollMs: 0, // scan once, do not schedule
    log: { info: (m: unknown) => logs.push(String(m)) },
    ...over,
  });
  handle.stop();
  offsets.close();
  return { events, logs };
}

describe("watchClaudeSessions", () => {
  it("emits one event per assistant turn and skips other line types", () => {
    const s = scratch();
    copyFileSync(FIXTURE, join(s.projectDir, "session.jsonl"));
    const { events } = collectOnce(s.root, join(s.base, "o.db"), {
      backfillDays: 3650,
    });
    expect(events).toHaveLength(2);
    expect(events[0]!.inputTokens).toBe(54_940);
    expect(events[1]!.inputTokens).toBe(40_005);
  });

  it("does not re-emit on a second scan", () => {
    const s = scratch();
    copyFileSync(FIXTURE, join(s.projectDir, "session.jsonl"));
    const db = join(s.base, "o.db");
    const first = collectOnce(s.root, db, { backfillDays: 3650 });
    expect(first.events).toHaveLength(2);
    const second = collectOnce(s.root, db, { backfillDays: 3650 });
    expect(second.events).toHaveLength(0);
  });

  it("picks up appended turns after the recorded offset", () => {
    const s = scratch();
    const file = join(s.projectDir, "session.jsonl");
    copyFileSync(FIXTURE, file);
    const db = join(s.base, "o.db");
    collectOnce(s.root, db, { backfillDays: 3650 });

    appendFileSync(
      file,
      "\n" +
        JSON.stringify({
          type: "assistant",
          uuid: "a3",
          requestId: "r3",
          sessionId: "s1",
          timestamp: "2026-08-09T12:00:05.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-5[1m]",
            content: "reply three",
            usage: { input_tokens: 7, output_tokens: 11 },
          },
        }) +
        "\n",
    );
    const next = collectOnce(s.root, db, { backfillDays: 3650 });
    expect(next.events).toHaveLength(1);
    expect(next.events[0]!.outputTokens).toBe(11);
  });

  it("does not consume a partial final line, and emits it once complete", () => {
    const s = scratch();
    const file = join(s.projectDir, "session.jsonl");
    const full = JSON.stringify({
      type: "assistant",
      uuid: "a9",
      requestId: "r9",
      sessionId: "s1",
      timestamp: "2026-08-09T12:00:09.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-5[1m]",
        content: "done",
        usage: { input_tokens: 3, output_tokens: 4 },
      },
    });
    // Write everything except the final newline-terminated tail.
    writeFileSync(file, full.slice(0, full.length - 10));
    const db = join(s.base, "o.db");
    expect(collectOnce(s.root, db, { backfillDays: 3650 }).events).toHaveLength(0);

    // Complete the line.
    appendFileSync(file, full.slice(full.length - 10) + "\n");
    const done = collectOnce(s.root, db, { backfillDays: 3650 });
    expect(done.events).toHaveLength(1);
    expect(done.events[0]!.outputTokens).toBe(4);
  });

  it("never opens a file older than the backfill window", () => {
    const s = scratch();
    const file = join(s.projectDir, "old.jsonl");
    copyFileSync(FIXTURE, file);
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    utimesSync(file, old, old);
    const { events } = collectOnce(s.root, join(s.base, "o.db"), {
      backfillDays: 7,
    });
    expect(events).toHaveLength(0);
  });

  it("stops at the ceiling and logs what it skipped", () => {
    const s = scratch();
    copyFileSync(FIXTURE, join(s.projectDir, "session.jsonl"));
    const { events, logs } = collectOnce(s.root, join(s.base, "o.db"), {
      backfillDays: 3650,
      maxBackfillEvents: 1,
    });
    expect(events).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/ceiling|skipped|truncat/i);
  });

  it("re-reads from the start when a file shrinks (rotation)", () => {
    const s = scratch();
    const file = join(s.projectDir, "session.jsonl");
    copyFileSync(FIXTURE, file);
    const db = join(s.base, "o.db");
    collectOnce(s.root, db, { backfillDays: 3650 });

    // Replace with a shorter file containing one turn.
    writeFileSync(
      file,
      JSON.stringify({
        type: "assistant",
        uuid: "rot",
        requestId: "rr",
        sessionId: "s2",
        timestamp: "2026-08-09T13:00:00.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-5[1m]",
          content: "rotated",
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      }) + "\n",
    );
    const after = collectOnce(s.root, db, { backfillDays: 3650 });
    expect(after.events).toHaveLength(1);
    expect(after.events[0]!.outputTokens).toBe(2);
  });

  it("pairs a prompt read in one poll with the reply that arrives in the next", () => {
    const s = scratch();
    const file = join(s.projectDir, "session.jsonl");
    const db = join(s.base, "o.db");

    // Poll 1 sees only the user line.
    writeFileSync(
      file,
      JSON.stringify({
        type: "user",
        uuid: "u1",
        sessionId: "s1",
        timestamp: "2026-08-09T12:00:00.000Z",
        message: { role: "user", content: "z".repeat(30_000) },
      }) + "\n",
    );
    // Reuse ONE watcher across both polls — a fresh watcher per poll would
    // defeat the Map this test exists to pin.
    const events: UsageEvent[] = [];
    const offsets = new SessionOffsets(db);
    const handle = watchClaudeSessions({
      rootDir: s.root,
      offsets,
      machineId: "m1",
      machineName: "laptop",
      onEvent: (e) => events.push(e),
      pollMs: 0,
      backfillDays: 3650,
    });
    expect(events).toHaveLength(0);

    // Poll 2 sees the assistant reply.
    appendFileSync(
      file,
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        requestId: "r1",
        sessionId: "s1",
        timestamp: "2026-08-09T12:00:01.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-5[1m]",
          content: "ok",
          usage: { input_tokens: 5, output_tokens: 6 },
        },
      }) + "\n",
    );
    handle.rescan();

    expect(events).toHaveLength(1);
    // The prompt arrived in the PREVIOUS poll. Without a live parser this is 0.
    expect(events[0]!.features.promptChars).toBe(30_000);

    handle.stop();
    offsets.close();
  });

  it("does not permanently lose turns skipped by the ceiling: raising it later still emits them", () => {
    const s = scratch();
    copyFileSync(FIXTURE, join(s.projectDir, "session.jsonl"));
    const db = join(s.base, "o.db");

    // First poll: ceiling of 1 lets only the first turn through.
    const first = collectOnce(s.root, db, {
      backfillDays: 3650,
      maxBackfillEvents: 1,
    });
    expect(first.events).toHaveLength(1);

    // Second poll against the SAME offsets DB, ceiling raised. The turn
    // refused above must still be sitting there, unread — not silently
    // marked consumed by an offset that ran past it.
    const second = collectOnce(s.root, db, {
      backfillDays: 3650,
      maxBackfillEvents: 10,
    });
    expect(second.events).toHaveLength(1);
    expect(second.events[0]!.inputTokens).toBe(40_005);
  });

  it("does not let the ceiling exhaust across polls — steady-state tailing keeps emitting", () => {
    const s = scratch();
    const file = join(s.projectDir, "session.jsonl");
    copyFileSync(FIXTURE, file);
    const db = join(s.base, "o.db");

    const events: UsageEvent[] = [];
    const offsets = new SessionOffsets(db);
    const handle = watchClaudeSessions({
      rootDir: s.root,
      offsets,
      machineId: "m1",
      machineName: "laptop",
      onEvent: (e) => events.push(e),
      pollMs: 0,
      backfillDays: 3650,
      maxBackfillEvents: 1,
    });
    // Construction runs the first scan: ceiling of 1 lets only a1 through.
    expect(events).toHaveLength(1);

    // Nothing new appended — this is what ordinary steady-state polling
    // looks like after the initial backlog is drained one event at a time.
    // A ceiling counter that never resets would refuse forever here; a
    // per-scan ceiling retries and keeps making progress.
    handle.rescan();
    expect(events).toHaveLength(2);

    handle.stop();
    offsets.close();
  });

  it("skips a file that disappears between stat and read, without throwing", () => {
    const s = scratch();
    const file = join(s.projectDir, "session.jsonl");
    copyFileSync(FIXTURE, file);
    const db = join(s.base, "o.db");

    // Simulate the file vanishing (rotated/deleted) in the window between
    // this watcher's statSync succeeding and its openSync running.
    fsControl.openSyncOverride = () => {
      const err = new Error(
        "ENOENT: no such file or directory",
      ) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    let firstEvents: UsageEvent[];
    try {
      // If this throws, the test fails right here — that IS the assertion
      // that a vanished file is missing data, never a crash.
      firstEvents = collectOnce(s.root, db, { backfillDays: 3650 }).events;
    } finally {
      fsControl.openSyncOverride = null;
    }
    expect(firstEvents).toHaveLength(0);

    // The file was skipped, not read, so no offset was recorded for it — a
    // normal poll afterwards must still find both real turns.
    const { events } = collectOnce(s.root, db, { backfillDays: 3650 });
    expect(events).toHaveLength(2);
  });

  it("does not decode past a short readSync return (truncation race)", () => {
    const s = scratch();
    const file = join(s.projectDir, "session.jsonl");
    copyFileSync(FIXTURE, file);
    const db = join(s.base, "o.db");

    const fullContent = readFileSync(file);
    const firstNewline = fullContent.indexOf(0x0a);
    const shortN = firstNewline + 1; // exactly through the fixture's first (user) line

    fsControl.readSyncOverride = (...args: unknown[]) => {
      const [, buffer, off, length, position] = args as [
        number,
        Buffer,
        number,
        number,
        number,
      ];
      const n = Math.min(shortN, length);
      fullContent.copy(buffer, off, position, position + n);
      // Poison the rest of the allocUnsafe buffer with a fabricated,
      // fully-decodable assistant turn. A correct implementation must
      // never look past the `n` bytes readSync actually reported.
      const poison = Buffer.from(
        JSON.stringify({
          type: "assistant",
          uuid: "poison",
          requestId: "px",
          sessionId: "s1",
          timestamp: "2026-08-09T12:00:00.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-5[1m]",
            content: "poison",
            usage: { input_tokens: 1, output_tokens: 999_999 },
          },
        }) + "\n",
        "utf8",
      );
      poison.copy(buffer, off + n, 0, Math.min(poison.length, length - n));
      return n;
    };

    let firstPollEvents: UsageEvent[];
    try {
      firstPollEvents = collectOnce(s.root, db, { backfillDays: 3650 }).events;
    } finally {
      fsControl.readSyncOverride = null;
    }

    // Only the (eventless) user line was actually delivered by readSync.
    expect(firstPollEvents).toHaveLength(0);
    expect(firstPollEvents.some((e) => e.outputTokens === 999_999)).toBe(
      false,
    );

    // With the mock removed, a normal poll must still find the real turns —
    // proving the short read didn't lose data, just didn't outrun what was
    // actually delivered.
    const { events } = collectOnce(s.root, db, { backfillDays: 3650 });
    expect(events).toHaveLength(2);
  });

  it("keeps byte-accurate offsets across a multi-byte UTF-8 prompt split across polls", () => {
    const s = scratch();
    const file = join(s.projectDir, "session.jsonl");
    const db = join(s.base, "o.db");
    const prompt = "日本語".repeat(1000); // 3,000 chars, 9,000 UTF-8 bytes

    // Poll 1 sees only the user line, in a script with 3-byte characters —
    // Buffer.byteLength and string .length diverge here, unlike every other
    // fixture in this file.
    writeFileSync(
      file,
      JSON.stringify({
        type: "user",
        uuid: "u1",
        sessionId: "s1",
        timestamp: "2026-08-09T12:00:00.000Z",
        message: { role: "user", content: prompt },
      }) + "\n",
    );

    const events: UsageEvent[] = [];
    const offsets = new SessionOffsets(db);
    const handle = watchClaudeSessions({
      rootDir: s.root,
      offsets,
      machineId: "m1",
      machineName: "laptop",
      onEvent: (e) => events.push(e),
      pollMs: 0,
      backfillDays: 3650,
    });
    expect(events).toHaveLength(0);

    // Poll 2 sees the assistant reply.
    appendFileSync(
      file,
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        requestId: "r1",
        sessionId: "s1",
        timestamp: "2026-08-09T12:00:01.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-5[1m]",
          content: "ok",
          usage: { input_tokens: 5, output_tokens: 6 },
        },
      }) + "\n",
    );
    handle.rescan();

    expect(events).toHaveLength(1);
    expect(events[0]!.features.promptChars).toBe(3_000);

    // A third poll with nothing new appended must not re-emit — proving the
    // persisted offset landed on the exact UTF-8 byte boundary, not a
    // char-index approximation that would corrupt on multi-byte content.
    handle.rescan();
    expect(events).toHaveLength(1);

    handle.stop();
    offsets.close();
  });

  // --- Round 3: createSessionParser buffers a message's blocks and only
  // flushes on the NEXT message.id boundary (round 2's fix for an output
  // under-count). That leaves every file's LAST message permanently
  // unflushed unless something else proves no more blocks are coming. An
  // idle file — unchanged since the previous scan — is that proof; the
  // watcher must call flushPending() there, but nowhere else (flushing on
  // mere growth would re-introduce the early-block under-count).

  const userLine = () =>
    JSON.stringify({
      type: "user",
      uuid: "u1",
      sessionId: "s1",
      timestamp: "2026-08-09T12:00:00.000Z",
      message: { role: "user", content: "hi" },
    });

  const block = (
    messageId: string,
    uuid: string,
    outputTokens: number,
  ) =>
    JSON.stringify({
      type: "assistant",
      uuid,
      requestId: "r1",
      sessionId: "s1",
      timestamp: "2026-08-09T12:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-5[1m]",
        id: messageId,
        content: [{ type: "text", text: "reply" }],
        usage: { input_tokens: 2, output_tokens: outputTokens },
      },
    });

  it("flushes a buffered final message once the file goes idle", () => {
    const s = scratch();
    const file = join(s.projectDir, "session.jsonl");
    const db = join(s.base, "o.db");

    // A complete 2-block message (same message.id, nothing follows it in
    // the file) with divergent output_tokens across blocks — 50 is truth.
    writeFileSync(
      file,
      userLine() + "\n" + block("msg-final", "a1", 5) + "\n" +
        block("msg-final", "a2", 50) + "\n",
    );

    const events: UsageEvent[] = [];
    const offsets = new SessionOffsets(db);
    const handle = watchClaudeSessions({
      rootDir: s.root,
      offsets,
      machineId: "m1",
      machineName: "laptop",
      onEvent: (e) => events.push(e),
      pollMs: 0,
      backfillDays: 3650,
    });
    // Construction's scan reads the whole file; no message.id boundary
    // follows the message, so it's buffered, not emitted.
    expect(events).toHaveLength(0);

    // Nothing appended: the file is idle, proving the buffered message is
    // complete.
    handle.rescan();
    expect(events).toHaveLength(1);
    expect(events[0]!.outputTokens).toBe(50); // truth (last block), not 5

    handle.stop();
    offsets.close();
  });

  it("does not flush a message early while the file is still being appended", () => {
    const s = scratch();
    const file = join(s.projectDir, "session.jsonl");
    const db = join(s.base, "o.db");

    // Only the first block of the message is written so far.
    writeFileSync(
      file,
      userLine() + "\n" + block("msg-live", "a1", 5) + "\n",
    );

    const events: UsageEvent[] = [];
    const offsets = new SessionOffsets(db);
    const handle = watchClaudeSessions({
      rootDir: s.root,
      offsets,
      machineId: "m1",
      machineName: "laptop",
      onEvent: (e) => events.push(e),
      pollMs: 0,
      backfillDays: 3650,
    });
    expect(events).toHaveLength(0); // block 1 buffered

    // The file grows with the REST of that same message. This poll's
    // offset moved (growth), so it must not be mistaken for idle, and must
    // not flush the early-block figure.
    appendFileSync(file, block("msg-live", "a2", 165) + "\n");
    handle.rescan();
    expect(events).toHaveLength(0); // not flushed early

    // Now genuinely idle: nothing further is coming.
    handle.rescan();
    expect(events).toHaveLength(1); // exactly one event, not two
    expect(events[0]!.outputTokens).toBe(165); // full total, not the early 5

    handle.stop();
    offsets.close();
  });

  it("flushing twice on an idle file emits the buffered message only once", () => {
    const s = scratch();
    const file = join(s.projectDir, "session.jsonl");
    const db = join(s.base, "o.db");

    writeFileSync(
      file,
      userLine() + "\n" + block("msg-idle", "a1", 9) + "\n",
    );

    const events: UsageEvent[] = [];
    const offsets = new SessionOffsets(db);
    const handle = watchClaudeSessions({
      rootDir: s.root,
      offsets,
      machineId: "m1",
      machineName: "laptop",
      onEvent: (e) => events.push(e),
      pollMs: 0,
      backfillDays: 3650,
    });
    expect(events).toHaveLength(0);

    handle.rescan(); // idle #1: flushes the buffered message
    expect(events).toHaveLength(1);

    handle.rescan(); // idle #2: flushPending() on an already-drained buffer
    expect(events).toHaveLength(1); // no duplicate

    handle.stop();
    offsets.close();
  });
});
