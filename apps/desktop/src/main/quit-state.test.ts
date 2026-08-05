import { describe, expect, it, vi } from "vitest";

/**
 * quit-state.ts holds module-level mutable state (`phase`), so each test
 * needs a fresh module instance -- otherwise phase transitions from one
 * test would leak into the next. `vi.resetModules()` + a dynamic re-import
 * gets a clean copy every time.
 */
async function freshQuitState() {
  vi.resetModules();
  return import("./quit-state.js");
}

describe("quit-state", () => {
  it("starts in 'running', which does not allow the window to close", async () => {
    const { getQuitPhase, canWindowClose } = await freshQuitState();
    expect(getQuitPhase()).toBe("running");
    expect(canWindowClose()).toBe(false);
  });

  it("beginStopping() moves to 'stopping', which still does not allow close", async () => {
    const { getQuitPhase, canWindowClose, beginStopping } =
      await freshQuitState();
    beginStopping();
    expect(getQuitPhase()).toBe("stopping");
    expect(canWindowClose()).toBe(false);
  });

  it("markStopped() moves to 'stopped', which is the only phase that allows close", async () => {
    const { getQuitPhase, canWindowClose, beginStopping, markStopped } =
      await freshQuitState();
    beginStopping();
    markStopped();
    expect(getQuitPhase()).toBe("stopped");
    expect(canWindowClose()).toBe(true);
  });

  it("a second beginStopping() while already 'stopping' is a no-op, not a reset", async () => {
    // This is the exact shape of the double-Quit regression this module was
    // introduced to fix: a rapid second before-quit must not restart
    // teardown or otherwise disturb an in-flight "stopping" phase.
    const { getQuitPhase, beginStopping } = await freshQuitState();
    beginStopping();
    beginStopping();
    expect(getQuitPhase()).toBe("stopping");
  });
});
