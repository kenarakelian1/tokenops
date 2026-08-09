import { describe, it, expect, afterEach } from "vitest";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageEvent } from "@tokenops/shared";
import { SessionOffsets } from "./session-offsets.js";
import { watchClaudeSessions } from "./claude-session-watcher.js";

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
});
