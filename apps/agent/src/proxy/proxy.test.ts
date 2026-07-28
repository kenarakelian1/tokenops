import http from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { UsageEvent } from "@tokenops/shared";
import { startProxy } from "./server.js";
import {
  appFromUpstream,
  buildUsageEvent,
  estimateTokensFromText,
  isXaiUpstream,
  normalizeUpstreamBase,
  parseSseUsage,
  providerFromUpstream,
  resolveUpstreamApiKey,
  sessionIdFromRequest,
} from "./handler.js";

const servers: http.Server[] = [];

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(addr.port);
    });
    server.on("error", reject);
  });
}

function proxyPort(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop();
    if (!s) continue;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

describe("providerFromUpstream", () => {
  it("detects openai host", () => {
    expect(providerFromUpstream("https://api.openai.com")).toBe("openai");
    expect(providerFromUpstream("https://api.openai.com/v1")).toBe("openai");
  });

  it("detects xAI / Grok host", () => {
    expect(isXaiUpstream("https://api.x.ai/v1")).toBe(true);
    expect(providerFromUpstream("https://api.x.ai/v1")).toBe("xai");
    expect(appFromUpstream("https://api.x.ai/v1")).toBe("grok-proxy");
    expect(appFromUpstream("https://api.openai.com")).toBe("openai-proxy");
  });

  it("normalizes xAI base to include /v1", () => {
    expect(normalizeUpstreamBase("https://api.x.ai")).toBe("https://api.x.ai/v1");
    expect(normalizeUpstreamBase("https://api.x.ai/v1")).toBe("https://api.x.ai/v1");
  });

  it("resolves XAI_API_KEY for xAI upstream", () => {
    const r = resolveUpstreamApiKey("https://api.x.ai/v1", {
      XAI_API_KEY: "xai-secret",
      OPENAI_API_KEY: "sk-other",
    } as NodeJS.ProcessEnv);
    expect(r.source).toBe("XAI_API_KEY");
    expect(r.apiKey).toBe("xai-secret");
  });

  it("falls back for other hosts", () => {
    expect(providerFromUpstream("http://127.0.0.1:9999")).toBe("127.0.0.1");
  });
});

describe("buildUsageEvent grok", () => {
  it("labels app as grok-proxy for xAI upstream", () => {
    const event = buildUsageEvent({
      machineId: "m",
      machineName: "t",
      upstream: "https://api.x.ai/v1",
      requestBody: {
        model: "grok-4",
        messages: [{ role: "user", content: "hi" }],
      },
      responseBody: {
        id: "chatcmpl_g",
        choices: [{ message: { role: "assistant", content: "yo" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      },
      latencyMs: 5,
    });
    expect(event.app).toBe("grok-proxy");
    expect(event.provider).toBe("xai");
    expect(event.model).toBe("grok-4");
  });
});

describe("sessionIdFromRequest", () => {
  it("reads session_id and metadata", () => {
    expect(
      sessionIdFromRequest({
        model: "x",
        session_id: "s1",
        messages: [],
      }),
    ).toBe("s1");
    expect(
      sessionIdFromRequest({
        model: "x",
        metadata: { sessionId: "s2" },
        messages: [],
      }),
    ).toBe("s2");
    expect(
      sessionIdFromRequest({
        model: "x",
        user: "u1",
        messages: [],
      }),
    ).toBe("u1");
  });
});

describe("buildUsageEvent session", () => {
  it("attaches sessionId when present on request", () => {
    const event = buildUsageEvent({
      machineId: "m",
      machineName: "t",
      upstream: "https://api.openai.com",
      requestBody: {
        model: "gpt-4o-mini",
        session_id: "sess-abc",
        messages: [{ role: "user", content: "hi" }],
      },
      responseBody: {
        id: "chatcmpl_1",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      latencyMs: 10,
    });
    expect(event.sessionId).toBe("sess-abc");
  });
});

describe("parseSseUsage", () => {
  it("extracts text and usage from SSE", () => {
    const sse = [
      'data: {"id":"chatcmpl_s","choices":[{"delta":{"content":"hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
      "data: [DONE]",
      "",
    ].join("\n");
    const r = parseSseUsage(sse);
    expect(r.text).toBe("hello");
    expect(r.usage?.prompt_tokens).toBe(3);
    expect(r.usage?.completion_tokens).toBe(2);
    expect(r.id).toBe("chatcmpl_s");
  });
});

describe("startProxy", () => {
  it("proxies chat and emits event with tokens", async () => {
    let upstreamAuth: string | undefined;
    const upstream = http.createServer((req, res) => {
      upstreamAuth = req.headers.authorization;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "chatcmpl_test",
          choices: [{ message: { role: "assistant", content: "hi" } }],
          usage: { prompt_tokens: 11, completion_tokens: 2 },
        }),
      );
    });
    servers.push(upstream);
    const port = await listen(upstream);

    const events: UsageEvent[] = [];
    const proxy = await startProxy({
      listen: "127.0.0.1:0",
      upstream: `http://127.0.0.1:${port}`,
      apiKey: "sk-test-secret-key",
      onEvent: (e) => events.push(e),
      machineId: "m",
      machineName: "t",
    });
    servers.push(proxy);

    const pPort = proxyPort(proxy);
    const res = await fetch(`http://127.0.0.1:${pPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.choices[0]?.message.content).toBe("hi");

    expect(upstreamAuth).toBe("Bearer sk-test-secret-key");
    expect(events).toHaveLength(1);
    expect(events[0]!.inputTokens).toBe(11);
    expect(events[0]!.outputTokens).toBe(2);
    expect(events[0]!.app).toBe("openai-proxy");
    expect(events[0]!.machineId).toBe("m");
    expect(events[0]!.machineName).toBe("t");
    expect(events[0]!.model).toBe("gpt-4o-mini");
    expect(events[0]!.hasContent).toBe(true);
    expect(events[0]!.features.messageCount).toBe(1);
    expect(events[0]!.costUsd).not.toBeNull();

    // Never put API key in onEvent payload
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain("sk-test-secret-key");
    expect(serialized).not.toContain("Bearer");
  });

  it("estimates tokens when usage missing", async () => {
    const upstream = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "chatcmpl_no_usage",
          choices: [{ message: { role: "assistant", content: "abcd" } }],
        }),
      );
    });
    servers.push(upstream);
    const port = await listen(upstream);

    const events: UsageEvent[] = [];
    const proxy = await startProxy({
      listen: "127.0.0.1:0",
      upstream: `http://127.0.0.1:${port}`,
      apiKey: "sk-x",
      onEvent: (e) => events.push(e),
      machineId: "m",
      machineName: "t",
    });
    servers.push(proxy);

    const pPort = proxyPort(proxy);
    const res = await fetch(`http://127.0.0.1:${pPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello world!!" }], // 13 chars
      }),
    });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]!.inputTokens).toBe(estimateTokensFromText("hello world!!"));
    expect(events[0]!.outputTokens).toBe(estimateTokensFromText("abcd"));
  });

  it("proxies stream and best-effort parses usage", async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'data: {"id":"chatcmpl_stream","choices":[{"delta":{"content":"yo"}}]}\n\n',
      );
      res.write(
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n',
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
    servers.push(upstream);
    const port = await listen(upstream);

    const events: UsageEvent[] = [];
    const proxy = await startProxy({
      listen: "127.0.0.1:0",
      upstream: `http://127.0.0.1:${port}`,
      apiKey: "sk-stream",
      onEvent: (e) => events.push(e),
      machineId: "m",
      machineName: "t",
    });
    servers.push(proxy);

    const pPort = proxyPort(proxy);
    const res = await fetch(`http://127.0.0.1:${pPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("yo");

    expect(events).toHaveLength(1);
    expect(events[0]!.inputTokens).toBe(5);
    expect(events[0]!.outputTokens).toBe(1);
    expect(events[0]!.app).toBe("openai-proxy");
    expect(JSON.stringify(events[0])).not.toContain("sk-stream");
  });
});
