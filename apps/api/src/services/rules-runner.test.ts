import { describe, it, expect } from "vitest";
import type { UsageEvent } from "@tokenops/shared";
import { enrichEventForRules } from "./rules-runner.js";

function ev(
  partial: Partial<UsageEvent> &
    Pick<UsageEvent, "eventId" | "features" | "inputTokens">,
): UsageEvent {
  return {
    timestamp: "2026-07-01T12:00:00.000Z",
    machineId: "m",
    machineName: "n",
    app: "openai-proxy",
    provider: "openai",
    model: "gpt-4o-mini",
    outputTokens: 10,
    costUsd: 0.001,
    hasContent: false,
    ...partial,
  };
}

describe("enrichEventForRules", () => {
  it("derives newContentRatio from most recent prior when missing", () => {
    const prior = ev({
      eventId: "p",
      inputTokens: 1000,
      features: {
        promptChars: 9000,
        responseChars: 10,
        messageCount: 2,
        codeFenceCount: 0,
        largePasteScore: 0,
        fileDumpScore: 0,
        modelTier: "small",
      },
    });
    const current = ev({
      eventId: "c",
      inputTokens: 2000,
      features: {
        promptChars: 10_000,
        responseChars: 10,
        messageCount: 3,
        codeFenceCount: 0,
        largePasteScore: 0,
        fileDumpScore: 0,
        modelTier: "small",
      },
    });
    const enriched = enrichEventForRules(current, [prior]);
    expect(enriched.features.newContentRatio).toBeCloseTo(0.1, 5);
  });

  it("preserves an explicit newContentRatio", () => {
    const current = ev({
      eventId: "c",
      inputTokens: 100,
      features: {
        promptChars: 100,
        responseChars: 10,
        messageCount: 1,
        codeFenceCount: 0,
        largePasteScore: 0,
        fileDumpScore: 0,
        modelTier: "small",
        newContentRatio: 0.5,
      },
    });
    const prior = ev({
      eventId: "p",
      inputTokens: 50,
      features: {
        promptChars: 90,
        responseChars: 10,
        messageCount: 1,
        codeFenceCount: 0,
        largePasteScore: 0,
        fileDumpScore: 0,
        modelTier: "small",
      },
    });
    const enriched = enrichEventForRules(current, [prior]);
    expect(enriched.features.newContentRatio).toBe(0.5);
  });

  it("leaves event unchanged with empty session context", () => {
    const current = ev({
      eventId: "c",
      inputTokens: 100,
      features: {
        promptChars: 100,
        responseChars: 10,
        messageCount: 1,
        codeFenceCount: 0,
        largePasteScore: 0,
        fileDumpScore: 0,
        modelTier: "small",
      },
    });
    const enriched = enrichEventForRules(current, []);
    expect(enriched.features.newContentRatio).toBeUndefined();
  });
});
