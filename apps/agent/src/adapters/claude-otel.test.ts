import http from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { UsageEvent } from "@tokenops/shared";
import {
  ClaudeOtelState,
  extractClaudeCounters,
  startClaudeOtelServer,
} from "./claude-otel.js";

const servers: http.Server[] = [];

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop();
    if (!s) continue;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

function sampleExport(input: number, output: number, model = "claude-sonnet-4") {
  return {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.token.usage",
                sum: {
                  dataPoints: [
                    {
                      asInt: String(input),
                      attributes: [
                        { key: "type", value: { stringValue: "input" } },
                        { key: "model", value: { stringValue: model } },
                      ],
                    },
                    {
                      asInt: String(output),
                      attributes: [
                        { key: "type", value: { stringValue: "output" } },
                        { key: "model", value: { stringValue: model } },
                      ],
                    },
                  ],
                },
              },
              {
                name: "claude_code.cost.usage",
                sum: {
                  dataPoints: [
                    {
                      asDouble: 0.0123,
                      attributes: [
                        { key: "model", value: { stringValue: model } },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("extractClaudeCounters", () => {
  it("reads token and cost data points", () => {
    const { tokens, costs } = extractClaudeCounters(sampleExport(100, 40));
    expect(tokens).toHaveLength(2);
    expect(tokens.find((t) => t.type === "input")?.value).toBe(100);
    expect(tokens.find((t) => t.type === "output")?.value).toBe(40);
    expect(costs[0]?.value).toBeCloseTo(0.0123);
  });
});

describe("ClaudeOtelState", () => {
  it("emits events for counter deltas only", () => {
    const state = new ClaudeOtelState("m1", "desktop");
    const first = state.ingest(sampleExport(100, 40));
    expect(first).toHaveLength(1);
    expect(first[0]!.app).toBe("claude-code");
    expect(first[0]!.inputTokens).toBe(100);
    expect(first[0]!.outputTokens).toBe(40);
    expect(first[0]!.costUsd).toBeCloseTo(0.0123);
    expect(first[0]!.model).toBe("claude-sonnet-4");

    // Same cumulative → no new events
    expect(state.ingest(sampleExport(100, 40))).toHaveLength(0);

    // Growth → delta only
    const second = state.ingest(sampleExport(150, 55));
    expect(second).toHaveLength(1);
    expect(second[0]!.inputTokens).toBe(50);
    expect(second[0]!.outputTokens).toBe(15);
  });
});

describe("startClaudeOtelServer", () => {
  it("accepts OTLP HTTP JSON metrics and emits events", async () => {
    const events: UsageEvent[] = [];
    const server = await startClaudeOtelServer({
      listen: "127.0.0.1:0",
      machineId: "m",
      machineName: "t",
      onEvent: (e) => events.push(e),
    });
    servers.push(server);
    // Fix listen 0 — server bound with port 0 needs actual address
    const addr = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;

    const res = await fetch(`${base}/v1/metrics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleExport(200, 80)),
    });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]!.inputTokens).toBe(200);
    expect(events[0]!.provider).toBe("anthropic");
  });
});
