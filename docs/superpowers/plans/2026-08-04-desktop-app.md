# TokenOps Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the agent's console window with an Electron tray app and a live local status window.

**Architecture:** A new `apps/desktop` Electron package. The main process runs the existing agent in-process by calling `runAgent()` from `@tokenops/agent` — no second runtime, no child process. A new pure module reads local rollups straight out of the agent's SQLite outbox. The renderer is React, receives plain data over a narrow `contextBridge`, and never touches Node, SQLite, or credentials.

**Tech Stack:** Electron, electron-builder (NSIS), React 19 + Vite, `node:sqlite`, Vitest.

> **Correction (found during Task 1):** an earlier draft of this plan named
> `better-sqlite3`. That package is not used anywhere in this repo. `outbox.ts`
> imports `DatabaseSync` from Node's built-in **`node:sqlite`**, deliberately, to
> avoid requiring native build tooling. Any new SQLite code must use
> `node:sqlite` and must not add a dependency.

**Spec:** `docs/superpowers/specs/2026-08-04-desktop-app-design.md`

## Global Constraints

- Package manager is **pnpm 9.15.0**; Node **22**. Use `pnpm --filter <pkg>` for per-package commands.
- Run the full suite with `pnpm test` from the repo root. It must be GREEN at every commit.
- Tests must never make network calls, and must never require a running Electron instance.
- Commit messages use Conventional Commits. End every commit body with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Relative TypeScript imports carry `.js` extensions. Match the surrounding files.
- **The renderer never receives the ingest PAT or any provider API key.** It may learn whether a key is *present*; never its value.
- **Closing the window hides to tray. Only Quit stops capture.** This is the console-window failure being corrected; do not soften it.

## Spec correction adopted here

The spec says `agent-main.ts` is CLI-shaped and must gain a programmatic
`startAgent()` API. **That is wrong — the API already exists** and is better
than what the spec proposed:

```ts
export async function runAgent(options?: RunAgentOptions): Promise<AgentHandle>;

export type RunAgentOptions = {
  configPath?: string;
  tokenopsDir?: string;
  flushIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /** When true, do not register process signal handlers. Caller must call stop(). */
  detach?: boolean;
};

export type AgentHandle = {
  outbox: Outbox;
  config: TokenOpsConfig;
  machineId: string;
  machineName: string;
  stop: () => Promise<void>;
  tick: () => Promise<void>;
};
```

`detach: true` is exactly what an embedding host needs — it suppresses the
signal handlers the CLI installs, leaving lifecycle to the caller. **No refactor
of the agent is required**, which removes an entire task from this plan.

## File Structure

**Created**

| File | Responsibility |
|------|----------------|
| `apps/agent/src/local-stats.ts` | Pure SQLite-in / object-out rollups from the outbox |
| `apps/agent/src/local-stats.test.ts` | Unit tests over a seeded temp database |
| `apps/desktop/package.json` | Electron package manifest |
| `apps/desktop/src/main/index.ts` | App lifecycle, owns the `AgentHandle` |
| `apps/desktop/src/main/window.ts` | Window creation, close-hides behaviour |
| `apps/desktop/src/main/tray.ts` | Tray icon, state, context menu |
| `apps/desktop/src/main/ipc.ts` | Typed IPC handlers; the only main-side surface the renderer can reach |
| `apps/desktop/src/preload/index.ts` | `contextBridge` API, explicitly enumerated |
| `apps/desktop/src/renderer/App.tsx` | The single live view |
| `apps/desktop/src/renderer/*.test.tsx` | Component tests against fixture data |
| `apps/desktop/build/icon.ico` | Tray + installer icon |

**Modified**

| File | Change |
|------|--------|
| `.github/workflows/ci.yml` | Replace the `installer-windows` job with a desktop packaging job |
| `README.md`, `README.html` | Desktop app install; drop the Node 22 prerequisite |

**Deleted**

`installer/windows/TokenOpsAgent.iss`, `apps/agent/test/installer-iss.test.ts`.

---

### Task 1: Local statistics from the outbox

The window's numbers all come from here. It is deliberately a pure module in the
agent package, not in Electron, so it is testable without a UI.

This is cheap because of an existing property: `markSent` sets `status = 'sent'`
rather than deleting rows (`apps/agent/src/outbox.ts:76-79`), so sent events keep
their payloads.

**Files:**
- Create: `apps/agent/src/local-stats.ts`
- Create: `apps/agent/src/local-stats.test.ts`

**Interfaces:**
- Consumes: the outbox schema — `outbox(event_id, payload, status, attempts, last_error, created_at)`, where `payload` is a JSON `UsageEvent` carrying `timestamp` (ISO string), `app`, `model`, `inputTokens`, `outputTokens`, `costUsd` (nullable number).
- Produces:
  ```ts
  export type LocalStats = {
    today: { inputTokens: number; outputTokens: number; estimatedUsd: number; eventCount: number };
    byApp: Array<{ app: string; inputTokens: number; outputTokens: number }>;
    byModel: Array<{ model: string; inputTokens: number; outputTokens: number }>;
    queue: { pending: number; lastError: string | null };
    recent: Array<{ at: string; app: string; model: string; inputTokens: number; outputTokens: number }>;
  };
  export function readLocalStats(dbPath: string, now?: Date): LocalStats;
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/agent/src/local-stats.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Outbox } from "./outbox.js";
import { readLocalStats } from "./local-stats.js";

let dir: string;
let dbPath: string;

function event(over: Partial<Record<string, unknown>> = {}) {
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
    features: {},
    ...over,
  } as never;
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

  it("counts sent events, not just pending ones", () => {
    const outbox = new Outbox(dbPath);
    const e = event();
    outbox.enqueue(e);
    outbox.markSent([(e as { eventId: string }).eventId]);
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

  it("skips malformed payload rows instead of throwing", () => {
    const outbox = new Outbox(dbPath);
    outbox.enqueue(event());
    outbox.close();

    // Corrupt one row directly, the way a partial write would.
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO outbox (event_id, payload, status, attempts, last_error, created_at)
       VALUES ('bad', 'not json', 'pending', 0, NULL, ?)`,
    ).run(new Date().toISOString());
    db.close();

    const stats = readLocalStats(dbPath, now);
    expect(stats.today.eventCount).toBe(1);
  });

  it("reports queue depth and the latest error", () => {
    const outbox = new Outbox(dbPath);
    const e = event();
    outbox.enqueue(e);
    outbox.markFailed((e as { eventId: string }).eventId, "cloud unreachable");
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
```

> The malformed-row test uses a dynamic `import`, so mark that single test's
> callback `async`. If `better-sqlite3` is not directly importable from the
> agent package, add it to `apps/agent/package.json` dependencies — the outbox
> already depends on it transitively.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @tokenops/agent test -- local-stats`

Expected: FAIL — module `./local-stats.js` not found.

- [ ] **Step 3: Implement the module**

Create `apps/agent/src/local-stats.ts`:

```ts
import Database from "better-sqlite3";

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

type Row = { payload: string };

/** Local-day boundary, so "today" matches what the user's clock shows. */
function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Read rollups directly from the agent's outbox.
 *
 * Counts BOTH pending and sent rows. `markSent` only flips a status flag, so
 * sent events keep their payloads — that is what makes a local "today" total
 * possible without a second table. It also means this table grows without
 * bound, so every query here is bounded by date or LIMIT.
 */
export function readLocalStats(dbPath: string, now: Date = new Date()): LocalStats {
  const db = new Database(dbPath, { readonly: true, fileMustExist: false });
  try {
    const since = startOfLocalDay(now).toISOString();

    const rows = db
      .prepare(
        `SELECT payload FROM outbox
         WHERE json_valid(payload)
           AND json_extract(payload, '$.timestamp') >= ?
         ORDER BY json_extract(payload, '$.timestamp') DESC`,
      )
      .all(since) as Row[];

    const today = { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, eventCount: 0 };
    const byApp = new Map<string, { inputTokens: number; outputTokens: number }>();
    const byModel = new Map<string, { inputTokens: number; outputTokens: number }>();
    const recent: LocalStats["recent"] = [];

    for (const row of rows) {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        continue; // A partially written row must not take the window down.
      }

      const input = Number(e.inputTokens) || 0;
      const output = Number(e.outputTokens) || 0;
      const app = typeof e.app === "string" ? e.app : "unknown";
      const model = typeof e.model === "string" ? e.model : "unknown";
      const at = typeof e.timestamp === "string" ? e.timestamp : "";

      today.inputTokens += input;
      today.outputTokens += output;
      today.estimatedUsd += Number(e.costUsd) || 0; // costUsd is nullable
      today.eventCount += 1;

      const a = byApp.get(app) ?? { inputTokens: 0, outputTokens: 0 };
      a.inputTokens += input;
      a.outputTokens += output;
      byApp.set(app, a);

      const m = byModel.get(model) ?? { inputTokens: 0, outputTokens: 0 };
      m.inputTokens += input;
      m.outputTokens += output;
      byModel.set(model, m);

      if (recent.length < 20) {
        recent.push({ at, app, model, inputTokens: input, outputTokens: output });
      }
    }

    const pending = (
      db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`).get() as
        | { n: number }
        | undefined
    )?.n ?? 0;

    const lastError = (
      db
        .prepare(
          `SELECT last_error FROM outbox
           WHERE status = 'pending' AND last_error IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get() as { last_error: string } | undefined
    )?.last_error ?? null;

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
```

> If the `outbox` table does not exist yet (agent never run), the first query
> throws. Wrap the body in a try/catch that returns an all-zero `LocalStats` on
> `SQLITE_ERROR: no such table`, and add a test for it.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @tokenops/agent test -- local-stats`

Expected: PASS, all cases.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/local-stats.ts apps/agent/src/local-stats.test.ts apps/agent/package.json
git commit -m "feat(agent): read local rollups from the outbox

Counts sent rows as well as pending ones: markSent only flips a status flag,
so sent events keep their payloads and today's totals need no second table.
Malformed payload rows are skipped rather than thrown, and every query is
bounded by date or LIMIT because nothing prunes this table yet.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Electron shell that runs the agent in-process

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/tsconfig.json`, `apps/desktop/vite.config.ts`
- Create: `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/window.ts`
- Create: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/renderer/index.html`, `apps/desktop/src/renderer/main.tsx`, `apps/desktop/src/renderer/App.tsx`

**Interfaces:**
- Consumes: `runAgent`, `AgentHandle` from `@tokenops/agent`
- Produces: `export async function startDesktopAgent(): Promise<AgentHandle>` from `src/main/index.ts`; `createMainWindow(): BrowserWindow` from `src/main/window.ts`

- [ ] **Step 1: Scaffold the package**

Run:

```bash
pnpm --filter @tokenops/desktop add -D electron electron-builder vite @vitejs/plugin-react typescript vitest
pnpm --filter @tokenops/desktop add react react-dom @tokenops/agent@workspace:^
```

Create `apps/desktop/package.json` with `"name": "@tokenops/desktop"`, `"private": true`, `"main": "dist/main/index.js"`, and scripts `build` (tsc + vite build), `test` (`vitest run --passWithNoTests`), `start` (`electron .`).

- [ ] **Step 2: Start the agent from the main process**

Create `apps/desktop/src/main/index.ts`:

```ts
import { app, BrowserWindow } from "electron";
import { runAgent, type AgentHandle } from "@tokenops/agent";
import { createMainWindow } from "./window.js";

let agent: AgentHandle | null = null;
let win: BrowserWindow | null = null;

/**
 * `detach: true` suppresses the signal handlers the CLI installs. Lifecycle is
 * ours: nothing stops capture except an explicit quit.
 */
export async function startDesktopAgent(): Promise<AgentHandle> {
  return runAgent({ detach: true });
}

app.whenReady().then(async () => {
  agent = await startDesktopAgent();
  win = createMainWindow();
});

// Electron invokes before-quit listeners SYNCHRONOUSLY and ignores their
// return value, so an `async` listener's promise is discarded and the process
// exits while stop() is still running. The only way to hold up a quit is
// preventDefault(), then quit again once teardown finishes. This matters
// because stop() closes the OTEL server, then the proxy (both wait for
// in-flight connections to drain), and only then the SQLite outbox.
// Three states, not two. `if (quitting) return` is WRONG: a second quit
// (the tray survives, and nothing visibly happens while stop() drains, so a
// user clicks it again) re-fires before-quit, takes that early return WITHOUT
// calling preventDefault(), and Electron proceeds to exit — while the first
// quit's teardown is still in flight. That silently drops capture data: the
// exact bug this app exists to fix, one level down.
type QuitPhase = "running" | "stopping" | "stopped";
let phase: QuitPhase = "running";

app.on("before-quit", (event) => {
  if (phase === "stopped") return; // teardown finished; let this quit through

  event.preventDefault(); // hold the quit while stopping, on EVERY call
  if (phase === "stopping") return; // teardown already running; do not restart it

  phase = "stopping";
  void (async () => {
    try {
      await agent?.stop();
      console.log("[tokenops] agent stopped cleanly");
    } finally {
      agent = null;
      phase = "stopped";
      app.quit();
    }
  })();
});
```

> **Do not verify this with "is port 8787 free after exit?"** The OS reclaims
> listening sockets on process termination whether or not `close()` ever ran, so
> that check reads identically whether shutdown worked or never happened. Prove
> it by observing that teardown completed — e.g. a log line emitted after
> `stop()` resolves appears before the process exits.

- [ ] **Step 3: Create the window with hardened defaults**

Create `apps/desktop/src/main/window.ts`:

```ts
import { BrowserWindow, shell } from "electron";
import { join } from "node:path";

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 920,
    height: 640,
    show: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // External links belong in the user's browser, never in an Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  void win.loadFile(join(__dirname, "../renderer/index.html"));
  return win;
}
```

- [ ] **Step 4: Add a placeholder renderer**

Create `apps/desktop/src/renderer/App.tsx` rendering a single heading, `TokenOps`, and the text `Agent running`. Real content arrives in Task 4 — this step only proves the shell boots.

- [ ] **Step 5: Verify it launches**

Run: `pnpm --filter @tokenops/desktop build && pnpm --filter @tokenops/desktop start`

Expected: a window opens showing "Agent running", and the terminal shows the agent's usual startup lines (proxy listening, OTEL listening). Close the window and confirm the process exits.

- [ ] **Step 6: Run the full suite and commit**

Run: `pnpm test`

```bash
git add apps/desktop pnpm-lock.yaml
git commit -m "feat(desktop): Electron shell running the agent in-process

Uses the agent's existing runAgent({ detach: true }) rather than spawning a
second Node: detach suppresses the CLI's signal handlers and leaves lifecycle
to the host. Renderer is sandboxed with contextIsolation and no nodeIntegration.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Tray icon and lifecycle

The behaviour that fixes the original complaint lives here.

**Files:**
- Create: `apps/desktop/src/main/tray.ts`, `apps/desktop/build/icon.ico`
- Modify: `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/window.ts`

**Interfaces:**
- Consumes: `createMainWindow` (Task 2), `AgentHandle` (Task 2)
- Produces: `export function createTray(opts: { onShow: () => void; onQuit: () => void }): Tray`

- [ ] **Step 1: Add the icon**

Create `apps/desktop/build/icon.ico` — a 256×256 ICO. Generate a simple mark; do not ship a placeholder that says "TODO".

- [ ] **Step 2: Make closing the window hide it**

In `apps/desktop/src/main/window.ts`, inside `createMainWindow`, before returning:

```ts
  // Closing must NOT stop capture — that is the console-window behaviour this
  // app exists to replace. Only an explicit Quit ends the agent.
  win.on("close", (event) => {
    if (!(global as { isQuitting?: boolean }).isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
```

- [ ] **Step 3: Create the tray**

Create `apps/desktop/src/main/tray.ts`:

```ts
import { Menu, Tray, nativeImage, shell } from "electron";
import { join } from "node:path";
import { homedir } from "node:os";

export function createTray(opts: {
  onShow: () => void;
  onQuit: () => void;
}): Tray {
  const icon = nativeImage.createFromPath(
    join(__dirname, "../../build/icon.ico"),
  );
  const tray = new Tray(icon);
  tray.setToolTip("TokenOps — capturing");

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show TokenOps", click: opts.onShow },
      {
        label: "Open config folder",
        click: () => void shell.openPath(join(homedir(), ".tokenops")),
      },
      { type: "separator" },
      { label: "Quit", click: opts.onQuit },
    ]),
  );

  tray.on("click", opts.onShow);
  return tray;
}
```

> **Deliberate omission:** the spec's tray menu listed "Pause capture". It is
> dropped here. Pausing means stopping and restarting the agent, which forces
> the tray, window, and IPC layers all to handle a null `AgentHandle` — real
> lifecycle complexity for a feature Quit already covers. Add it later if the
> need proves real; do not add it speculatively.

- [ ] **Step 4: Wire it up**

In `apps/desktop/src/main/index.ts`, after creating the window:

```ts
  tray = createTray({
    onShow: () => {
      win?.show();
      win?.focus();
    },
    onQuit: () => {
      (global as { isQuitting?: boolean }).isQuitting = true;
      app.quit();
    },
  });
```

Also remove any `app.on("window-all-closed", () => app.quit())` if present — that would defeat hide-to-tray.

- [ ] **Step 5: Verify the behaviour by hand**

Run: `pnpm --filter @tokenops/desktop start`

Check all four:
1. Closing the window hides it; the tray icon remains.
2. Clicking the tray icon brings the window back.
3. The agent is still capturing while the window is hidden — confirm the proxy still answers on `127.0.0.1:8787`.
4. Tray → Quit exits the process and releases port 8787.

- [ ] **Step 6: Run the full suite and commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): tray icon, and closing hides instead of quitting

Closing the window stopping capture is the exact console-window failure this
app replaces, so close is intercepted and only an explicit Quit stops the
agent and releases the proxy port.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Live status window

**Files:**
- Create: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/App.tsx`
- Create: `apps/desktop/src/renderer/App.test.tsx`

**Interfaces:**
- Consumes: `readLocalStats`, `LocalStats` (Task 1); `AgentHandle` (Task 2)
- Produces: `window.tokenops` in the renderer:
  ```ts
  type DesktopApi = {
    getStats(): Promise<LocalStats>;
    getStatus(): Promise<AgentStatus>;
    openDashboard(): void;
    openConfigFolder(): void;
  };
  type AgentStatus = {
    machineName: string;
    cloudUrl: string;
    ingestTokenPresent: boolean;   // never the value
    upstreamKeyPresent: boolean;   // never the value
    proxyListen: string | null;
    otelListen: string | null;
    claudeCodeWatching: boolean;
  };
  ```

- [ ] **Step 1: Add the IPC handlers**

Create `apps/desktop/src/main/ipc.ts`:

```ts
import { ipcMain, shell } from "electron";
import { readLocalStats } from "@tokenops/agent";
import type { AgentHandle } from "@tokenops/agent";
import { join } from "node:path";
import { homedir } from "node:os";

export function registerIpc(getAgent: () => AgentHandle | null): void {
  ipcMain.handle("tokenops:stats", () => {
    const agent = getAgent();
    if (!agent) throw new Error("agent not started");
    return readLocalStats(join(homedir(), ".tokenops", "outbox.db"));
  });

  ipcMain.handle("tokenops:status", () => {
    const agent = getAgent();
    if (!agent) throw new Error("agent not started");
    const { config, machineName } = agent;
    // Presence only. Neither the PAT nor the provider key crosses this line.
    return {
      machineName,
      cloudUrl: config.cloud.url,
      ingestTokenPresent: Boolean(config.cloud.ingestToken),
      upstreamKeyPresent: Boolean(
        process.env.OPENAI_API_KEY || process.env.XAI_API_KEY,
      ),
      proxyListen: config.sources.openaiProxy ? config.proxy.listen : null,
      otelListen: config.sources.claudeCode
        ? config.sources.claudeCodeOtelListen || null
        : null,
      claudeCodeWatching: config.sources.claudeCode,
    };
  });

  ipcMain.on("tokenops:open-dashboard", (_e, url: string) => {
    void shell.openExternal(url);
  });

  ipcMain.on("tokenops:open-config", () => {
    void shell.openPath(join(homedir(), ".tokenops"));
  });
}
```

> Export `readLocalStats` from `apps/agent/src/index.ts` if it is not already
> exported, so the desktop package can import it from `@tokenops/agent`.

- [ ] **Step 2: Expose a narrow preload API**

Replace `apps/desktop/src/preload/index.ts`:

```ts
import { contextBridge, ipcRenderer } from "electron";

// Every call is enumerated. Do not add a generic invoke(channel, ...) bridge —
// that hands the renderer the whole main process.
contextBridge.exposeInMainWorld("tokenops", {
  getStats: () => ipcRenderer.invoke("tokenops:stats"),
  getStatus: () => ipcRenderer.invoke("tokenops:status"),
  openDashboard: (url: string) => ipcRenderer.send("tokenops:open-dashboard", url),
  openConfigFolder: () => ipcRenderer.send("tokenops:open-config"),
});
```

- [ ] **Step 3: Write the failing renderer tests**

Create `apps/desktop/src/renderer/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

const stats = {
  today: { inputTokens: 1200, outputTokens: 340, estimatedUsd: 0.0123, eventCount: 7 },
  byApp: [{ app: "claude-code", inputTokens: 1200, outputTokens: 340 }],
  byModel: [{ model: "claude-sonnet-4", inputTokens: 1200, outputTokens: 340 }],
  queue: { pending: 0, lastError: null },
  recent: [],
};

const baseStatus = {
  machineName: "KENDESKTOP",
  cloudUrl: "https://tokenops-web-production.up.railway.app",
  ingestTokenPresent: true,
  upstreamKeyPresent: true,
  proxyListen: "127.0.0.1:8787",
  otelListen: "127.0.0.1:4318",
  claudeCodeWatching: true,
};

function mockApi(over: Partial<typeof baseStatus> = {}, s = stats) {
  (globalThis as never as { tokenops: unknown }).tokenops = {
    getStats: vi.fn().mockResolvedValue(s),
    getStatus: vi.fn().mockResolvedValue({ ...baseStatus, ...over }),
    openDashboard: vi.fn(),
    openConfigFolder: vi.fn(),
  };
}

describe("App", () => {
  it("shows today's token totals", async () => {
    mockApi();
    render(<App />);
    expect(await screen.findByText(/1,200/)).toBeInTheDocument();
  });

  it("warns when the proxy has no upstream key", async () => {
    mockApi({ upstreamKeyPresent: false });
    render(<App />);
    expect(await screen.findByText(/upstream calls will fail/i)).toBeInTheDocument();
  });

  it("warns when no ingest token is set", async () => {
    mockApi({ ingestTokenPresent: false });
    render(<App />);
    expect(await screen.findByText(/not shipping to the cloud/i)).toBeInTheDocument();
  });

  it("surfaces a queue error", async () => {
    mockApi({}, { ...stats, queue: { pending: 4, lastError: "cloud unreachable" } });
    render(<App />);
    expect(await screen.findByText(/cloud unreachable/i)).toBeInTheDocument();
  });
});
```

Install the test deps: `pnpm --filter @tokenops/desktop add -D @testing-library/react @testing-library/jest-dom jsdom`, and set `environment: "jsdom"` in the package's vitest config.

- [ ] **Step 4: Run the tests and confirm they fail**

Run: `pnpm --filter @tokenops/desktop test`

Expected: FAIL — `App` renders only the placeholder.

- [ ] **Step 5: Build the real view**

Rewrite `apps/desktop/src/renderer/App.tsx` to poll `getStats()` and `getStatus()` every 2 seconds and render:

- A header with machine name and cloud URL
- Capture-path rows for proxy / OTEL / JSONL, each showing listen address and health. When `upstreamKeyPresent` is false, the proxy row reads **"no upstream API key — upstream calls will fail auth"**. When `ingestTokenPresent` is false, show **"not shipping to the cloud — no ingest token"**.
- Today's totals: input tokens, output tokens, estimated USD, event count, formatted with `toLocaleString()`
- Breakdown tables for `byApp` and `byModel`
- Queue: pending count, and `queue.lastError` when non-null
- Recent activity from `stats.recent`
- Buttons calling `openDashboard(status.cloudUrl)` and `openConfigFolder()`

- [ ] **Step 6: Run the tests and the full suite**

Run: `pnpm --filter @tokenops/desktop test` then `pnpm test`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): live local status window

Surfaces the two failure states the console window printed once and lost: a
missing upstream API key, and a missing ingest token. The renderer learns only
whether each credential is present, never its value.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Package with electron-builder, and retire the Inno installer

**Files:**
- Create: `apps/desktop/electron-builder.yml`, `apps/desktop/build/installer.nsh`
- Modify: `.github/workflows/ci.yml`
- Delete: `installer/windows/TokenOpsAgent.iss`, `apps/agent/test/installer-iss.test.ts`

**Interfaces:**
- Consumes: the built `apps/desktop/dist`
- Produces: `dist/TokenOps-Setup-<version>.exe`

- [ ] **Step 1: Configure electron-builder**

Create `apps/desktop/electron-builder.yml`:

```yaml
appId: com.tokenops.desktop
productName: TokenOps
directories:
  buildResources: build
  output: ../../dist
win:
  target: nsis
  icon: build/icon.ico
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  include: build/installer.nsh
```

- [ ] **Step 2: Clean up the old install during setup**

Create `apps/desktop/build/installer.nsh`:

```nsis
; An existing Inno install leaves a TokenOpsAgent logon task behind. If it runs
; alongside this app, the loser fails to bind 127.0.0.1:8787 and its proxy dies
; quietly while everything else looks healthy. Remove it before first run.
;
; ~/.tokenops/config.toml and machine.json are deliberately left alone: keeping
; machine.json is what keeps this machine's existing history attached to it.
!macro customInstall
  nsExec::Exec 'schtasks /Delete /TN "TokenOpsAgent" /F'
  DeleteRegValue HKCU "Environment" "TOKENOPS_HOME"
!macroend
```

Removing the stale `%LOCALAPPDATA%\TokenOps\bin` PATH entry needs a read-modify-write of the user `Path`; do it here with `EnVar::DeleteValue` or an equivalent, and verify by opening a fresh terminal after install and confirming `where tokenops` no longer resolves to the old path.

- [ ] **Step 3: Delete the Inno installer and its guard**

```bash
git rm installer/windows/TokenOpsAgent.iss apps/agent/test/installer-iss.test.ts
```

- [ ] **Step 4: Replace the CI job**

In `.github/workflows/ci.yml`, replace the `installer-windows` job body: drop the `choco install innosetup` step and the `pnpm package:agent` step, and instead run `pnpm --filter @tokenops/desktop build` then `pnpm --filter @tokenops/desktop exec electron-builder --win --publish never`. Keep the existing assertion pattern — verify the `.exe` actually exists rather than trusting the exit code:

```yaml
      - name: Verify installer was produced
        shell: pwsh
        run: |
          $exe = Get-ChildItem dist -Filter "TokenOps-Setup-*.exe" -ErrorAction SilentlyContinue
          if (-not $exe) { throw "electron-builder produced no installer" }
          Get-Item $exe.FullName | Format-List Name, Length
```

- [ ] **Step 5: Build the installer locally**

Run: `pnpm --filter @tokenops/desktop build && pnpm --filter @tokenops/desktop exec electron-builder --win --publish never`

Expected: `dist/TokenOps-Setup-<version>.exe` exists.

- [ ] **Step 6: Verify the migration on this machine**

This machine has a live Inno install. Before installing, record the state:

```powershell
schtasks /Query /TN "TokenOpsAgent"
Get-Content "$env:USERPROFILE\.tokenops\machine.json"
```

Install, then confirm: the scheduled task is gone, `machine.json` is byte-identical, and only one process holds `127.0.0.1:8787`.

- [ ] **Step 7: Run the full suite and commit**

```bash
git add -A
git commit -m "feat(desktop): package with electron-builder, retire the Inno installer

Electron bundles its own Node, so the installer no longer requires Node 22 --
which previously blocked the install before it started.

Setup removes the TokenOpsAgent logon task from any prior Inno install: left in
place it races the new app for 127.0.0.1:8787 and the loser's proxy dies
quietly. config.toml and machine.json are preserved so the machine keeps its
identity and history.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md`, then regenerate `README.html`

- [ ] **Step 1: Rewrite the desktop-agent install section**

Replace the Inno instructions. State that the desktop app is the primary download, that **Node.js is no longer required**, and that the portable ZIP remains for headless or server installs where no GUI is wanted. Document tray behaviour explicitly: closing the window hides to tray and capture continues; Quit is the only thing that stops it.

- [ ] **Step 2: Correct anything the retirement invalidated**

Grep for stale references and fix each: `grep -rn "Inno\|TokenOps-Agent-Setup\|Node.js 22\|node 22" README.md`.

- [ ] **Step 3: Regenerate the HTML**

Run: `node scripts/build-doc-html.mjs README.md README.html`

- [ ] **Step 4: Run the full suite and commit**

```bash
git add README.md README.html
git commit -m "docs: desktop app install, and drop the Node 22 prerequisite

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Post-merge

1. **Prune sent outbox rows.** Nothing deletes them today, so the file grows without bound. The desktop window makes this visible; a retention policy should follow.
2. **Code signing.** The NSIS installer is unsigned, so SmartScreen warns exactly as the Inno one did. Larger binary, same problem.
3. **macOS build.** Electron makes it possible; tray behaviour and CI are Windows-only today.
4. **Auto-update.** electron-builder supports it; out of scope here.
