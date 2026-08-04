import { app, BrowserWindow, dialog, type Tray } from "electron";
import type { AgentHandle } from "@tokenops/agent";
import { createMainWindow } from "./window.js";
import { createTray } from "./tray.js";
import { getQuitPhase, beginStopping, markStopped } from "./quit-state.js";

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
        // `before-quit` first, and that handler owns every phase transition
        // (running -> stopping -> stopped) and awaits agent.stop(). A rapid
        // second click on this same menu item just re-fires app.quit(),
        // which before-quit's phase check below handles correctly (see its
        // comment) rather than needing anything special here.
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
  // against process teardown. `preventDefault()` + quit-state.ts's
  // three-phase guard makes the shutdown actually block, including against
  // a second Quit click landing while `stop()` is still draining:
  //
  //   - "running"  -> first request: preventDefault, move to "stopping",
  //                   kick off agent.stop().
  //   - "stopping" -> a *second* before-quit while teardown is still in
  //                   flight (e.g. an impatient second Quit click):
  //                   preventDefault again -- do NOT let this one through,
  //                   and do NOT start a second stop() -- then return.
  //   - "stopped"  -> teardown genuinely finished (set in the `finally`
  //                   below, right before the second app.quit() call that
  //                   re-fires this handler): let it through this time.
  //
  // A plain boolean here (fix round 1's version) can't tell "stopping" apart
  // from "stopped", so a second before-quit during "stopping" would skip
  // preventDefault and let Electron proceed to close the window and exit
  // mid-teardown -- dropping whatever the outbox had not yet flushed. That
  // is the exact "closing it silently stopped capture" bug this whole
  // feature exists to fix, restaged one level down as "quitting twice
  // stopped capture before it finished."
  //
  // window.ts's `close` handler reads the same phase (via
  // `canWindowClose()`) and only allows the window to actually close once
  // phase is "stopped" -- i.e. strictly after agent.stop() has resolved --
  // for the same reason.
  app.on("before-quit", (event) => {
    const phase = getQuitPhase();
    if (phase === "stopped") return; // teardown genuinely done; let quit through
    event.preventDefault(); // hold the quit on every call while not yet stopped
    if (phase === "stopping") return; // already tearing down; don't restart it
    beginStopping();
    void (async () => {
      try {
        await agent?.stop();
        // Proof this actually awaited stop() rather than racing it: this
        // line must appear in the log before the process exits.
        console.log("[tokenops] agent stopped cleanly");
      } finally {
        agent = null;
        markStopped();
        app.quit();
      }
    })();
  });

  // No `window-all-closed` handler here (Task 2 had one calling app.quit();
  // removed in Task 3). Once window.ts's `close` handler hides instead of
  // closing, `window-all-closed` can only fire as a byproduct of a quit
  // already in progress: the window is only ever allowed to actually close
  // once quit-state.ts's phase reaches "stopped", which is only ever set
  // inside the `before-quit` handler above, which only runs in response to
  // an `app.quit()` call. Electron does not need a `window-all-closed`
  // handler to finish a quit sequence that `before-quit` already let
  // through -- it proceeds to `will-quit` and process exit on its own.
  // Re-adding a `window-all-closed` -> `app.quit()` handler here would at
  // best be a harmless no-op (the phase check above would just return
  // early) and at worst reintroduce a second, uncoordinated path to quit
  // that does not go through the awaited `agent.stop()`.
}
