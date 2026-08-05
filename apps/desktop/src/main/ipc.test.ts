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
}));

import { ipcMain, shell } from "electron";
import { readLocalStats, defaultOutboxPath } from "@tokenops/agent";
import { registerIpc } from "./ipc.js";

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
}): AgentHandle {
  return {
    outbox: {} as AgentHandle["outbox"],
    machineId: "machine-1",
    machineName: "KENDESKTOP",
    stop: vi.fn(),
    tick: vi.fn(),
    config: {
      cloud: { url: "https://cloud.example", ingestToken: over?.ingestToken ?? SECRET_PAT },
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

  it("tokenops:open-dashboard forwards the URL to shell.openExternal", () => {
    registerIpc(() => null);
    listenerFor("tokenops:open-dashboard")({}, "https://cloud.example");
    expect(shell.openExternal).toHaveBeenCalledWith("https://cloud.example");
  });

  it("tokenops:open-config opens the config folder via shell.openPath", () => {
    registerIpc(() => null);
    listenerFor("tokenops:open-config")({});
    expect(shell.openPath).toHaveBeenCalledTimes(1);
  });
});
