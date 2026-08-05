import { describe, it, expect } from "vitest";
import { runAggregateRules, checkFrontierShare } from "./index.js";
import type { AggregateWindow, ModelWindowTotals } from "./index.js";

const window = (byModel: ModelWindowTotals[]): AggregateWindow => ({
  start: "2026-07-29T00:00:00.000Z",
  end: "2026-08-05T00:00:00.000Z",
  byModel,
});

describe("runAggregateRules", () => {
  it("flags a token mix dominated by frontier models", () => {
    const hits = runAggregateRules(
      window([
        {
          model: "claude-opus-5[1m]",
          modelTier: "frontier",
          inputTokens: 120_000_000,
          outputTokens: 2_000_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 900,
        },
        {
          model: "claude-haiku-4-5",
          modelTier: "small",
          inputTokens: 28_000,
          outputTokens: 800,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.1,
        },
      ]),
    );
    const hit = hits.find((h) => h.ruleId === "frontier_share");
    expect(hit).toBeDefined();
    expect(hit!.detail).toMatch(/9\d%/); // states the actual share
    expect(hit!.detail).toMatch(/claude/i); // names an in-vendor alternative
  });

  it("stays silent on a balanced mix", () => {
    const hits = runAggregateRules(
      window([
        {
          model: "claude-opus-5[1m]",
          modelTier: "frontier",
          inputTokens: 10_000,
          outputTokens: 1_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 1,
        },
        {
          model: "claude-sonnet-5",
          modelTier: "mid",
          inputTokens: 90_000,
          outputTokens: 9_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 1,
        },
      ]),
    );
    expect(hits.find((h) => h.ruleId === "frontier_share")).toBeUndefined();
  });

  it("does not misattribute the percentage or price cross-vendor tokens against one sibling's rate", () => {
    // Two different frontier-tier vendors, each short of 80% alone but
    // dominant together. Before the fix: the detail named only the opus
    // model while stating the COMBINED share, and estimatedWastedUsd priced
    // gpt-4's tokens as if they were claude-sonnet-5 tokens.
    const before = new Date("2026-08-15T00:00:00Z"); // Sonnet 5 intro rate active
    const hits = runAggregateRules(
      window([
        {
          model: "claude-opus-5[1m]",
          modelTier: "frontier",
          inputTokens: 400_000,
          outputTokens: 100_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 50,
        },
        {
          model: "gpt-4",
          modelTier: "frontier",
          inputTokens: 400_000,
          outputTokens: 50_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 40,
        },
        {
          model: "claude-haiku-4-5",
          modelTier: "small",
          inputTokens: 45_000,
          outputTokens: 5_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 1,
        },
      ]),
      before,
    );
    const hit = hits.find((h) => h.ruleId === "frontier_share");
    expect(hit).toBeDefined();
    // Combined frontier share (95%) is stated, but hedged as "the largest
    // being X" rather than implying the percentage is X's alone.
    expect(hit!.detail).toMatch(/95%/);
    expect(hit!.detail).toMatch(/largest being claude-opus-5\[1m\]/);
    // Savings price ONLY the dominant model's (opus's) own 400k/100k tokens
    // against claude-sonnet-5's intro rate ($2/$10 per 1M): 400k*2/1e6 +
    // 100k*10/1e6 = 0.8 + 1 = 1.8. dominant cost (50, given directly) minus
    // that = 48.2. The pre-fix computation summed both vendors' cost (90)
    // and priced both vendors' combined tokens at sonnet's rate, yielding
    // 86.9 instead — a different, cross-vendor-contaminated number.
    expect(hit!.estimatedWastedUsd).toBeCloseTo(48.2, 5);
  });

  describe("Sonnet 5 introductory pricing threaded through via `now`", () => {
    const singleOpusWindow = window([
      {
        model: "claude-opus-5[1m]",
        modelTier: "frontier",
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: null,
      },
    ]);

    it("prices the sibling at the intro rate before the expiry", () => {
      const hit = checkFrontierShare(
        singleOpusWindow,
        new Date("2026-08-15T00:00:00Z"),
      );
      // opus cost: 1,000,000 * $5/1M = 5. sonnet intro: 1,000,000 * $2/1M = 2.
      expect(hit!.estimatedWastedUsd).toBeCloseTo(3, 5);
    });

    it("prices the sibling at the standard rate on/after the expiry", () => {
      const hit = checkFrontierShare(
        singleOpusWindow,
        new Date("2026-09-01T00:00:00Z"),
      );
      // opus cost: 1,000,000 * $5/1M = 5. sonnet standard: 1,000,000 * $3/1M = 3.
      expect(hit!.estimatedWastedUsd).toBeCloseTo(2, 5);
    });
  });

  it("flags poor cache reuse", () => {
    const hits = runAggregateRules(
      window([
        {
          model: "claude-opus-5[1m]",
          modelTier: "frontier",
          inputTokens: 1_000_000,
          outputTokens: 50_000,
          cacheReadTokens: 10_000,
          cacheCreationTokens: 5_000,
          costUsd: 90,
        },
      ]),
    );
    expect(hits.find((h) => h.ruleId === "cache_efficiency")).toBeDefined();
  });

  it("is silent about cache when no breakdown was ever recorded (null), not reporting 0%", () => {
    // Pre-migration events have no cache breakdown at all: null, not 0.
    // Silence, not a false finding.
    const hits = runAggregateRules(
      window([
        {
          model: "claude-opus-5[1m]",
          modelTier: "frontier",
          inputTokens: 1_000_000,
          outputTokens: 50_000,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          costUsd: 90,
        },
      ]),
    );
    expect(hits.find((h) => h.ruleId === "cache_efficiency")).toBeUndefined();
  });

  it("flags genuinely zero cache reuse when the breakdown was recorded as 0", () => {
    // Post-migration, a recorded 0 is a real finding: you're paying full
    // price for context on every call. This must NOT be silenced the way
    // an absent (null) breakdown is.
    const hits = runAggregateRules(
      window([
        {
          model: "claude-opus-5[1m]",
          modelTier: "frontier",
          inputTokens: 1_000_000,
          outputTokens: 50_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 90,
        },
      ]),
    );
    expect(hits.find((h) => h.ruleId === "cache_efficiency")).toBeDefined();
  });

  it("drops a cache-reuse gap that doesn't clear the materiality floor", () => {
    // readRatio = 5,500 / 12,000 ≈ 0.458 < 0.5, so checkCacheEfficiency
    // itself would produce a hit — but the gap to the target ratio is only
    // 6,000 - 5,500 = 500 tokens, well under MIN_WASTED_TOKENS (5,000). If
    // runAggregateRules' `.filter(isMaterial)` were ever deleted, this
    // hit would leak through and this test would fail.
    const hits = runAggregateRules(
      window([
        {
          model: "claude-sonnet-5",
          modelTier: "mid",
          inputTokens: 12_000,
          outputTokens: 500,
          cacheReadTokens: 5_500,
          cacheCreationTokens: 0,
          costUsd: 1,
        },
      ]),
    );
    expect(hits.find((h) => h.ruleId === "cache_efficiency")).toBeUndefined();
  });
});
