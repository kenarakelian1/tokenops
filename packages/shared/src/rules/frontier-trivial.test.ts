import { describe, it, expect } from "vitest";
import { frontierTrivialRule } from "./frontier-trivial.js";
import type { UsageEvent } from "../schema/event.js";

const CTX = { now: new Date("2026-09-15T00:00:00Z") };

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
    costUsd: null,
    hasContent: false,
    ...partial,
  };
}

const trivialFeatures = {
  modelTier: "frontier" as const,
  messageCount: 1,
  largePasteScore: 0,
  promptChars: 40,
  responseChars: 20,
  codeFenceCount: 0,
  fileDumpScore: 0,
};

describe("frontierTrivialRule", () => {
  it("flags a trivial Claude Opus call and names the in-vendor sibling", () => {
    const finding = frontierTrivialRule.evaluate(
      ev({
        eventId: "a",
        model: "claude-opus-5[1m]",
        inputTokens: 20,
        outputTokens: 10,
        features: trivialFeatures,
      }),
      CTX,
    );
    expect(finding).not.toBeNull();
    expect(finding?.detail).toContain("claude-sonnet-5");
  });

  it("suppresses the recommendation for a trivial grok-4 call — no in-vendor cheaper sibling exists", () => {
    // getModelTier() (model-tier.ts) tags grok-4/grok-3 as "frontier", but
    // cheaperSiblingModel has no xAI branch, so there is nothing actionable
    // to suggest for a Grok user. Before the "no sibling -> suppress" guard
    // was added, this rule compared every frontier-tier trivial call against
    // a hardcoded "gpt-4o-mini" regardless of vendor, so this case used to
    // produce a hit the user could not act on.
    const finding = frontierTrivialRule.evaluate(
      ev({
        eventId: "b",
        model: "grok-4",
        inputTokens: 20,
        outputTokens: 10,
        features: trivialFeatures,
      }),
      CTX,
    );
    expect(finding).toBeNull();
  });
});
