/**
 * Single source of truth for "is a real quit in progress", shared between
 * index.ts's `before-quit` handler and window.ts's close-to-tray handler.
 *
 * Task 2 already introduced a `quitting` re-entry guard local to the
 * `before-quit` listener (preventDefault on the first call, await
 * `agent.stop()`, then re-call `app.quit()` once it settles -- the guard
 * lets that second call through instead of recursing). Task 3's hide-on-close
 * handler needs to answer the same question ("is this close part of a real
 * quit, or should it just hide the window?"), so that flag is lifted out of
 * index.ts into this module and imported by both, instead of introducing a
 * second, independently-mutated flag (e.g. a `global.isQuitting`) that could
 * drift out of sync with the first.
 */
let quitting = false;

export function isQuitting(): boolean {
  return quitting;
}

export function beginQuitting(): void {
  quitting = true;
}
