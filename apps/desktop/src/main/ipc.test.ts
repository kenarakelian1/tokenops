import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHandle } from "@tokenops/agent";

// electron and @tokenops/agent are both mocked: this test runs with no
// Electron instance and no filesystem/network access, exactly like every
// other test in this repo (see the task-4 brief's "must never require a
// running Electron instance" constraint).
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));

vi.mock("@tokenops/agent", () => ({
  readLocalStats: vi.fn(() => ({
    today: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, eventCount: 0 },
    byApp: [],
    byModel: [],
    queue: { pending: 0, lastError: null },
    recent: [],
  })),
  defaultOutboxPath: vi.fn(() => "C:/fake/.tokenops/outbox.db"),
  defaultTokenopsDir: vi.fn(() => "C:/fake/.tokenops"),
  // The disk fallback openDashboard() uses when there is no live AgentHandle
  // (main/ipc.ts) -- throws by default, matching the real loadConfig()
  // throwing when ~/.tokenops/config.toml doesn't exist. Individual tests
  // override this with mockReturnValue to exercise the fallback itself.
  loadConfig: vi.fn(() => {
    throw new Error("Config not found (test default -- no config.toml)");
  }),
}));

import { ipcMain, shell } from "electron";
import {
  readLocalStats,
  defaultOutboxPath,
  defaultTokenopsDir,
  loadConfig,
} from "@tokenops/agent";
import { registerIpc, openDashboard } from "./ipc.js";

type Handler = (...args: unknown[]) => unknown;

function handlerFor(channel: string): Handler {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`no ipcMain.handle registered for ${channel}`);
  return call[1] as Handler;
}

function listenerFor(channel: string): Handler {
  const call = vi.mocked(ipcMain.on).mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`no ipcMain.on registered for ${channel}`);
  return call[1] as Handler;
}

/** A value distinctive enough that an accidental leak can't hide as coincidence. */
const SECRET_PAT = "tokenops-pat-do-not-leak-9f3e";
/** Ditto, for the upstream provider key. */
const SECRET_UPSTREAM_KEY = "sk-do-not-leak-7ab2";

function fakeAgent(over?: {
  ingestToken?: string;
  openaiProxy?: boolean;
  claudeCode?: boolean;
  otelListen?: string;
  cloudUrl?: string;
}): AgentHandle {
  return {
    outbox: {} as AgentHandle["outbox"],
    machineId: "machine-1",
    machineName: "KENDESKTOP",
    stop: vi.fn(),
    tick: vi.fn(),
    config: {
      cloud: {
        url: over?.cloudUrl ?? "https://cloud.example",
        ingestToken: over?.ingestToken ?? SECRET_PAT,
      },
      privacy: { contentMode: "local", contentTtlDays: 7 },
      proxy: { listen: "127.0.0.1:8787", upstream: "https://api.openai.com" },
      sources: {
        openaiProxy: over?.openaiProxy ?? true,
        claudeCode: over?.claudeCode ?? true,
        claudeCodePath: "",
        claudeCodeOtelListen: over?.otelListen ?? "127.0.0.1:4318",
      },
      machine: { name: "desktop" },
    },
  } as AgentHandle;
}

describe("registerIpc", () => {
  // vi.clearAllMocks() (not vi.resetAllMocks()) on purpose: several mocks in
  // the @tokenops/agent factory above are defined with a default
  // implementation (readLocalStats's zero-value stats, defaultOutboxPath,
  // defaultTokenopsDir) that other tests in this file rely on surviving
  // across tests -- resetAllMocks() would wipe those back to "returns
  // undefined" and break them. The tradeoff: clearAllMocks() does NOT reset
  // a mockReturnValue/mockImplementation override a single test applies (see
  // the "no config on disk" test below, which learned this the hard way) --
  // any test that overrides loadConfig's implementation must explicitly
  // restore it, not rely on this beforeEach to do so.
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.XAI_API_KEY;
  });

  it("tokenops:status reports presence but never the ingest token or upstream key value", async () => {
    process.env.OPENAI_API_KEY = SECRET_UPSTREAM_KEY;
    const agent = fakeAgent();
    registerIpc(() => agent);

    const status = await handlerFor("tokenops:status")();
    const serialized = JSON.stringify(status);

    expect(serialized).not.toContain(SECRET_PAT);
    expect(serialized).not.toContain(SECRET_UPSTREAM_KEY);
    expect(status).toEqual({
      machineName: "KENDESKTOP",
      cloudUrl: "https://cloud.example",
      ingestTokenPresent: true,
      upstreamKeyPresent: true,
      proxyListen: "127.0.0.1:8787",
      otelListen: "127.0.0.1:4318",
      claudeCodeWatching: true,
    });
  });

  it("tokenops:status reports absence correctly, still without leaking anything", async () => {
    const agent = fakeAgent({ ingestToken: "" });
    registerIpc(() => agent);

    const status = (await handlerFor("tokenops:status")()) as {
      ingestTokenPresent: boolean;
      upstreamKeyPresent: boolean;
    };

    expect(status.ingestTokenPresent).toBe(false);
    expect(status.upstreamKeyPresent).toBe(false);
    expect(JSON.stringify(status)).not.toContain(SECRET_PAT);
  });

  it("tokenops:status treats a whitespace-only upstream key as absent, matching the proxy's own resolver", async () => {
    // apps/agent/src/proxy/handler.ts's resolveUpstreamApiKey trims before
    // checking -- a whitespace-only env var is "none" to the proxy. If this
    // handler disagreed (e.g. plain `Boolean(process.env.OPENAI_API_KEY)`),
    // the window would report "healthy" while every proxied call fails auth.
    process.env.OPENAI_API_KEY = "   ";
    const agent = fakeAgent();
    registerIpc(() => agent);

    const status = (await handlerFor("tokenops:status")()) as {
      upstreamKeyPresent: boolean;
    };
    expect(status.upstreamKeyPresent).toBe(false);
  });

  it("tokenops:status nulls out proxy/otel listen addresses when their sources are disabled", async () => {
    const agent = fakeAgent({ openaiProxy: false, claudeCode: false });
    registerIpc(() => agent);

    const status = (await handlerFor("tokenops:status")()) as {
      proxyListen: string | null;
      otelListen: string | null;
      claudeCodeWatching: boolean;
    };

    expect(status.proxyListen).toBeNull();
    expect(status.otelListen).toBeNull();
    expect(status.claudeCodeWatching).toBe(false);
  });

  it("tokenops:status throws when the agent has not started", () => {
    registerIpc(() => null);
    expect(() => handlerFor("tokenops:status")()).toThrow(/agent not started/);
  });

  it("tokenops:stats reads local stats independent of whether the agent has started", async () => {
    registerIpc(() => null);
    const result = await handlerFor("tokenops:stats")();
    expect(readLocalStats).toHaveBeenCalledWith(defaultOutboxPath());
    expect(result).toEqual({
      today: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, eventCount: 0 },
      byApp: [],
      byModel: [],
      queue: { pending: 0, lastError: null },
      recent: [],
    });
  });

  it("tokenops:open-dashboard opens the agent's own cloud.url, not a renderer-supplied one", () => {
    // The listener takes no arguments -- passing one here proves the
    // renderer's argument (if any slipped through) is ignored; main resolves
    // the URL itself from the live agent's config.
    const agent = fakeAgent({ cloudUrl: "https://cloud.example" });
    registerIpc(() => agent);

    listenerFor("tokenops:open-dashboard")({}, "https://attacker.example");

    expect(shell.openExternal).toHaveBeenCalledWith("https://cloud.example");
    expect(shell.openExternal).not.toHaveBeenCalledWith("https://attacker.example");
  });

  it("tokenops:open-dashboard never forwards an unsafe cloud.url to the OS shell", () => {
    // cloud.url comes from user-editable ~/.tokenops/config.toml. A file:
    // URL (or a UNC path, or a registered custom protocol) must never reach
    // shell.openExternal -- the exact attack path window.ts's
    // isSafeExternalUrl already guards every other call site against.
    const agent = fakeAgent({
      cloudUrl: "file:///C:/Windows/System32/calc.exe",
    });
    registerIpc(() => agent);

    listenerFor("tokenops:open-dashboard")({});

    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("tokenops:open-dashboard falls back to the URL from config on disk when there is no agent handle", async () => {
    // The window is at its most dead-end exactly when there's no live
    // AgentHandle (agent not started / failed / not running) -- that's
    // precisely when "Open dashboard" needs to still work. loadConfig()
    // reads the same ~/.tokenops/config.toml the agent itself would load.
    vi.mocked(loadConfig).mockReturnValue({
      cloud: { url: "https://cloud.example", ingestToken: "" },
    } as never);
    registerIpc(() => null);

    listenerFor("tokenops:open-dashboard")({});

    await vi.waitFor(() => {
      expect(shell.openExternal).toHaveBeenCalledWith("https://cloud.example");
    });
  });

  it("tokenops:open-dashboard opens the dashboard URL, not the API URL, when they differ", async () => {
    // The reported bug: `cloud.url` is the API base -- where the agent POSTs
    // events -- so opening it landed the user on the API's JSON service
    // banner. These are genuinely different origins in the two-service
    // Railway layout (tokenops-api-* vs tokenops-web-*), so the config needs
    // to carry both and this button has to pick the right one.
    vi.mocked(loadConfig).mockReturnValue({
      cloud: {
        url: "https://tokenops-api-production.up.railway.app",
        dashboardUrl: "https://tokenops-web-production.up.railway.app",
        ingestToken: "",
      },
    } as never);
    registerIpc(() => null);

    await openDashboard(() => null);

    expect(shell.openExternal).toHaveBeenCalledWith(
      "https://tokenops-web-production.up.railway.app",
    );
    expect(shell.openExternal).not.toHaveBeenCalledWith(
      "https://tokenops-api-production.up.railway.app",
    );
  });

  it("tokenops:open-dashboard falls back to cloud.url when no dashboard URL is set", async () => {
    // A single-origin deployment is a real configuration, and this is also
    // the pre-existing behaviour for every config.toml written before
    // `dashboard_url` existed -- upgrading must not break them.
    vi.mocked(loadConfig).mockReturnValue({
      cloud: { url: "https://cloud.example", dashboardUrl: "", ingestToken: "" },
    } as never);
    registerIpc(() => null);

    await openDashboard(() => null);

    expect(shell.openExternal).toHaveBeenCalledWith("https://cloud.example");
  });

  it("tokenops:open-dashboard never forwards a malformed or non-http(s) dashboard URL to the OS shell", async () => {
    // The safety check has to cover the new field too, not just cloud.url --
    // otherwise adding dashboard_url would have opened a hole straight past
    // the guard the test below exists to enforce.
    vi.mocked(loadConfig).mockReturnValue({
      cloud: {
        url: "https://cloud.example",
        dashboardUrl: "file:///C:/Windows/System32/calc.exe",
        ingestToken: "",
      },
    } as never);
    registerIpc(() => null);

    await openDashboard(() => null);

    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("tokenops:open-dashboard never forwards a malformed or non-http(s) cloud.url read from disk to the OS shell", async () => {
    // Same file, same attack surface, whether it's read via a live agent's
    // config or via this disk fallback -- the isSafeExternalUrl check must
    // apply to both paths, not just the live-agent one.
    vi.mocked(loadConfig).mockReturnValue({
      cloud: { url: "file:///C:/Windows/System32/calc.exe", ingestToken: "" },
    } as never);
    registerIpc(() => null);

    await openDashboard(() => null);

    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("tokenops:open-dashboard does nothing when there is no agent handle and no config on disk", async () => {
    // Explicit reset, not a reliance on the mock module's default: the
    // beforeEach above only calls vi.clearAllMocks(), which clears call
    // history but does NOT clear a mockReturnValue set by an earlier test
    // (vi.resetAllMocks() would, but see this file's beforeEach comment for
    // why that's not used here). Without this line, this test would silently
    // inherit the previous test's `file:///...` override instead of
    // exercising the "no config.toml at all" path it's named for.
    //
    // What this test actually proves (verified by mutation, not assumed):
    // deleting ipc.ts's whole `try { ... } catch { return; }` around
    // `loadConfig()` -- letting the throw propagate out of openDashboard --
    // turns this into an uncaught rejection and fails this test. Deleting
    // *only* the bare `return;` inside the catch does NOT fail this test:
    // when loadConfig() throws, the `url = loadConfig().cloud.url`
    // assignment never completes, so `url` is still undefined either way,
    // and the `if (url && isSafeExternalUrl(url))` guard below already
    // no-ops on that. That `return;` is therefore redundant as currently
    // written -- this test (and no behavioral test could) doesn't and can't
    // distinguish its presence from its absence. What matters, and what this
    // test actually guards, is the try/catch as a whole: without it, a
    // missing config.toml (arguably the single most common trigger of the
    // dead-end bug this whole fix addresses) would throw out of
    // `ipcMain.on("tokenops:open-dashboard", ...)`'s fire-and-forget `void
    // openDashboard(getAgent)` call with nothing to catch it.
    vi.mocked(loadConfig).mockImplementation(() => {
      throw new Error("Config not found (test -- no config.toml)");
    });
    registerIpc(() => null);
    await openDashboard(() => null);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("tokenops:open-config opens the real tokenops dir via shell.openPath", async () => {
    registerIpc(() => null);
    listenerFor("tokenops:open-config")({});
    await vi.waitFor(() => {
      expect(shell.openPath).toHaveBeenCalledWith(defaultTokenopsDir());
    });
  });
});
