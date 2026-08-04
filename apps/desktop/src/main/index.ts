import { app, BrowserWindow, dialog, type Tray } from "electron";
import type { AgentHandle } from "@tokenops/agent";
import { createMainWindow } from "./window.js";
import { createTray } from "./tray.js";
import { isQuitting, beginQuitting } from "./quit-state.js";

let agent: AgentHandle | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;

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

    // Tray outlives the window: closing the window hides it (window.ts),
    // and this is what brings it back or ends the app for real.
    tray = createTray({
      onShow: () => {
        win?.show();
        win?.focus();
      },
      onQuit: () => {
        // No need to touch quit-state here: app.quit() below always emits
        // `before-quit` first, and that handler is what sets `quitting`
        // (via beginQuitting()) and awaits agent.stop(). Setting it here too
        // would just be a second writer of the same fact.
        app.quit();
      },
    });

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
  // against process teardown. `preventDefault` + the shared `quitting`
  // re-entry guard (quit-state.ts) makes the shutdown actually block: quit
  // is deferred until `stop()` resolves, then requested again (the guard
  // lets that second request through instead of recursing).
  //
  // That same shared flag is also what window.ts's `close` handler checks
  // to decide "hide to tray" vs "let this close proceed". The two only work
  // together because they share one flag: the window is only ever allowed
  // to actually close on the *second* app.quit() call below, once
  // `isQuitting()` is already true -- i.e. after agent.stop() has resolved.
  // A separate, independently-set flag (e.g. the brief's `global.isQuitting`
  // set from the tray's onQuit) would race this one: the window could close
  // (and window-all-closed fire) before before-quit had a chance to
  // preventDefault and await the agent, or the two flags could simply drift
  // out of sync.
  app.on("before-quit", (event) => {
    if (isQuitting()) return;
    event.preventDefault();
    beginQuitting();
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

  // No `window-all-closed` handler here (Task 2 had one calling app.quit();
  // removed in Task 3). Once window.ts's `close` handler hides instead of
  // closing, `window-all-closed` can only fire as a byproduct of a quit
  // already in progress: the window is only ever allowed to actually close
  // when `isQuitting()` is true, which is only ever set inside the
  // `before-quit` handler above, which only runs in response to an
  // `app.quit()` call. Electron does not need a `window-all-closed` handler
  // to finish a quit sequence that `before-quit` already let through -- it
  // proceeds to `will-quit` and process exit on its own. Re-adding a
  // `window-all-closed` -> `app.quit()` handler here would at best be a
  // harmless no-op (the guard above would just return early) and at worst
  // reintroduce the exact bug Task 2's fix round 1 removed: a second,
  // uncoordinated path to quit that does not go through the awaited
  // `agent.stop()`.
}
