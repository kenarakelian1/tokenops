# TokenOps desktop app — design

**Date:** 2026-08-04
**Status:** Approved, not yet implemented

## Problem

The agent runs as `tokenops agent run` in a console window. That window is the
entire local interface, and it is bad at both jobs it has.

As a surface, it is a black `cmd` box that sits in the taskbar for as long as
capture is running. Closing it stops capture, and nothing indicates that.

As a display, it prints startup lines and then goes quiet. A real session looks
like this:

```
[tokenops] no upstream API key, proxy will start but upstream calls will fail auth
[tokenops] proxy listening on 127.0.0.1:8787 -> https://api.openai.com
[tokenops] claude-code adapter watching C:\Users\Ken\.tokenops\claude-code-usage.jsonl
[tokenops] Claude Code OTEL metrics listening on 127.0.0.1:4318
```

Everything after that — whether anything was captured, how many events are
queued, whether shipping to the cloud is failing — requires quitting or opening
a second terminal to run `tokenops status`. The warning on line one is the kind
of thing a person reads once and never sees again, even though it means every
proxied call will fail.

There is a second, larger problem hiding behind this. The installer refuses to
proceed without Node.js 22 on PATH, so the first thing a new user meets is a
prerequisite download.

## Decision

Ship an Electron desktop app: a tray icon plus a real window showing live local
state. Electron's main process runs the existing agent code **in-process** by
importing `@tokenops/agent` — no second runtime, no child process, no IPC to a
separate Node.

Two alternatives were considered:

- **Tauri** produces a far smaller binary using the WebView2 already present on
  Windows 11. Rejected because Tauri is Rust and the agent is Node, so Node
  would ship as a sidecar regardless — two runtimes, erasing the size advantage,
  plus Rust in CI.
- **No new runtime** — serve a status page on `127.0.0.1` and run the agent
  hidden via the existing logon task. Smallest possible change, but the "window"
  is a browser tab, and a real tray icon needs a third-party helper binary that
  tends to trip antivirus.

**Accepted cost:** the installer grows from roughly 2.5 MB to 90–120 MB.

**Unlocked benefit:** Electron bundles its own Node, so the Node 22 prerequisite
disappears. The install stops failing before it starts.

## Non-goals

- **Cloud data in the window.** Local state only; a button opens the cloud
  dashboard in a browser. Re-implementing the ledger, history, and
  recommendations twice is the thing this design most wants to avoid.
- **macOS and Linux builds.** Electron makes them possible later. The installer,
  tray behaviour, and CI are Windows-only today and stay that way.
- **Replacing the CLI.** `tokenops agent run` and `tokenops status` keep working
  for headless and server installs.

## Architecture

A new `apps/desktop` package with the three standard Electron layers:

| Layer | Responsibility |
|-------|----------------|
| main | Owns the agent runtime, tray, window lifecycle, and all disk/DB access |
| preload | Exposes a narrow, typed API over `contextBridge` — nothing else |
| renderer | React UI. Receives plain data objects; never touches Node or SQLite |

### The agent becomes callable

`apps/agent/src/agent-main.ts` is CLI-shaped today. It gains a programmatic
API:

```ts
export type AgentHandle = { stop(): Promise<void> };
export async function startAgent(opts: { configPath?: string }): Promise<AgentHandle>;
```

The CLI calls exactly this, so there is one code path and the existing agent
tests continue to cover it. The desktop main process calls it too.

This is the only change to shipped agent behaviour in this design.

### Local statistics

A new `apps/agent/src/local-stats.ts` reads the outbox and returns rollups.

This is cheap because of an existing property of the outbox: `markSent` sets
`status = 'sent'` rather than deleting the row, so **sent events keep their
payloads**. Today's totals are a query, not a new table.

```ts
export type LocalStats = {
  today: { inputTokens: number; outputTokens: number; estimatedUsd: number };
  byApp: Array<{ app: string; inputTokens: number; outputTokens: number }>;
  byModel: Array<{ model: string; inputTokens: number; outputTokens: number }>;
  queue: { pending: number; lastError: string | null; lastFlushAt: string | null };
  recent: Array<{ at: string; app: string; model: string; inputTokens: number; outputTokens: number }>;
};
export function readLocalStats(outboxPath: string, now: Date): LocalStats;
```

Pure SQLite-in, object-out. It unit-tests exactly like the rest of the repo,
with no Electron in the test path.

That same retention property has a consequence worth stating plainly: the outbox
grows without bound today, because nothing prunes sent rows. The desktop window
is what will make that visible. Pruning is a follow-up, not part of this design,
but the window must not assume the table is small — queries are bounded by date
and `LIMIT`.

### Window contents

One live view, refreshed by polling `readLocalStats` over IPC:

- **Capture paths with health** — proxy `:8787`, OTEL receiver `:4318`, JSONL
  watcher. The proxy row surfaces the missing-upstream-key warning as persistent
  state rather than a line that scrolled away.
- **Today** — tokens and estimated cost, broken down by app and model.
- **Outbox** — pending count, last error, last successful flush.
- **Recent activity** — a rolling feed of captured calls.
- **Actions** — open the cloud dashboard, open `~/.tokenops`, restart the agent,
  quit.

### Tray

The icon reflects state: idle, capturing, error. Left-click shows the window;
right-click gives Show, Pause capture, Open config folder, Quit.

**Closing the window hides to tray; it does not stop capture.** Quit is
explicit and is the only way to stop the agent. This is the specific failure of
the console window being corrected, so it must not be softened into "minimise on
close" behaviour that still exits on some paths.

## Security

Electron defaults are unsafe for a process holding credentials, and this window
displays configuration, so the hardening is not boilerplate:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- A `contextBridge` API listing each permitted call explicitly — no generic
  "invoke arbitrary channel" bridge
- A restrictive CSP; the renderer loads no remote content
- External links open in the system browser via `shell.openExternal`, never in
  an Electron window
- **The renderer never receives the ingest PAT or any provider API key.** The
  window may show whether a key is *present*; it never shows the value. Both
  stay in the main process.

## Packaging and migration

electron-builder produces an NSIS installer. It becomes the primary download.
The portable ZIP stays for headless and server installs.

**The Inno Setup installer is retired**, along with `installer/windows/TokenOpsAgent.iss`
and the static guard at `apps/agent/test/installer-iss.test.ts`. CI's
`installer-windows` job is replaced by an electron-builder packaging job.

Migration from an existing Inno install is the risky part, because the old
installer left three things behind:

1. A `TokenOpsAgent` scheduled task that runs the CLI agent at logon
2. A PATH entry pointing at `%LOCALAPPDATA%\TokenOps\bin`
3. `%LOCALAPPDATA%\TokenOps\install-manifest.json`

If both the old task and the new app run, the second one to start **fails to
bind `127.0.0.1:8787`** and its proxy dies while the rest of it appears healthy.
Event data itself is safe — `buildEventId` is deterministic and ingest
de-duplicates — but a half-working agent is worse than an obvious failure.

The NSIS installer therefore must, before first run: delete the `TokenOpsAgent`
scheduled task if present, remove the stale PATH entry, and leave
`~/.tokenops/config.toml` and `machine.json` untouched so the machine keeps its
identity and its PAT. Preserving `machine.json` is what keeps existing history
attached to the same machine.

## Testing

- `local-stats.ts` — unit tests over a seeded temporary SQLite file: empty
  database, rows spanning a day boundary, sent versus pending, malformed payload
  rows skipped rather than throwing.
- `startAgent`/`stopAgent` — start, assert listeners are bound, stop, assert
  ports are released. This is the contract the desktop app depends on.
- Main process — thin coverage of window/tray lifecycle: close hides rather than
  quits, quit stops the agent.
- Renderer — component tests against fixture `LocalStats` objects, including the
  degraded states (no upstream key, queue backed up, last error set).

No new test runner. Everything stays on Vitest.

## Risks

- **Installer size** goes up roughly 40×. Accepted, and partly offset by dropping
  the Node prerequisite.
- **Electron is a large dependency surface** and will need periodic security
  updates. It is now part of the release cadence.
- **Antivirus and SmartScreen.** The current Setup is already unsigned and warns;
  a larger unsigned Electron binary is treated no better. Code signing remains a
  separate, unsolved problem.
- **In-process agent means a renderer crash must not take capture down.** The
  agent lives in main precisely for this reason, and the window is disposable.

## Follow-ups

- Prune sent outbox rows on a retention policy
- Code signing for the installer
- macOS build
- Cloud data in the window, if the browser hand-off proves insufficient
- **Cut during implementation (whole-branch review, finding M1):** three
  items in this design were dropped without being recorded until now. Listed
  here so the gap is a decision, not a silent gap:
  - **State-reflecting tray icon.** This spec's Tray section says "the icon
    reflects state: idle, capturing, error." The shipped tray has one static
    icon; only the tooltip text changes (`apps/desktop/src/main/tray.ts`'s
    `TrayStatus`/`setTrayStatus`). Needs idle/capturing/error glyph assets
    plus wiring from agent lifecycle + proxy/outbox health into tray icon
    updates, not just tooltip updates.
  - **"Restart the agent" tray action.** This spec's Window section lists it
    under Actions. Not implemented — Quit-and-relaunch is the only recovery
    path. Blocked on the same null-`AgentHandle` lifecycle complexity noted
    above for "Pause capture": restart needs the tray, window, and IPC layer
    to all cope with the agent being torn down and rebuilt without quitting
    the app.
  - **`queue.lastFlushAt` in `LocalStats`.** This spec's local-statistics
    sketch includes it (`queue: { pending, lastError, lastFlushAt }`); the
    shipped type (`apps/agent/src/local-stats.ts`) and window UI only carry
    `pending`/`lastError`. Needs a last-successful-flush timestamp recorded
    somewhere flush-side (outbox or a small sidecar) and threaded through to
    the window.
  - What *did* ship instead, so a failed agent start is never reported as
    healthy: the tray tooltip starts as "TokenOps — starting…", flips to
    "TokenOps — capturing" only once `startDesktopAgent()` resolves, to
    "TokenOps — agent failed to start" if it rejects, and to "TokenOps —
    shutting down…" while a quit is draining (`index.ts`).
