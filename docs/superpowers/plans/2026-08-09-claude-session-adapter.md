# Claude Code Session Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read Claude Code's own session JSONL, derive features locally, and ship only integers — so the three per-request rules fire on real usage instead of on fabricated OTEL placeholders.

**Architecture:** A stateful line parser turns a session file's `assistant` turns into `UsageEvent`s, pairing each with the preceding `user` turn for feature derivation. A SQLite-backed offset store lets a watcher resume per file rather than re-read 1.38 GB. The OTLP receiver drops `claude_code.*` while the session adapter is enabled, so one source owns Claude Code.

**Tech Stack:** TypeScript (ESM, NodeNext), Node built-in `node:sqlite`, Vitest, `@tokenops/shared`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-09-claude-session-adapter-design.md`. Read it before Task 1.
- **Branch:** `feat/claude-session-adapter`, stacked on `docs/recs-credibility-spec` (already checked out).
- **No content leaves the machine.** The adapter reads prompt text to derive features and must never place raw text on the `UsageEvent`. Setting `content` or `hasContent: true` is the one thing this design exists to avoid.
- **Token folding:** `inputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. `cacheReadTokens` / `cacheCreationTokens` are the raw subsets. Post-condition, always: `(cacheRead ?? 0) + (cacheCreation ?? 0) <= inputTokens`.
- **`null`/absent vs `0`:** a cache field *absent* from the usage object is `undefined` (not recorded). A field present as `0` is recorded-and-zero. Never coerce absent to `0` on the event.
- **`costUsd: null`.** A Max subscription has no per-request cost, and savings never read a reported cost.
- **`grain: "request"`.** This is the entire point — request rules skip aggregates.
- **Failure mode is missing data, never a crashed agent.** The JSONL format is not a published contract. Skip unparseable lines and unknown shapes; never throw out of a watcher callback.
- **Windows paths.** Sessions live under `C--Users-Ken-…` directories. Use `node:path`; never assume POSIX separators.
- ESM imports use explicit `.js` extensions.
- **Test command:** `pnpm --filter @tokenops/agent test`. Full bar before any commit that touches shared surfaces: `pnpm -r build && pnpm -r test`.

## File Structure

**Create**
| File | Responsibility |
|---|---|
| `apps/agent/src/adapters/claude-session.ts` | Pure-ish line parser: session JSONL lines → `UsageEvent`s. No I/O. |
| `apps/agent/src/adapters/claude-session.test.ts` | Parser tests, incl. the real measured sample. |
| `apps/agent/src/adapters/session-offsets.ts` | Per-file offset store over `node:sqlite`. |
| `apps/agent/src/adapters/session-offsets.test.ts` | Offset persistence and resume. |
| `apps/agent/src/adapters/claude-session-watcher.ts` | Directory scan, backfill window, ceiling, tail, partial-line handling. |
| `apps/agent/src/adapters/claude-session-watcher.test.ts` | Watcher behavior against temp dirs. |
| `apps/agent/test/fixtures/claude-session.jsonl` | Fixture session file. |

**Modify**
| File | Change |
|---|---|
| `apps/agent/src/config.ts` | Add `sources.claudeCodeBackfillDays`; default `claudeCodePath` to `~/.claude/projects`. |
| `apps/agent/src/adapters/claude-otel.ts` | Guard: drop `claude_code.*` when the session adapter owns the source. |
| `apps/agent/src/agent-main.ts` | Wire the watcher; pass the guard flag to the OTEL server. |
| `README.md` + `README.html` | Document the source and the guard. |

---

### Task 1: Session line parser

The core. Everything else is I/O around this.

**Files:**
- Create: `apps/agent/src/adapters/claude-session.ts`
- Create: `apps/agent/src/adapters/claude-session.test.ts`

**Interfaces:**
- Consumes: `buildEventId`, `extractFeatures`, `getModelTier`, `type UsageEvent` from `@tokenops/shared`.
- Produces: `createSessionParser(opts): SessionParser`, `type SessionParser = { parseLine(raw: string): UsageEvent | null }`, `type ClaudeSessionLine`. Tasks 3 and 5 depend on these names.

**Why the parser is stateful:** an `assistant` line carries the model's *reply*, not the prompt. `extractFeatures` needs the prompt. The prompt for a turn is the preceding `user` line in the same file, so the parser holds the last-seen user content and the previous turn's `promptChars` (which is what produces `newContentRatio`, the signal `context_bloat` gates on).

- [ ] **Step 1: Write the failing test**

Create `apps/agent/src/adapters/claude-session.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createSessionParser } from "./claude-session.js";

const parser = () =>
  createSessionParser({ machineId: "m1", machineName: "laptop" });

const userLine = (text: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "user",
    uuid: "u-1",
    sessionId: "s-1",
    timestamp: "2026-08-09T12:00:00.000Z",
    message: { role: "user", content: text },
    ...over,
  });

const assistantLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    uuid: "a-1",
    requestId: "req_1",
    sessionId: "s-1",
    timestamp: "2026-08-09T12:00:01.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-5[1m]",
      content: "ok",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 28_890,
        cache_read_input_tokens: 26_048,
        output_tokens: 229,
      },
    },
    ...over,
  });

describe("createSessionParser", () => {
  it("folds cache tokens into inputTokens and keeps the raw subsets", () => {
    // The real measured sample from ~/.claude/projects.
    const p = parser();
    p.parseLine(userLine("hello"));
    const ev = p.parseLine(assistantLine())!;
    expect(ev.inputTokens).toBe(54_940); // 2 + 28890 + 26048
    expect(ev.cacheReadTokens).toBe(26_048);
    expect(ev.cacheCreationTokens).toBe(28_890);
    expect(ev.outputTokens).toBe(229);
    // The invariant cache_efficiency and trimCacheTokens both assume.
    expect(
      (ev.cacheReadTokens ?? 0) + (ev.cacheCreationTokens ?? 0),
    ).toBeLessThanOrEqual(ev.inputTokens);
  });

  it("emits request grain with no content and no cost", () => {
    const p = parser();
    p.parseLine(userLine("hello"));
    const ev = p.parseLine(assistantLine())!;
    expect(ev.grain).toBe("request");
    expect(ev.hasContent).toBe(false);
    expect(ev.content).toBeUndefined();
    expect(ev.costUsd).toBeNull();
    expect(ev.app).toBe("claude-code");
    expect(ev.provider).toBe("anthropic");
  });

  it("derives promptChars from the preceding user turn, not the reply", () => {
    const p = parser();
    const prompt = "x".repeat(25_000);
    p.parseLine(userLine(prompt));
    const ev = p.parseLine(assistantLine())!;
    // 25000, not 2 (the length of the assistant's "ok")
    expect(ev.features.promptChars).toBe(25_000);
    expect(ev.features.modelTier).toBe("frontier");
  });

  it("leaves a cache field undefined when the usage object omits it", () => {
    const p = parser();
    p.parseLine(userLine("hi"));
    const ev = p.parseLine(
      assistantLine({
        message: {
          role: "assistant",
          model: "claude-opus-5[1m]",
          content: "ok",
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      }),
    )!;
    expect(ev.inputTokens).toBe(100);
    expect(ev.cacheReadTokens).toBeUndefined(); // absent != recorded zero
    expect(ev.cacheCreationTokens).toBeUndefined();
  });

  it("records a genuine zero as zero", () => {
    const p = parser();
    p.parseLine(userLine("hi"));
    const ev = p.parseLine(
      assistantLine({
        message: {
          role: "assistant",
          model: "claude-opus-5[1m]",
          content: "ok",
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }),
    )!;
    expect(ev.cacheReadTokens).toBe(0);
    expect(ev.cacheCreationTokens).toBe(0);
  });

  it("omits sessionId on a sidechain turn so context_bloat skips it", () => {
    const p = parser();
    p.parseLine(userLine("hi"));
    const ev = p.parseLine(assistantLine({ isSidechain: true }))!;
    expect(ev.sessionId).toBeUndefined();
    expect(ev.inputTokens).toBe(54_940); // tokens still count as real spend
  });

  it("is idempotent: the same line yields the same eventId", () => {
    const a = parser();
    a.parseLine(userLine("hi"));
    const first = a.parseLine(assistantLine())!;
    const b = parser();
    b.parseLine(userLine("hi"));
    const second = b.parseLine(assistantLine())!;
    expect(first.eventId).toBe(second.eventId);
  });

  it("returns null for every non-assistant line type", () => {
    const p = parser();
    for (const type of [
      "user",
      "attachment",
      "system",
      "file-history-snapshot",
      "file-history-delta",
      "mode",
      "last-prompt",
      "ai-title",
      "queue-operation",
      "pr-link",
    ]) {
      expect(p.parseLine(JSON.stringify({ type, uuid: "x" }))).toBeNull();
    }
  });

  it("returns null rather than throwing on malformed input", () => {
    const p = parser();
    expect(p.parseLine("not json at all")).toBeNull();
    expect(p.parseLine("")).toBeNull();
    expect(p.parseLine(JSON.stringify({ type: "assistant" }))).toBeNull(); // no usage
    expect(
      p.parseLine(JSON.stringify({ type: "assistant", message: {} })),
    ).toBeNull();
  });

  it("sets newContentRatio from the previous turn's prompt size", () => {
    const p = parser();
    p.parseLine(userLine("y".repeat(10_000)));
    p.parseLine(assistantLine());
    p.parseLine(userLine("y".repeat(10_500), { uuid: "u-2" }));
    const ev = p.parseLine(assistantLine({ uuid: "a-2" }))!;
    expect(ev.features.newContentRatio).toBeDefined();
    // ~5% new content between 10000 and 10500 chars
    expect(ev.features.newContentRatio!).toBeLessThan(0.25);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tokenops/agent exec vitest run src/adapters/claude-session.test.ts`
Expected: FAIL — cannot resolve `./claude-session.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/agent/src/adapters/claude-session.ts`:

```ts
import {
  buildEventId,
  extractFeatures,
  getModelTier,
  type UsageEvent,
} from "@tokenops/shared";

const APP = "claude-code";
const PROVIDER = "anthropic";

/**
 * One line of a Claude Code session file. Every field is optional: the format
 * is not a published contract, so an unexpected shape must produce `null`
 * rather than a throw.
 */
export type ClaudeSessionLine = {
  type?: string;
  uuid?: string;
  requestId?: string;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
};

export type SessionParserOptions = {
  machineId: string;
  machineName: string;
};

export type SessionParser = {
  /** Returns an event for an assistant turn with usage; null for everything else. */
  parseLine(raw: string): UsageEvent | null;
};

/** Flatten Claude's content union (string | array of blocks) to plain text. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string") parts.push(b.text);
      else if (typeof b.content === "string") parts.push(b.content);
    }
  }
  return parts.join("");
}

/**
 * Turn a session file's lines into usage events.
 *
 * Stateful by necessity: an `assistant` line carries the model's REPLY, while
 * `extractFeatures` needs the PROMPT. The prompt for a turn is the preceding
 * `user` line, so the parser carries it forward — along with the previous
 * turn's promptChars, which is what produces `newContentRatio`, the signal
 * `context_bloat` gates on.
 *
 * Feed lines in file order. A parser instance belongs to one file.
 */
export function createSessionParser(
  opts: SessionParserOptions,
): SessionParser {
  let pendingPrompt = "";
  let priorPromptChars: number | undefined;

  return {
    parseLine(raw: string): UsageEvent | null {
      let line: ClaudeSessionLine;
      try {
        if (!raw.trim()) return null;
        line = JSON.parse(raw) as ClaudeSessionLine;
      } catch {
        return null;
      }

      if (line.type === "user") {
        pendingPrompt = contentToText(line.message?.content);
        return null;
      }

      if (line.type !== "assistant") return null;

      const usage = line.message?.usage;
      if (!usage) return null;

      const model = line.message?.model;
      const timestamp = line.timestamp;
      const uuid = line.uuid;
      if (!model || !timestamp || !uuid) return null;

      // Absent means "not recorded" and stays undefined on the event; a
      // recorded 0 stays 0. Folding uses ?? 0 for the TOTAL only — no cache
      // fields simply means no cache tokens contributed to it.
      const cacheReadTokens = usage.cache_read_input_tokens;
      const cacheCreationTokens = usage.cache_creation_input_tokens;
      const inputTokens =
        (usage.input_tokens ?? 0) +
        (cacheReadTokens ?? 0) +
        (cacheCreationTokens ?? 0);
      const outputTokens = usage.output_tokens ?? 0;

      const responseText = contentToText(line.message?.content);
      const features = extractFeatures({
        model,
        requestMessages: [{ role: "user", content: pendingPrompt }],
        responseText,
        sessionPriorPromptChars: priorPromptChars,
      });
      features.modelTier = getModelTier(model);

      priorPromptChars = pendingPrompt.length;
      pendingPrompt = "";

      const eventId = buildEventId({
        machineId: opts.machineId,
        app: APP,
        providerRequestId: line.requestId,
        fingerprint: uuid,
        timeBucketSec: Math.floor(Date.parse(timestamp) / 1000),
      });

      const event: UsageEvent = {
        eventId,
        timestamp,
        machineId: opts.machineId,
        machineName: opts.machineName,
        app: APP,
        provider: PROVIDER,
        model,
        inputTokens,
        outputTokens,
        costUsd: null,
        grain: "request",
        features,
        hasContent: false,
      };

      // A subagent turn shares the parent's sessionId but has its own
      // independent context. Interleaving it would corrupt context_bloat,
      // whose measurement is "input grew relative to the session's FIRST
      // request". Omitting sessionId lets contextBloatRule's existing guard
      // exclude it, while the tokens still reach the ledger as real spend.
      if (line.sessionId && line.isSidechain !== true) {
        event.sessionId = line.sessionId;
      }
      if (cacheReadTokens !== undefined) {
        event.cacheReadTokens = cacheReadTokens;
      }
      if (cacheCreationTokens !== undefined) {
        event.cacheCreationTokens = cacheCreationTokens;
      }

      return event;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tokenops/agent exec vitest run src/adapters/claude-session.test.ts`
Expected: PASS, 10 tests.

If `features.modelTier` assignment fails to type-check, `UsageFeatures` may declare it readonly — in that case build the object as `{ ...extractFeatures(...), modelTier: getModelTier(model) }` instead and say so in your report.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/adapters/claude-session.ts apps/agent/src/adapters/claude-session.test.ts
git commit -m "feat(agent): parse Claude Code session turns into usage events"
```

---

### Task 2: Per-file offset store

**Files:**
- Create: `apps/agent/src/adapters/session-offsets.ts`
- Create: `apps/agent/src/adapters/session-offsets.test.ts`

**Interfaces:**
- Consumes: `DatabaseSync` from `node:sqlite` (the same module `apps/agent/src/outbox.ts` uses — read it for the established pattern).
- Produces: `class SessionOffsets` with `get(path): { offset: number; size: number } | null`, `set(path, offset, size): void`, `close(): void`. Task 3 depends on these.

- [ ] **Step 1: Write the failing test**

Create `apps/agent/src/adapters/session-offsets.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionOffsets } from "./session-offsets.js";

const dirs: string[] = [];
const newDb = () => {
  const d = mkdtempSync(join(tmpdir(), "tokenops-offsets-"));
  dirs.push(d);
  return join(d, "offsets.db");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("SessionOffsets", () => {
  it("returns null for a file it has never seen", () => {
    const s = new SessionOffsets(newDb());
    expect(s.get("/some/file.jsonl")).toBeNull();
    s.close();
  });

  it("round-trips an offset", () => {
    const s = new SessionOffsets(newDb());
    s.set("/a.jsonl", 1234, 5000);
    expect(s.get("/a.jsonl")).toEqual({ offset: 1234, size: 5000 });
    s.close();
  });

  it("overwrites on repeat set", () => {
    const s = new SessionOffsets(newDb());
    s.set("/a.jsonl", 10, 100);
    s.set("/a.jsonl", 20, 200);
    expect(s.get("/a.jsonl")).toEqual({ offset: 20, size: 200 });
    s.close();
  });

  it("persists across instances so a restart resumes", () => {
    const path = newDb();
    const first = new SessionOffsets(path);
    first.set("/a.jsonl", 99, 500);
    first.close();

    const second = new SessionOffsets(path);
    expect(second.get("/a.jsonl")).toEqual({ offset: 99, size: 500 });
    second.close();
  });

  it("keeps separate offsets per file", () => {
    const s = new SessionOffsets(newDb());
    s.set("/a.jsonl", 1, 10);
    s.set("/b.jsonl", 2, 20);
    expect(s.get("/a.jsonl")).toEqual({ offset: 1, size: 10 });
    expect(s.get("/b.jsonl")).toEqual({ offset: 2, size: 20 });
    s.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tokenops/agent exec vitest run src/adapters/session-offsets.test.ts`
Expected: FAIL — cannot resolve `./session-offsets.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/agent/src/adapters/session-offsets.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tokenops/agent exec vitest run src/adapters/session-offsets.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/adapters/session-offsets.ts apps/agent/src/adapters/session-offsets.test.ts
git commit -m "feat(agent): persist per-file session read offsets"
```

---

### Task 3: Watcher — scan, backfill window, ceiling, tail

**Files:**
- Create: `apps/agent/src/adapters/claude-session-watcher.ts`
- Create: `apps/agent/src/adapters/claude-session-watcher.test.ts`
- Create: `apps/agent/test/fixtures/claude-session.jsonl`

**Interfaces:**
- Consumes: `createSessionParser` (Task 1), `SessionOffsets` (Task 2).
- Produces: `watchClaudeSessions(opts): { stop(): void }` where
  ```ts
  type WatchClaudeSessionsOptions = {
    rootDir: string;
    offsets: SessionOffsets;
    machineId: string;
    machineName: string;
    onEvent: (e: UsageEvent) => void;
    backfillDays?: number;      // default 7
    maxBackfillEvents?: number; // default MAX_BACKFILL_EVENTS
    pollMs?: number;            // default 5000
    log?: Pick<Console, "info">;
  };
  ```
  and `export const MAX_BACKFILL_EVENTS = 20_000;`. Task 5 depends on these.

- [ ] **Step 1: Create the fixture**

Create `apps/agent/test/fixtures/claude-session.jsonl` — one line each, no trailing newline issues:

```
{"type":"user","uuid":"u1","sessionId":"s1","timestamp":"2026-08-09T12:00:00.000Z","message":{"role":"user","content":"first prompt"}}
{"type":"assistant","uuid":"a1","requestId":"r1","sessionId":"s1","timestamp":"2026-08-09T12:00:01.000Z","message":{"role":"assistant","model":"claude-opus-5[1m]","content":"reply one","usage":{"input_tokens":2,"cache_creation_input_tokens":28890,"cache_read_input_tokens":26048,"output_tokens":229}}}
{"type":"ai-title","uuid":"t1","timestamp":"2026-08-09T12:00:02.000Z"}
{"type":"user","uuid":"u2","sessionId":"s1","timestamp":"2026-08-09T12:00:03.000Z","message":{"role":"user","content":"second prompt"}}
{"type":"assistant","uuid":"a2","requestId":"r2","sessionId":"s1","timestamp":"2026-08-09T12:00:04.000Z","message":{"role":"assistant","model":"claude-opus-5[1m]","content":"reply two","usage":{"input_tokens":5,"cache_read_input_tokens":40000,"output_tokens":100}}}
```

- [ ] **Step 2: Write the failing test**

Create `apps/agent/src/adapters/claude-session-watcher.test.ts`:

```ts
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
  return { base: d, root: join(d, "projects") , projectDir: root };
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
    log: { info: (m: unknown) => logs.push(String(m)) } as Console,
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
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @tokenops/agent exec vitest run src/adapters/claude-session-watcher.test.ts`
Expected: FAIL — cannot resolve `./claude-session-watcher.js`.

- [ ] **Step 4: Write the implementation**

Create `apps/agent/src/adapters/claude-session-watcher.ts`:

```ts
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { UsageEvent } from "@tokenops/shared";
import { createSessionParser } from "./claude-session.js";
import type { SessionOffsets } from "./session-offsets.js";

/**
 * First-run ceiling. Matches the back-test's own MAX_BACKTEST_EVENTS, so a
 * full backfill is exactly what one back-test window can consume; a larger
 * ceiling would ship events the headline figure could never reach.
 */
export const MAX_BACKFILL_EVENTS = 20_000;

const DEFAULT_BACKFILL_DAYS = 7;
const DEFAULT_POLL_MS = 5_000;

export type WatchClaudeSessionsOptions = {
  rootDir: string;
  offsets: SessionOffsets;
  machineId: string;
  machineName: string;
  onEvent: (e: UsageEvent) => void;
  backfillDays?: number;
  maxBackfillEvents?: number;
  /** 0 means "scan once and do not schedule" — used by tests. */
  pollMs?: number;
  log?: Pick<Console, "info">;
};

/** Every *.jsonl under rootDir, one level of project directories deep or more. */
function findSessionFiles(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory is missing data, not a crash
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(rootDir);
  return out;
}

/**
 * Read from `offset` to EOF and emit an event per complete assistant turn.
 * Returns the offset of the last complete line, so a partial final line is
 * re-read intact next poll rather than being consumed and lost.
 */
function readFrom(
  path: string,
  offset: number,
  size: number,
  parser: ReturnType<typeof createSessionParser>,
  emit: (e: UsageEvent) => boolean,
): number {
  if (size <= offset) return offset;
  const fd = openSync(path, "r");
  try {
    const length = size - offset;
    const buf = Buffer.allocUnsafe(length);
    readSync(fd, buf, 0, length, offset);
    const text = buf.toString("utf8");

    // Everything after the final newline is an incomplete line.
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) return offset;
    const complete = text.slice(0, lastNewline);

    for (const raw of complete.split("\n")) {
      const event = parser.parseLine(raw);
      if (!event) continue;
      if (!emit(event)) break; // ceiling reached
    }
    return offset + Buffer.byteLength(complete, "utf8") + 1;
  } finally {
    closeSync(fd);
  }
}

/**
 * Watch Claude Code's own session files and emit one event per assistant turn.
 *
 * Files older than the backfill window are never opened, so the ~1.4 GB on
 * disk is not parsed. Within the window, reading resumes from a persisted
 * per-file offset.
 */
export function watchClaudeSessions(
  opts: WatchClaudeSessionsOptions,
): { stop(): void } {
  const backfillDays = opts.backfillDays ?? DEFAULT_BACKFILL_DAYS;
  const ceiling = opts.maxBackfillEvents ?? MAX_BACKFILL_EVENTS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const log = opts.log ?? console;

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let emitted = 0;
  let ceilingLogged = false;

  const scan = (): void => {
    if (stopped) return;
    const cutoff = Date.now() - backfillDays * 24 * 3600 * 1000;
    let skipped = 0;

    for (const path of findSessionFiles(opts.rootDir)) {
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }

      const prior = opts.offsets.get(path);
      // Never open a file untouched since before the window — unless we have
      // already been reading it, in which case its tail is still live.
      if (!prior && st.mtimeMs < cutoff) continue;

      // A file smaller than its recorded offset was rotated or replaced.
      let offset = prior ? prior.offset : 0;
      if (st.size < offset) offset = 0;
      if (st.size === offset) continue;

      const parser = createSessionParser({
        machineId: opts.machineId,
        machineName: opts.machineName,
      });

      const next = readFrom(path, offset, st.size, parser, (event) => {
        if (emitted >= ceiling) {
          skipped += 1;
          return false;
        }
        opts.onEvent(event);
        emitted += 1;
        return true;
      });

      opts.offsets.set(path, next, st.size);

      if (emitted >= ceiling) {
        if (!ceilingLogged) {
          log.info(
            `[tokenops] session backfill hit the ${ceiling}-event ceiling; ` +
              `at least ${skipped} turn(s) skipped. Raise sources.claude_code_backfill_days ` +
              `after this batch drains, or accept the window as bounded.`,
          );
          ceilingLogged = true;
        }
        break;
      }
    }
  };

  scan();
  if (pollMs > 0) {
    timer = setInterval(scan, pollMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  return {
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tokenops/agent exec vitest run src/adapters/claude-session-watcher.test.ts`
Expected: PASS, 7 tests.

A parser instance is created per file per scan, which resets `pendingPrompt`. That is correct for resumed tails: the prompt for a turn read after a restart is not available, so `promptChars` reflects only what this scan saw. If the "picks up appended turns" test shows a surprising `promptChars`, that is why — assert on tokens there, not features.

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/adapters/claude-session-watcher.ts apps/agent/src/adapters/claude-session-watcher.test.ts apps/agent/test/fixtures/claude-session.jsonl
git commit -m "feat(agent): watch Claude Code session files with bounded backfill"
```

---

### Task 4: OTel guard

**Files:**
- Modify: `apps/agent/src/adapters/claude-otel.ts`
- Modify: `apps/agent/src/adapters/claude-otel.test.ts`

**Interfaces:**
- Produces: `ClaudeOtelServerOptions` gains `ignoreClaudeCodeMetrics?: boolean`. Task 5 passes it.

- [ ] **Step 1: Write the failing test**

Append to `apps/agent/src/adapters/claude-otel.test.ts` (reuse the file's existing body-building helper if one exists; otherwise this literal is self-contained):

```ts
import { extractClaudeCounters } from "./claude-otel.js";

const otlpBody = (metricName: string) => ({
  resourceMetrics: [
    {
      scopeMetrics: [
        {
          metrics: [
            {
              name: metricName,
              sum: {
                dataPoints: [
                  {
                    asInt: "100",
                    attributes: [
                      { key: "model", value: { stringValue: "claude-opus-5" } },
                      { key: "type", value: { stringValue: "input" } },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
});

describe("claude_code.* guard", () => {
  it("drops claude_code metrics when the session adapter owns the source", () => {
    const out = extractClaudeCounters(otlpBody("claude_code.token.usage"), {
      ignoreClaudeCodeMetrics: true,
    });
    expect(out.tokens).toHaveLength(0);
    expect(out.costs).toHaveLength(0);
  });

  it("keeps claude_code metrics when the session adapter is off", () => {
    const out = extractClaudeCounters(otlpBody("claude_code.token.usage"));
    expect(out.tokens).toHaveLength(1);
  });

  it("scopes the drop by prefix, not by substring", () => {
    // A `gen_ai.*` name would be a vacuous test: the extractor recognizes no
    // non-claude_code metric, so 0 tokens comes back whether the guard is a
    // precise prefix match or a blanket drop-everything. This name IS
    // recognized-adjacent: "claude_codex.token.usage" contains the substring
    // "claude_code" but does not START with "claude_code.". A sloppy
    // `name.includes("claude_code")` drops it and fails here; the correct
    // `startsWith("claude_code.")` leaves it alone.
    const body = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_codex.token.usage",
                  sum: {
                    dataPoints: [
                      {
                        asInt: "100",
                        attributes: [
                          { key: "model", value: { stringValue: "x" } },
                          { key: "type", value: { stringValue: "input" } },
                        ],
                      },
                    ],
                  },
                },
                {
                  name: "claude_code.token.usage",
                  sum: {
                    dataPoints: [
                      {
                        asInt: "50",
                        attributes: [
                          { key: "model", value: { stringValue: "y" } },
                          { key: "type", value: { stringValue: "input" } },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const guarded = extractClaudeCounters(body, {
      ignoreClaudeCodeMetrics: true,
    });
    // The claude_code.* one is dropped; claude_codex.* is not a claude_code
    // metric and was never collected by this extractor either — so assert on
    // what the guard removed, which is the only thing it controls.
    expect(guarded.tokens).toHaveLength(0);

    const unguarded = extractClaudeCounters(body);
    // Without the guard exactly one metric is collected: the real
    // claude_code.* one. That proves claude_codex.* was never in scope, and
    // that the guard removed precisely one entry rather than everything.
    expect(unguarded.tokens).toHaveLength(1);
    expect(unguarded.tokens[0]!.model).toBe("y");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tokenops/agent exec vitest run src/adapters/claude-otel.test.ts`
Expected: FAIL — `extractClaudeCounters` takes one argument.

- [ ] **Step 3: Implement the guard**

In `apps/agent/src/adapters/claude-otel.ts`:

Add an options parameter to `extractClaudeCounters`:

```ts
export type ExtractCountersOptions = {
  /**
   * Drop every `claude_code.*` metric. Set when the session-JSONL adapter
   * owns Claude Code capture.
   *
   * Both sources ingesting the same turns is the one failure this cutover
   * cannot recover from — a gap is re-readable from disk, a doubled ledger is
   * not. Enforcing it here rather than in config resolution means it is not a
   * state a user can configure their way into.
   */
  ignoreClaudeCodeMetrics?: boolean;
};

export function extractClaudeCounters(
  body: unknown,
  options: ExtractCountersOptions = {},
): { tokens: ...; costs: ... } {
```

Immediately after `const name = String(m.name ?? "");` inside the metric loop, add:

```ts
        if (options.ignoreClaudeCodeMetrics && name.startsWith("claude_code.")) {
          continue;
        }
```

Add `ignoreClaudeCodeMetrics?: boolean;` to `ClaudeOtelServerOptions`, thread it into the `extractClaudeCounters` call inside the request handler, and log once at server start when it is set:

```ts
  if (options.ignoreClaudeCodeMetrics) {
    console.info(
      "[tokenops] otel: claude_code.* metrics ignored — session JSONL adapter owns this source",
    );
  }
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @tokenops/agent test`
Expected: PASS. Existing OTEL tests call `extractClaudeCounters(body)` with one argument and must keep working — the options parameter defaults to `{}`.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/adapters/claude-otel.ts apps/agent/src/adapters/claude-otel.test.ts
git commit -m "fix(agent): drop claude_code.* OTLP metrics when the session adapter owns the source"
```

---

### Task 5: Config, wiring, and docs

**Files:**
- Modify: `apps/agent/src/config.ts`
- Modify: `apps/agent/src/config.test.ts`
- Modify: `apps/agent/src/agent-main.ts`
- Modify: `README.md`, `README.html`

**Interfaces:**
- Consumes: `watchClaudeSessions`, `MAX_BACKFILL_EVENTS` (Task 3); `SessionOffsets` (Task 2); `ignoreClaudeCodeMetrics` (Task 4).
- Produces: `TokenOpsConfig.sources.claudeCodeBackfillDays: number`.

- [ ] **Step 1: Write the failing config test**

Append to `apps/agent/src/config.test.ts`:

```ts
describe("session adapter config", () => {
  it("defaults claudeCodePath to the real Claude Code projects directory", () => {
    const c = defaultConfig();
    expect(c.sources.claudeCodePath).toMatch(/[\\/]\.claude[\\/]projects$/);
  });

  it("defaults the backfill window to 7 days", () => {
    expect(defaultConfig().sources.claudeCodeBackfillDays).toBe(7);
  });

  it("reads claude_code_backfill_days from TOML", () => {
    const parsed = parseConfigToml(`
[sources]
claude_code_backfill_days = 30
`);
    expect(parsed.sources.claudeCodeBackfillDays).toBe(30);
  });
});
```

Use whatever the file's existing import list and TOML-parsing helper are named — read the top of `config.test.ts` and match it rather than assuming `parseConfigToml`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tokenops/agent exec vitest run src/config.test.ts`
Expected: FAIL — `claudeCodeBackfillDays` does not exist.

- [ ] **Step 3: Extend config**

In `apps/agent/src/config.ts`:

- Add to the `sources` block of `TokenOpsConfig`:
  ```ts
    /** Days of existing session history to read on first run. 0 disables backfill. */
    claudeCodeBackfillDays: number;
  ```
- In `defaultConfig()`, set `claudeCodePath: join(homedir(), ".claude", "projects")` and `claudeCodeBackfillDays: 7`.
- Add `claude_code_backfill_days?: number;` to the `TomlSources` type and read it in the parser with the same `?? base.sources.…` fallback pattern the neighbouring fields use.

- [ ] **Step 4: Wire the watcher in `agent-main.ts`**

Inside the `if (config.sources.claudeCode) { … }` block, replace the `watchClaudeCodeLog` dynamic import path with the session watcher, keeping the existing dynamic-import + type-guard style the file already uses for adapters:

```ts
    const { SessionOffsets } = await import("./adapters/session-offsets.js");
    const { watchClaudeSessions } = await import(
      "./adapters/claude-session-watcher.js"
    );
    const offsets = new SessionOffsets(
      join(defaultTokenopsDir(), "session-offsets.db"),
    );
    const sessionWatcher = watchClaudeSessions({
      rootDir: config.sources.claudeCodePath,
      offsets,
      machineId,
      machineName: config.machine.name,
      onEvent,
      backfillDays: config.sources.claudeCodeBackfillDays,
    });
```

Register `sessionWatcher.stop()` and `offsets.close()` alongside the existing shutdown handling.

Then pass the guard where the OTEL server is started:

```ts
      otelServer = await startClaudeOtelServer({
        ...,
        ignoreClaudeCodeMetrics: config.sources.claudeCode,
      });
```

Leave `watchClaudeCodeLog` and `claude-code.ts` in place — retiring them is a follow-up in the spec, and deleting a working adapter on the same commit that replaces it removes the fallback before the new path has run against real data even once.

**Mark the retention explicitly**, so a reviewer reads intent rather than an oversight. Add at the top of `apps/agent/src/adapters/claude-code.ts`, above the existing imports:

```ts
/**
 * RETAINED WITH NO CALLER as of feat/claude-session-adapter.
 *
 * Superseded by claude-session-watcher.ts, which reads Claude Code's own
 * session files instead of a `~/.tokenops/claude-code-usage.jsonl` that
 * nothing writes. This module is kept as a working fallback until the new
 * adapter has proven itself against real session data; retiring it is a
 * follow-up in docs/superpowers/specs/2026-08-09-claude-session-adapter-design.md.
 *
 * Its tests still run and must keep passing.
 */
```

- [ ] **Step 5: Run the full bar**

Run: `pnpm -r build && pnpm -r test`
Expected: green end to end. Report the actual output.

- [ ] **Step 6: Document it**

In `README.md`, in the Claude Code section, replace the "Preferred: OpenTelemetry metrics" framing with the session-file source as the default, stating:

- the default path (`~/.claude/projects`) and that it is what Claude Code already writes — nothing to configure or install;
- that features are derived **on your machine** and only integers are sent, so no prompt text leaves the device regardless of privacy mode;
- `sources.claude_code_backfill_days` (default 7) and the 20,000-event first-run ceiling;
- that OTLP stays available for other emitters, and `claude_code.*` metrics are ignored while this source is on so nothing is double-counted;
- honestly, which rules this makes live: `context_bloat` and `full_document_io` fire; `frontier_trivial` does not, because it caps at 200 tokens and real turns are far larger.

Re-render:
```bash
node scripts/build-doc-html.mjs README.md README.html
```

- [ ] **Step 7: Commit**

```bash
git add apps/agent/src/config.ts apps/agent/src/config.test.ts apps/agent/src/agent-main.ts README.md README.html
git commit -m "feat(agent): wire the session adapter, guard OTEL, document the source"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Watch `~/.claude/projects/**/*.jsonl` | 3, 5 (default path) |
| One event per `assistant` turn, skip other line types | 1, 3 |
| Idempotence via `uuid` / `requestId` | 1 |
| `grain: "request"` | 1 |
| No content ships | 1 (`hasContent: false`, no `content`) |
| Token folding + subset invariant | 1 |
| `costUsd: null` | 1 |
| Features from real prompt text | 1 |
| Sidechain → `sessionId` omitted | 1 |
| Per-file offsets, resume across restart | 2 |
| Skip files older than the window by mtime | 3 |
| First-run ceiling `MAX_BACKFILL_EVENTS = 20_000` + disclosure log | 3 |
| Partial final line skipped, offset not advanced | 3 |
| Rotation / shrink handling | 3 |
| OTel guard, name-scoped, logged once | 4 |
| `sources.claude_code_backfill_days` (default 7) | 5 |
| Windows paths | 1–5 via `node:path`; exercised by the temp-dir tests |
| README honesty about which rules fire | 5 |

**Not covered by a task, deliberately:** tuning `CACHE_EFFICIENCY_MIN_READ_RATIO` and retiring the old `claude-code.ts` adapter are both listed as follow-ups in the spec, not requirements of this plan.

**Placeholder scan:** No TBD/TODO. Every code step carries real code. Two steps direct the implementer to match an existing file's conventions (`config.test.ts`'s TOML helper, `claude-otel.test.ts`'s body helper) rather than inventing a name — those are instructions to read, not gaps.

**Type consistency:** `createSessionParser` / `SessionParser` (Task 1) are consumed by name in Task 3. `SessionOffsets` with `get`/`set`/`close` (Task 2) matches Task 3's usage and Task 5's construction. `watchClaudeSessions` and `MAX_BACKFILL_EVENTS` (Task 3) match Task 5's import. `ignoreClaudeCodeMetrics` (Task 4) matches Task 5's call site. `claudeCodeBackfillDays` (Task 5) matches Task 3's `backfillDays` option.

**One known rough edge, flagged rather than hidden:** Task 3 creates a fresh parser per file per scan, so `pendingPrompt` resets between polls. A turn whose `user` line was read in an earlier scan gets `promptChars: 0`. This under-reports `full_document_io` on tails but never over-reports, and fixing it properly means persisting the last prompt alongside the offset. Raise it at review if the reviewer thinks the trade is wrong.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-09-claude-session-adapter.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
