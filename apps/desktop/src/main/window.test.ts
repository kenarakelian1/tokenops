import { beforeEach, describe, expect, it, vi } from "vitest";

// Same harness ipc.test.ts already uses: electron is fully mocked so this
// runs with no real Electron instance, no filesystem/network access.
vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  shell: { openExternal: vi.fn() },
}));

import { BrowserWindow } from "electron";

type Handler = (...args: unknown[]) => unknown;

function makeFakeWin() {
  const onHandlers = new Map<string, Handler>();
  const webContentsOnHandlers = new Map<string, Handler>();
  let windowOpenHandler: Handler | null = null;

  const win = {
    on: vi.fn((event: string, cb: Handler) => {
      onHandlers.set(event, cb);
    }),
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    loadFile: vi.fn(() => Promise.resolve(undefined)),
    webContents: {
      setWindowOpenHandler: vi.fn((cb: Handler) => {
        windowOpenHandler = cb;
      }),
      on: vi.fn((event: string, cb: Handler) => {
        webContentsOnHandlers.set(event, cb);
      }),
    },
  };

  return {
    win,
    closeHandler: () => onHandlers.get("close"),
    willNavigateHandler: () => webContentsOnHandlers.get("will-navigate"),
    windowOpenHandler: () => windowOpenHandler,
  };
}

/**
 * Loads a fresh window.js + quit-state.js pair. quit-state.ts has
 * module-level mutable phase state, so each test needs its own instance --
 * vi.resetModules() clears the registry, and since both this helper and
 * window.js's own import of "./quit-state.js" run inside the same
 * post-reset cycle, they resolve to the same cached singleton.
 */
async function freshWindowModule() {
  vi.resetModules();
  const quitState = await import("./quit-state.js");
  const { createMainWindow } = await import("./window.js");
  return { createMainWindow, quitState };
}

describe("createMainWindow close-to-tray behaviour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("close hides the window instead of letting it close while quit-state is not 'stopped'", async () => {
    const { createMainWindow } = await freshWindowModule();
    const fake = makeFakeWin();
    vi.mocked(BrowserWindow).mockImplementation(
      () => fake.win as unknown as InstanceType<typeof BrowserWindow>,
    );

    createMainWindow();
    const onClose = fake.closeHandler();
    expect(onClose).toBeTypeOf("function");

    const event = { preventDefault: vi.fn() };
    onClose!(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(fake.win.hide).toHaveBeenCalledTimes(1);
  });

  it("close still hides while phase is 'stopping' (teardown in flight, not yet done)", async () => {
    const { createMainWindow, quitState } = await freshWindowModule();
    quitState.beginStopping();
    const fake = makeFakeWin();
    vi.mocked(BrowserWindow).mockImplementation(
      () => fake.win as unknown as InstanceType<typeof BrowserWindow>,
    );

    createMainWindow();
    const onClose = fake.closeHandler();
    const event = { preventDefault: vi.fn() };
    onClose!(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(fake.win.hide).toHaveBeenCalledTimes(1);
  });

  it("lets the window actually close once quit-state has genuinely reached 'stopped'", async () => {
    const { createMainWindow, quitState } = await freshWindowModule();
    quitState.beginStopping();
    quitState.markStopped();
    const fake = makeFakeWin();
    vi.mocked(BrowserWindow).mockImplementation(
      () => fake.win as unknown as InstanceType<typeof BrowserWindow>,
    );

    createMainWindow();
    const onClose = fake.closeHandler();
    const event = { preventDefault: vi.fn() };
    onClose!(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(fake.win.hide).not.toHaveBeenCalled();
  });
});
