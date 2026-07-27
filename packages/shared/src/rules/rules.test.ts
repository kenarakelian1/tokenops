import { describe, it, expect } from "vitest";
import { runRules } from "./index.js";
import type { UsageEvent } from "../schema/event.js";

function ev(
  partial: Partial<UsageEvent> &
    Pick<
      UsageEvent,
      "eventId" | "model" | "inputTokens" | "outputTokens" | "features"
    >,
): UsageEvent {
  return {
    timestamp: new Date().toISOString(),
    machineId: "m",
    machineName: "n",
    app: "openai-proxy",
    provider: "openai",
    costUsd: 0.01,
    hasContent: false,
    ...partial,
  };
}

describe("runRules", () => {
  it("flags frontier for trivial", () => {
    const hits = runRules(
      ev({
        eventId: "a",
        model: "gpt-4o",
        inputTokens: 20,
        outputTokens: 10,
        features: {
          promptChars: 40,
          responseChars: 20,
          messageCount: 1,
          codeFenceCount: 0,
          largePasteScore: 0,
          fileDumpScore: 0,
          modelTier: "frontier",
        },
      }),
    );
    expect(hits.some((h) => h.ruleId === "frontier_trivial")).toBe(true);
  });

  it("flags full document io", () => {
    const hits = runRules(
      ev({
        eventId: "b",
        model: "gpt-4o-mini",
        inputTokens: 12_000,
        outputTokens: 100,
        features: {
          promptChars: 40_000,
          responseChars: 200,
          messageCount: 2,
          codeFenceCount: 8,
          largePasteScore: 0.9,
          fileDumpScore: 0.8,
          modelTier: "small",
        },
      }),
    );
    expect(hits.some((h) => h.ruleId === "full_document_io")).toBe(true);
  });

  it("flags context bloat with session history", () => {
    const session: UsageEvent[] = [
      ev({
        eventId: "s1",
        model: "gpt-4o-mini",
        inputTokens: 1000,
        outputTokens: 50,
        sessionId: "S",
        features: {
          promptChars: 1000,
          responseChars: 50,
          messageCount: 2,
          codeFenceCount: 0,
          largePasteScore: 0,
          fileDumpScore: 0,
          modelTier: "small",
          newContentRatio: 1,
        },
      }),
      ev({
        eventId: "s2",
        model: "gpt-4o-mini",
        inputTokens: 1500,
        outputTokens: 50,
        sessionId: "S",
        features: {
          promptChars: 1500,
          responseChars: 50,
          messageCount: 4,
          codeFenceCount: 0,
          largePasteScore: 0,
          fileDumpScore: 0,
          modelTier: "small",
          newContentRatio: 0.2,
        },
      }),
    ];
    const current = ev({
      eventId: "s3",
      model: "gpt-4o-mini",
      inputTokens: 3000,
      outputTokens: 50,
      sessionId: "S",
      features: {
        promptChars: 3000,
        responseChars: 50,
        messageCount: 6,
        codeFenceCount: 0,
        largePasteScore: 0,
        fileDumpScore: 0,
        modelTier: "small",
        newContentRatio: 0.1,
      },
    });
    const hits = runRules(current, session);
    expect(hits.some((h) => h.ruleId === "context_bloat")).toBe(true);
  });

  it("returns empty for normal mid-size call", () => {
    const hits = runRules(
      ev({
        eventId: "c",
        model: "gpt-4o-mini",
        inputTokens: 800,
        outputTokens: 200,
        features: {
          promptChars: 2000,
          responseChars: 500,
          messageCount: 4,
          codeFenceCount: 1,
          largePasteScore: 0.1,
          fileDumpScore: 0.1,
          modelTier: "small",
        },
      }),
    );
    expect(hits).toEqual([]);
  });
});
