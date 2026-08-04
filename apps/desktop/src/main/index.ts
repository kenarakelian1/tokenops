import { app, BrowserWindow, dialog } from "electron";
import type { AgentHandle } from "@tokenops/agent";
import { createMainWindow } from "./window.js";

let agent: AgentHandle | null = null;
let win: BrowserWindow | null = null;

/**
 * `detach: true` suppresses the signal handlers the CLI installs. Lifecycle is
 * ours: nothing stops capture except an explicit quit.
 *
 * `@tokenops/agent` is ESM-only (the repo default) while this main process
 * compiles to CommonJS (see tsconfig.json / README note in window.ts on
 * __dirname and sandboxed preload). A static `import` would downlevel to a
 * `require()` that Node's CJS loader cannot resolve against an ESM-only
 * package's "exports" map (no "require" condition) -- a dynamic `import()`
 * is the correct CJS-consumes-ESM interop path, so it is used here on
 * purpose rather than switched to `require`.
 */
export async function startDesktopAgent(): Promise<AgentHandle> {
  const { runAgent } = await import("@tokenops/agent");
  return runAgent({ detach: true });
}

// The agent proxy/OTEL listeners are single-owner ports (127.0.0.1:8787,
// :4318). A second launch racing the first for those ports would either
// steal them or fail loudly for no reason a user could act on -- refuse the
// second instance instead and just focus the window the first one already
// opened.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    // The window is created unconditionally, before the agent start is even
    // awaited. Previously both lived in the same `await` chain, so a
    // `runAgent` rejection (e.g. another tokenops process already holding
    // :8787 -- not hypothetical, see task-2-report.md) left no window and no
    // error: a silent, windowless process a user would have no way to
    // diagnose or even know was running.
    win = createMainWindow();

    startDesktopAgent()
      .then((handle) => {
        agent = handle;
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[tokenops] agent failed to start:", message);
        dialog.showErrorBox("TokenOps agent failed to start", message);
      });
  });

  // Electron calls `before-quit` listeners synchronously and ignores any
  // returned promise -- an `async` listener here does NOT delay quit; it
  // just races `agent.stop()` (OTEL close -> proxy close -> outbox.close())
  // against process teardown. `preventDefault` + a `quitting` re-entry guard
  // makes the shutdown actually block: quit is deferred until `stop()`
  // resolves, then requested again (the guard lets that second request
  // through instead of recursing).
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (async () => {
      try {
        await agent?.stop();
        // Proof this actually awaited stop() rather than racing it: this
        // line must appear in the log before the process exits.
        console.log("[tokenops] agent stopped cleanly");
      } finally {
        agent = null;
        app.quit();
      }
    })();
  });

  // Task 3 adds tray + hide-on-close; for now closing the window quits the
  // app. Electron does not do this by default on any platform -- without
  // this handler the process would keep running with no window.
  app.on("window-all-closed", () => {
    app.quit();
  });
}
