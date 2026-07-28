import { describe, it, expect } from "vitest";
import { estimateCostUsd } from "./pricing.js";

describe("estimateCostUsd", () => {
  it("computes from default gpt-4o-mini prices", () => {
    const cost = estimateCostUsd("gpt-4o-mini", 1_000_000, 0);
    expect(cost).toBeTypeOf("number");
    expect(cost!).toBeGreaterThan(0);
  });

  it("returns null for unknown model", () => {
    expect(estimateCostUsd("totally-unknown-model-xyz", 100, 100)).toBeNull();
  });

  it("respects overrides", () => {
    const cost = estimateCostUsd("custom-m", 1_000_000, 0, {
      "custom-m": { inputPerMTok: 1, outputPerMTok: 2 },
    });
    expect(cost).toBe(1);
  });

  it("prices grok models", () => {
    const cost = estimateCostUsd("grok-4", 1_000_000, 0);
    expect(cost).toBeTypeOf("number");
    expect(cost!).toBeGreaterThan(0);
  });
});
