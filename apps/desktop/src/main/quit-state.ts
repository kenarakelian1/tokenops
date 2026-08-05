/**
 * Single source of truth for where the app is in its quit sequence, shared
 * between index.ts's `before-quit` handler and window.ts's close-to-tray
 * handler.
 *
 * This started (fix round 1) as a two-state boolean `quitting` flag, lifted
 * out of a local variable in index.ts's `before-quit` listener. That was
 * wrong: a boolean can't distinguish "a quit was requested and teardown is
 * still draining" from "teardown actually finished". A second rapid Quit
 * click re-fires `before-quit` while `agent.stop()` (OTEL close -> proxy
 * close -> outbox.close()) is still in flight; with only a boolean, that
 * second call would see "quitting" already true, skip `preventDefault()`,
 * and let Electron proceed straight to closing the window and exiting the
 * process -- mid-teardown, dropping whatever the outbox had not yet
 * flushed. That is the exact "closing it silently stopped capture" bug this
 * feature exists to fix, just restaged one level down.
 *
 * Three states fix this by making "teardown in flight" distinct from
 * "teardown finished": `preventDefault()` must be called on *every*
 * `before-quit` while phase is "running" or "stopping" -- only "stopped"
 * (set after `agent.stop()` has actually resolved) is allowed through.
 */
export type QuitPhase = "running" | "stopping" | "stopped";

let phase: QuitPhase = "running";

export function getQuitPhase(): QuitPhase {
  return phase;
}

export function beginStopping(): void {
  phase = "stopping";
}

export function markStopped(): void {
  phase = "stopped";
}

/**
 * window.ts's close handler consumes this alone (it doesn't need the
 * three-way branching before-quit does): the window may only actually close
 * once teardown has genuinely finished. "running" and "stopping" both mean
 * "hide, don't close" -- the difference between them only matters to the
 * before-quit handler that owns the phase transitions.
 */
export function canWindowClose(): boolean {
  return phase === "stopped";
}
