import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UsageEvent } from "@tokenops/shared";
import { Outbox } from "./outbox.js";
import { flushOutbox, sendHeartbeat } from "./flush.js";

function sampleEvent(eventId: string): UsageEvent {
  return {
    eventId,
    timestamp: new Date().toISOString(),
    machineId: "m1",
    machineName: "test",
    app: "openai-proxy",
    provider: "openai",
    model: "gpt-4o-mini",
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.001,
    features: {
      promptChars: 10,
      responseChars: 5,
      messageCount: 1,
      codeFenceCount: 0,
      largePasteScore: 0,
      fileDumpScore: 0,
      modelTier: "small",
    },
    hasContent: false,
  };
}

const dirs: string[] = [];

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenops-flush-"));
  dirs.push(dir);
  return join(dir, "outbox.db");
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("flushOutbox", () => {
  it("marks sent on 200", async () => {
    const outbox = new Outbox(tmpDb());
    outbox.enqueue(sampleEvent("e1"));
    expect(outbox.pendingCount()).toBe(1);

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ accepted: 1, duplicates: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await flushOutbox({
      outbox,
      cloudUrl: "http://cloud.test",
      ingestToken: "pat_test",
      fetchImpl,
    });

    expect(result.sent).toBe(1);
    expect(result.error).toBeUndefined();
    expect(outbox.pendingCount()).toBe(0);
    expect(outbox.listPending(10)).toHaveLength(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://cloud.test/v1/events");
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer pat_test");
    const body = JSON.parse(String(calls[0]!.init?.body)) as {
      events: UsageEvent[];
    };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.eventId).toBe("e1");

    outbox.close();
  });

  it("marks failed and keeps pending on non-2xx", async () => {
    const outbox = new Outbox(tmpDb());
    outbox.enqueue(sampleEvent("e2"));

    const fetchImpl: typeof fetch = async () => {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await flushOutbox({
      outbox,
      cloudUrl: "http://cloud.test/",
      ingestToken: "bad",
      fetchImpl,
    });

    expect(result.sent).toBe(0);
    expect(result.error).toMatch(/HTTP 401/);
    expect(outbox.pendingCount()).toBe(1);
    expect(outbox.latestError()).toMatch(/HTTP 401/);
    outbox.close();
  });

  it("marks failed on network error", async () => {
    const outbox = new Outbox(tmpDb());
    outbox.enqueue(sampleEvent("e3"));

    const fetchImpl: typeof fetch = async () => {
      throw new Error("network down");
    };

    const result = await flushOutbox({
      outbox,
      cloudUrl: "http://cloud.test",
      ingestToken: "pat",
      fetchImpl,
    });

    expect(result.sent).toBe(0);
    expect(result.error).toBe("network down");
    expect(outbox.pendingCount()).toBe(1);
    outbox.close();
  });

  it("no-ops when outbox empty", async () => {
    const outbox = new Outbox(tmpDb());
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    const result = await flushOutbox({
      outbox,
      cloudUrl: "http://cloud.test",
      ingestToken: "pat",
      fetchImpl,
    });
    expect(result.sent).toBe(0);
    expect(called).toBe(false);
    outbox.close();
  });
});

describe("sendHeartbeat", () => {
  it("posts machine heartbeat on 200", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const result = await sendHeartbeat({
      cloudUrl: "http://cloud.test",
      ingestToken: "pat_hb",
      machineId: "m1",
      machineName: "desk",
      queueDepth: 3,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toBe("http://cloud.test/v1/heartbeats");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer pat_hb");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      machineId: "m1",
      machineName: "desk",
      queueDepth: 3,
    });
  });

  it("returns error on failure", async () => {
    const fetchImpl: typeof fetch = async () => {
      return new Response("nope", { status: 500 });
    };

    const result = await sendHeartbeat({
      cloudUrl: "http://cloud.test",
      ingestToken: "pat",
      machineId: "m1",
      machineName: "desk",
      queueDepth: 0,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTTP 500/);
  });
});
