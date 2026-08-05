import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

const stats = {
  today: { inputTokens: 1200, outputTokens: 340, estimatedUsd: 0.0123, eventCount: 7 },
  byApp: [{ app: "claude-code", inputTokens: 1200, outputTokens: 340 }],
  byModel: [{ model: "claude-sonnet-4", inputTokens: 1200, outputTokens: 340 }],
  queue: { pending: 0, lastError: null },
  recent: [],
};

const baseStatus = {
  machineName: "KENDESKTOP",
  cloudUrl: "https://tokenops-web-production.up.railway.app",
  ingestTokenPresent: true,
  upstreamKeyPresent: true,
  proxyListen: "127.0.0.1:8787",
  otelListen: "127.0.0.1:4318",
  claudeCodeWatching: true,
};

function mockApi(over: Partial<typeof baseStatus> = {}, s = stats) {
  (globalThis as never as { tokenops: unknown }).tokenops = {
    getStats: vi.fn().mockResolvedValue(s),
    getStatus: vi.fn().mockResolvedValue({ ...baseStatus, ...over }),
    openDashboard: vi.fn(),
    openConfigFolder: vi.fn(),
  };
}

describe("App", () => {
  it("shows today's token totals", async () => {
    mockApi();
    render(<App />);
    expect(await screen.findByText(/1,200/)).toBeInTheDocument();
  });

  it("warns when the proxy has no upstream key", async () => {
    mockApi({ upstreamKeyPresent: false });
    render(<App />);
    expect(await screen.findByText(/upstream calls will fail auth/i)).toBeInTheDocument();
  });

  it("warns when no ingest token is set", async () => {
    mockApi({ ingestTokenPresent: false });
    render(<App />);
    expect(await screen.findByText(/not shipping to the cloud/i)).toBeInTheDocument();
  });

  it("surfaces a queue error", async () => {
    mockApi({}, { ...stats, queue: { pending: 4, lastError: "cloud unreachable" } });
    render(<App />);
    expect(await screen.findByText(/cloud unreachable/i)).toBeInTheDocument();
  });
});
