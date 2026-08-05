import { describe, it, expect } from "vitest";
import { cheaperSiblingModel, estimateCostUsd } from "./pricing.js";

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

  describe("Claude 5 family (production model strings)", () => {
    // Verified from the live database: these four literal strings are what
    // production actually sends. Each must resolve to a non-null price.
    it("prices claude-opus-5[1m] (bracketed context-window suffix)", () => {
      expect(estimateCostUsd("claude-opus-5[1m]", 1_000_000, 0)).toBeGreaterThan(0);
    });

    it("prices claude-sonnet-5", () => {
      expect(estimateCostUsd("claude-sonnet-5", 1_000_000, 0)).toBeGreaterThan(0);
    });

    it("prices claude-haiku-4-5-20251001 (dated snapshot suffix)", () => {
      expect(
        estimateCostUsd("claude-haiku-4-5-20251001", 1_000_000, 0),
      ).toBeGreaterThan(0);
    });

    it("prices claude-sonnet-4", () => {
      expect(estimateCostUsd("claude-sonnet-4", 1_000_000, 0)).toBeGreaterThan(0);
    });

    it("prices the Claude 5 family, including the 1m-context variant", () => {
      expect(estimateCostUsd("claude-opus-5[1m]", 1_000_000, 0)).toBeGreaterThan(0);
      expect(estimateCostUsd("claude-sonnet-5", 1_000_000, 0)).toBeGreaterThan(0);
    });
  });
});

describe("cheaperSiblingModel", () => {
  it("suggests a cheaper model from the SAME vendor", () => {
    expect(cheaperSiblingModel("claude-opus-5[1m]")).toMatch(/claude/);
    expect(cheaperSiblingModel("gpt-4o")).toMatch(/gpt/);
  });

  it("suggests haiku for a sonnet-tier model", () => {
    expect(cheaperSiblingModel("claude-sonnet-5")).toBe("claude-haiku-4-5");
  });

  it("returns null rather than a wrong number for an unknown model", () => {
    expect(estimateCostUsd("totally-made-up-model", 1000, 1000)).toBeNull();
    expect(cheaperSiblingModel("totally-made-up-model")).toBeNull();
  });

  it("returns null when the model is already the cheapest in its family", () => {
    expect(cheaperSiblingModel("claude-haiku-4-5-20251001")).toBeNull();
    expect(cheaperSiblingModel("gpt-4o-mini")).toBeNull();
  });
});
