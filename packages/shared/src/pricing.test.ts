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
  });

  describe("Claude Sonnet 5 introductory pricing (expires 2026-08-31)", () => {
    it("uses the $2/$10 intro rate before the expiry", () => {
      const before = new Date("2026-08-15T00:00:00Z");
      const cost = estimateCostUsd(
        "claude-sonnet-5",
        1_000_000,
        0,
        undefined,
        before,
      );
      expect(cost).toBe(2);
    });

    it("uses the standard $3/$15 rate on/after the expiry", () => {
      const after = new Date("2026-09-01T00:00:00Z");
      const cost = estimateCostUsd(
        "claude-sonnet-5",
        1_000_000,
        0,
        undefined,
        after,
      );
      expect(cost).toBe(3);
    });

    it("lets an explicit override win over the date gate", () => {
      const before = new Date("2026-08-15T00:00:00Z");
      const cost = estimateCostUsd(
        "claude-sonnet-5",
        1_000_000,
        0,
        { "claude-sonnet-5": { inputPerMTok: 99, outputPerMTok: 1 } },
        before,
      );
      expect(cost).toBe(99);
    });
  });

  describe("cache-aware pricing (cache reads/creates priced below/above the base input rate)", () => {
    it("prices cache reads at 0.1x and cache creation at 1.25x the input rate instead of the full rate", () => {
      // Real profile: 0.2M raw input, 20M cache-read, 1M cache-creation,
      // 0.3M output on claude-opus-5[1m] ($5/$25 per 1M) over a week.
      // inputTokens folds cache into the ledger total (21.2M) — see
      // claude-otel.ts's doc comment — so the pre-fix full-price estimate
      // priced all 21.2M at the $5/1M input rate: 21.2 * 5 + 0.3 * 25 =
      // 113.5, 4.6x the real $24.75 bill.
      const rawInput = 200_000;
      const cacheReadTokens = 20_000_000;
      const cacheCreationTokens = 1_000_000;
      const inputTokens = rawInput + cacheReadTokens + cacheCreationTokens; // 21.2M
      const outputTokens = 300_000;

      const withoutBreakdown = estimateCostUsd(
        "claude-opus-5[1m]",
        inputTokens,
        outputTokens,
      );
      expect(withoutBreakdown).toBeCloseTo(113.5, 5);

      const withBreakdown = estimateCostUsd(
        "claude-opus-5[1m]",
        inputTokens,
        outputTokens,
        undefined,
        undefined,
        { cacheReadTokens, cacheCreationTokens },
      );
      // 0.2M*5 + 20M*5*0.1 + 1M*5*1.25 + 0.3M*25 = 1 + 10 + 6.25 + 7.5 = 24.75
      expect(withBreakdown).toBeCloseTo(24.75, 5);
    });

    it("treats a null cache breakdown the same as an absent one (full input rate applies)", () => {
      const cost = estimateCostUsd(
        "claude-opus-5[1m]",
        1_000_000,
        0,
        undefined,
        undefined,
        { cacheReadTokens: null, cacheCreationTokens: null },
      );
      expect(cost).toBeCloseTo(5, 5);
    });

    it("does not change behavior for callers that omit the cache breakdown entirely", () => {
      // Every pre-existing call site (2-5 positional args) must keep
      // working unchanged now that a 6th trailing options param exists.
      const cost = estimateCostUsd("gpt-4o-mini", 1_000_000, 0);
      expect(cost).toBeGreaterThan(0);
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

  describe("gpt-4 family beyond gpt-4o", () => {
    // getModelTier() (model-tier.ts) tags any "gpt-4*" except gpt-4o-mini as
    // frontier via /gpt-4(?!o-mini)/i. cheaperSiblingModel must recognize
    // the same surface, or a bare "gpt-4"/"gpt-4-turbo" event is frontier
    // but gets no sibling and no actionable recommendation.
    it("suggests gpt-4o-mini for a bare gpt-4 model", () => {
      expect(cheaperSiblingModel("gpt-4")).toBe("gpt-4o-mini");
    });

    it("suggests gpt-4o-mini for gpt-4-turbo", () => {
      expect(cheaperSiblingModel("gpt-4-turbo")).toBe("gpt-4o-mini");
    });

    it("still returns null for gpt-4o-mini itself", () => {
      expect(cheaperSiblingModel("gpt-4o-mini")).toBeNull();
    });
  });
});
