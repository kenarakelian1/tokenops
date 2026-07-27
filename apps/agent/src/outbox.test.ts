import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UsageEvent } from "@tokenops/shared";
import { Outbox } from "./outbox.js";

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
  const dir = mkdtempSync(join(tmpdir(), "tokenops-outbox-"));
  dirs.push(dir);
  return join(dir, "outbox.db");
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("Outbox", () => {
  it("enqueue and list pending", () => {
    const ob = new Outbox(tmpDb());
    ob.enqueue(sampleEvent("e1"));
    expect(ob.listPending(10)).toHaveLength(1);
    ob.markSent(["e1"]);
    expect(ob.listPending(10)).toHaveLength(0);
    ob.close();
  });

  it("preserves payload fields", () => {
    const ob = new Outbox(tmpDb());
    const event = sampleEvent("e2");
    ob.enqueue(event);
    const pending = ob.listPending(10);
    expect(pending[0]?.eventId).toBe("e2");
    expect(pending[0]?.model).toBe("gpt-4o-mini");
    expect(pending[0]?.inputTokens).toBe(10);
    ob.close();
  });

  it("markFailed keeps event pending for retry", () => {
    const ob = new Outbox(tmpDb());
    ob.enqueue(sampleEvent("e3"));
    ob.markFailed("e3", "network down");
    expect(ob.listPending(10)).toHaveLength(1);
    expect(ob.pendingCount()).toBe(1);
    ob.close();
  });

  it("listPending respects limit and order", () => {
    const ob = new Outbox(tmpDb());
    ob.enqueue(sampleEvent("a"));
    ob.enqueue(sampleEvent("b"));
    ob.enqueue(sampleEvent("c"));
    const first = ob.listPending(2);
    expect(first).toHaveLength(2);
    expect(first.map((e) => e.eventId)).toEqual(["a", "b"]);
    ob.close();
  });

  it("re-enqueue after sent restores pending", () => {
    const ob = new Outbox(tmpDb());
    ob.enqueue(sampleEvent("e4"));
    ob.markSent(["e4"]);
    expect(ob.listPending(10)).toHaveLength(0);
    ob.enqueue(sampleEvent("e4"));
    expect(ob.listPending(10)).toHaveLength(1);
    ob.close();
  });
});
