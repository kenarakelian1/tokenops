import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
  class FakeTray {
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    on = vi.fn();
  }
  return {
    Tray: vi.fn().mockImplementation(() => new FakeTray()),
    Menu: { buildFromTemplate: vi.fn((template: unknown) => template) },
    nativeImage: { createFromPath: vi.fn(() => ({})) },
    shell: { openPath: vi.fn() },
  };
});

import { createTray, setTrayStatus } from "./tray.js";

type FakeTray = {
  setToolTip: ReturnType<typeof vi.fn>;
  setContextMenu: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
};

describe("tray tooltip status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts as 'starting…', never the old hardcoded 'capturing' claim", () => {
    const tray = createTray({ onShow: vi.fn(), onQuit: vi.fn() }) as unknown as FakeTray;

    // Regression guard for M1: a hardcoded "capturing" tooltip lied for as
    // long as startup took (and permanently on failure). The tray must not
    // claim capture is happening before startDesktopAgent() has resolved.
    expect(tray.setToolTip).toHaveBeenCalledTimes(1);
    expect(tray.setToolTip).toHaveBeenCalledWith(
      expect.stringMatching(/starting/i),
    );
    expect(tray.setToolTip).not.toHaveBeenCalledWith(
      expect.stringContaining("capturing"),
    );
  });

  it("setTrayStatus('capturing') is only reachable once the agent has actually started", () => {
    const tray = createTray({ onShow: vi.fn(), onQuit: vi.fn() }) as unknown as FakeTray;
    setTrayStatus(tray as never, "capturing");
    expect(tray.setToolTip).toHaveBeenLastCalledWith("TokenOps — capturing");
  });

  it("setTrayStatus('error') reports agent startup failure, not a silent lie", () => {
    const tray = createTray({ onShow: vi.fn(), onQuit: vi.fn() }) as unknown as FakeTray;
    setTrayStatus(tray as never, "error");
    expect(tray.setToolTip).toHaveBeenLastCalledWith(
      expect.stringMatching(/failed/i),
    );
  });

  it("setTrayStatus('stopping') gives quit feedback instead of a silent hang (M3)", () => {
    const tray = createTray({ onShow: vi.fn(), onQuit: vi.fn() }) as unknown as FakeTray;
    setTrayStatus(tray as never, "stopping");
    expect(tray.setToolTip).toHaveBeenLastCalledWith(
      expect.stringMatching(/shutting down/i),
    );
  });
});
