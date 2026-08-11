import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHandle } from "@tokenops/agent";

type Handler = (...args: unknown[]) => unknown;

/**
 * A minimal fake of Electron's `app` singleton, capturing every listener
 * registered via `.on(event, cb)` so the test can invoke them directly
 * (there is no real Electron instance here -- same approach ipc.test.ts and
 * window.test.ts already use for their own mocks).
 */
function makeFakeApp() {
  const listeners = new Map<string, Handler[]>();
  return {
    requestSingleInstanceLock: vi.fn(() => true),
    on: vi.fn((event: string, cb: Handler) => {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
    }),
    whenReady: vi.fn(() => Promise.resolve()),
    quit: vi.fn(),
  };
}

vi.mock("electron", () => ({
  app: makeFakeApp(),
  BrowserWindow: vi.fn(),
  dialog: { showErrorBox: vi.fn() },
}));

vi.mock("./window.js", () => ({
  createMainWindow: vi.fn(() => ({
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
  })),
}));

vi.mock("./tray.js", () => ({
  createTray: vi.fn(() => ({ setToolTip: vi.fn() })),
  setTrayStatus: vi.fn(),
}));

vi.mock("./ipc.js", () => ({
  registerIpc: vi.fn(),
  openDashboard: vi.fn(),
}));

vi.mock("@tokenops/agent", () => ({ runAgent: vi.fn() }));

function fakeAgentHandle(stop: () => Promise<void>): AgentHandle {
  return {
    outbox: {} as AgentHandle["outbox"],
    config: {} as AgentHandle["config"],
    machineId: "m1",
    machineName: "desktop",
    stop,
    tick: vi.fn(),
  };
}

function beforeQuitListener(app: {
  on: ReturnType<typeof vi.fn>;
}): Handler {
  const call = app.on.mock.calls.find(([event]) => event === "before-quit");
  if (!call) throw new Error("no before-quit listener registered");
  return call[1] as Handler;
}

describe("index.ts quit/teardown state machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it(
    "a rapid second Quit while agent.stop() is still draining does not " +
      "restart teardown, and the quit only proceeds once stop() genuinely finishes",
    async () => {
      vi.resetModules();
      const { app } = await import("electron");
      const { runAgent } = await import("@tokenops/agent");
      const { setTrayStatus } = await import("./tray.js");

      let resolveStop!: () => void;
      const stopPromise = new Promise<void>((resolve) => {
        resolveStop = resolve;
      });
      const stop = vi.fn(() => stopPromise);
      vi.mocked(runAgent).mockResolvedValue(fakeAgentHandle(stop));

      await import("./index.js");

      // Let whenReady().then() run, startDesktopAgent() resolve, and its
      // .then() assign `agent` -- observed via the tray flipping to
      // "capturing" (module-private `agent` itself isn't exported), rather
      // than a fixed number of manual microtask hops that would be brittle
      // against unrelated changes to the promise chain's shape.
      await vi.waitFor(() => {
        expect(vi.mocked(setTrayStatus)).toHaveBeenCalledWith(
          expect.anything(),
          "capturing",
        );
      });

      const beforeQuit = beforeQuitListener(
        app as unknown as { on: ReturnType<typeof vi.fn> },
      );

      // First Quit: holds the quit, kicks off the one and only stop().
      const event1 = { preventDefault: vi.fn() };
      beforeQuit(event1);
      expect(event1.preventDefault).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(app.quit).not.toHaveBeenCalled();

      // Second, impatient Quit click while stop() is still pending: must
      // still hold the quit, and must NOT start a second stop() -- this is
      // the exact re-entrancy this whole-branch review flagged as I3/the
      // regression the three-phase quit-state guard exists to prevent.
      const event2 = { preventDefault: vi.fn() };
      beforeQuit(event2);
      expect(event2.preventDefault).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(app.quit).not.toHaveBeenCalled();

      // Teardown genuinely finishes.
      resolveStop();
      await vi.waitFor(() => {
        expect(app.quit).toHaveBeenCalledTimes(1);
      });

      // A third before-quit -- the one app.quit() above re-fires -- must
      // now be let through with no preventDefault.
      const event3 = { preventDefault: vi.fn() };
      beforeQuit(event3);
      expect(event3.preventDefault).not.toHaveBeenCalled();
    },
  );
});
