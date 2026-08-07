import { describe, it, expect } from "vitest";
import {
  runAggregateRules,
  frontierShareRule,
  cacheEfficiencyRule,
  CACHE_EFFICIENCY_MIN_READ_RATIO,
} from "./index.js";
import type { AggregateWindow, ModelWindowTotals } from "./index.js";
import { MIN_WASTED_USD } from "../materiality.js";

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
    // Savings price ONLY the dominant model's (opus's) own 400k/100k tokens,
    // and BOTH sides go through the same estimator (Actual deliberately
    // carries no costUsd, so the real costUsd: 50 given above is not used —
    // see counterfactual.ts). Actual (opus-5, $5/$25 per 1M): 400k*5/1e6 +
    // 100k*25/1e6 = 2 + 2.5 = 4.5. Counterfactual (claude-sonnet-5's intro
    // rate, $2/$10 per 1M): 400k*2/1e6 + 100k*10/1e6 = 0.8 + 1 = 1.8.
    // Difference = 2.7. The pre-fix computation summed both vendors' cost
    // (90) and priced both vendors' combined tokens at sonnet's rate,
    // yielding 86.9 instead — a different, cross-vendor-contaminated number.
    expect(hit!.estimatedWastedUsd).toBeCloseTo(2.7, 5);
  });

  it("still fires with a positive saving at a realistic (90%) cache-read ratio with a real costUsd present", () => {
    // Regression for the silently-vanishing card: dominant.costUsd is real
    // and already cache-discounted, but before the fix siblingCost was
    // always a full-price estimate. At Claude Code's typical 85-95%
    // cache-read ratio, that inflated sibling estimate exceeded the
    // dominant's real (discounted) cost, clamping estimatedWastedUsd to 0
    // via Math.max(0, ...) and dropping the only card an OTEL-only user
    // would otherwise see.
    const after = new Date("2026-09-01T00:00:00Z"); // Sonnet 5 intro expired: $3/$15
    const inputTokens = 1_000_000;
    const cacheReadTokens = 900_000; // 90% — realistic Claude Code ratio
    const outputTokens = 0;

    // Real (cache-discounted) opus cost: (100k full-rate + 900k*0.1)/1e6 * 5
    // = (100,000 + 90,000)/1e6 * 5 = 0.95.
    const realDominantCost = 0.95;

    const hits = runAggregateRules(
      window([
        {
          model: "claude-opus-5[1m]",
          modelTier: "frontier",
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens: 0,
          costUsd: realDominantCost,
        },
      ]),
      after,
    );
    const hit = hits.find((h) => h.ruleId === "frontier_share");
    expect(hit).toBeDefined();
    // Sibling (claude-sonnet-5, standard $3/$15) priced with the SAME 90%
    // cache-read ratio: (100,000 + 90,000)/1e6 * 3 = 0.57. Saving = 0.95 -
    // 0.57 = 0.38 — small, but positive, and well above the $0.01
    // materiality floor. Before the fix, siblingCost priced the full 1M
    // tokens at $3/1M = 3, which exceeds 0.95 and clamps the saving to 0.
    expect(hit!.estimatedWastedUsd).toBeCloseTo(0.38, 5);
    expect(hit!.estimatedWastedUsd).toBeGreaterThan(0);
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
      const hits = runAggregateRules(
        singleOpusWindow,
        new Date("2026-08-15T00:00:00Z"),
      );
      const hit = hits.find((h) => h.ruleId === "frontier_share");
      // opus cost: 1,000,000 * $5/1M = 5. sonnet intro: 1,000,000 * $2/1M = 2.
      expect(hit!.estimatedWastedUsd).toBeCloseTo(3, 5);
    });

    it("prices the sibling at the standard rate on/after the expiry", () => {
      const hits = runAggregateRules(
        singleOpusWindow,
        new Date("2026-09-01T00:00:00Z"),
      );
      const hit = hits.find((h) => h.ruleId === "frontier_share");
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

  it("keeps only the worst-offending model's cache_efficiency hit when multiple models qualify", () => {
    // Regression for the multi-model collision: runAggregateRules used to
    // emit one cache_efficiency hit per qualifying model, but the job's
    // dedupeKey (ruleId + window start) carries no model, so two hits in
    // the same run collided and whichever survived depended on
    // non-deterministic GROUP BY order. Both models here are well under the
    // 80% frontier-share threshold combined (105k/210k = 50%), so
    // frontier_share stays silent and this test isolates the collision.
    const hits = runAggregateRules(
      window([
        {
          // readRatio 10%, target 50,000 -> gap 40,000 (worse).
          model: "claude-opus-5[1m]",
          modelTier: "frontier",
          inputTokens: 100_000,
          outputTokens: 5_000,
          cacheReadTokens: 10_000,
          cacheCreationTokens: 0,
          costUsd: 1,
        },
        {
          // readRatio 40%, target 50,000 -> gap 10,000 (better, but still a hit).
          model: "claude-sonnet-5",
          modelTier: "mid",
          inputTokens: 100_000,
          outputTokens: 5_000,
          cacheReadTokens: 40_000,
          cacheCreationTokens: 0,
          costUsd: 1,
        },
      ]),
    );
    const cacheHits = hits.filter((h) => h.ruleId === "cache_efficiency");
    expect(cacheHits).toHaveLength(1);
    expect(cacheHits[0]!.detail).toMatch(/claude-opus-5\[1m\]/);
    expect(cacheHits[0]!.estimatedWastedTokens).toBe(40_000);
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

const NOW = new Date("2026-09-15T00:00:00Z");

describe("cache_efficiency counterfactual", () => {
  const totals = (over: Partial<ModelWindowTotals> = {}): ModelWindowTotals => ({
    model: "claude-opus-5",
    modelTier: "frontier",
    inputTokens: 10_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: null,
    ...over,
  });

  it("targets the minimum healthy read ratio", () => {
    const finding = cacheEfficiencyRule.evaluate(totals(), { now: NOW });
    expect(finding).not.toBeNull();
    expect(finding!.counterfactual.cacheReadTokens).toBe(
      10_000_000 * CACHE_EFFICIENCY_MIN_READ_RATIO,
    );
    expect(finding!.counterfactual.model).toBe("claude-opus-5");
  });

  it("now quotes USD instead of null", () => {
    // opus-5 in = $5/MTok. Actual: 10M at full rate = $50.
    // Counterfactual: 5M full ($25) + 5M at 0.1x ($2.50) = $27.50. Saves $22.50.
    const hits = runAggregateRules(window([totals()]), NOW);
    const hit = hits.find((h) => h.ruleId === "cache_efficiency");
    expect(hit).toBeDefined();
    expect(hit!.estimatedWastedUsd).toBeCloseTo(22.5, 4);
  });

  it("stays silent when no cache breakdown was ever recorded", () => {
    const finding = cacheEfficiencyRule.evaluate(
      totals({ cacheReadTokens: null }),
      { now: NOW },
    );
    expect(finding).toBeNull();
  });

  it("drops a finding worth under a cent, which the token floor used to pass", () => {
    // haiku in = $1/MTok. 20k input, 0 reads -> counterfactual moves 10k to
    // 0.1x: saves 10k * $1/1M * 0.9 = $0.009, under MIN_WASTED_USD.
    // The old token fallback (MIN_WASTED_TOKENS = 5_000) passed this at 10k.
    const hits = runAggregateRules(
      window([
        totals({
          model: "claude-haiku-4-5",
          modelTier: "small",
          inputTokens: 20_000,
        }),
      ]),
      NOW,
    );
    expect(hits.some((h) => h.ruleId === "cache_efficiency")).toBe(false);
    expect(MIN_WASTED_USD).toBe(0.01); // pins the floor this depends on
  });

  it("keeps cache tokens a subset of inputTokens when creation tokens leave less than half the input available for reads", () => {
    // Worked example from the bug report / docs/rules/authoring.md § 4.4's
    // invariant: a window dominated by cache WRITES with poor read reuse.
    // Before the fix, targetReads was always inputTokens * 0.5 regardless of
    // how much cacheCreationTokens already occupied, so the counterfactual
    // declared targetReads (50,000) + cacheCreationTokens (60,000) =
    // 110,000 against a 100,000-token input — more cache tokens than the
    // input contains.
    const finding = cacheEfficiencyRule.evaluate(
      totals({
        inputTokens: 100_000,
        cacheReadTokens: 10_000,
        cacheCreationTokens: 60_000,
      }),
      { now: NOW },
    );
    expect(finding).not.toBeNull();
    const cf = finding!.counterfactual;
    expect(
      (cf.cacheReadTokens ?? 0) + (cf.cacheCreationTokens ?? 0),
    ).toBeLessThanOrEqual(cf.inputTokens);
    // The achievable read target is capped at inputTokens - cacheCreationTokens
    // (100,000 - 60,000 = 40,000), not the naive inputTokens * 0.5 (50,000).
    expect(cf.cacheReadTokens).toBe(40_000);
    expect(cf.cacheCreationTokens).toBe(60_000);
    // The shortfall (and implicatedTokens) shrinks to match the honest,
    // achievable target: 40,000 - 10,000 = 30,000, not the naive
    // 50,000 - 10,000 = 40,000.
    expect(finding!.implicatedTokens).toBe(30_000);
  });

  it("prices the capped counterfactual correctly for a cache-write-heavy window", () => {
    // Same window as above, on claude-opus-5 ($5/$25 per 1M; cache reads at
    // 0.1x and cache creation at 1.25x the base input rate — see
    // pricing.ts). Both figures below are derived by hand from those rates,
    // not read off the code under test.
    //
    // Actual: fullRate = 100,000 - 10,000 - 60,000 = 30,000.
    //   cost = 30,000/1e6*5 + 10,000/1e6*5*0.1 + 60,000/1e6*5*1.25
    //        = 0.15 + 0.005 + 0.375 = 0.53
    // Counterfactual (reads capped at 40,000, creation unchanged at 60,000):
    //   fullRate = 100,000 - 40,000 - 60,000 = 0
    //   cost = 0 + 40,000/1e6*5*0.1 + 60,000/1e6*5*1.25
    //        = 0.02 + 0.375 = 0.395
    // Saving = 0.53 - 0.395 = 0.135
    const hits = runAggregateRules(
      window([
        totals({
          inputTokens: 100_000,
          cacheReadTokens: 10_000,
          cacheCreationTokens: 60_000,
          costUsd: 0.53,
        }),
      ]),
      NOW,
    );
    const hit = hits.find((h) => h.ruleId === "cache_efficiency");
    expect(hit).toBeDefined();
    expect(hit!.estimatedWastedUsd).toBeCloseTo(0.135, 5);
  });
});

describe("frontier_share counterfactual", () => {
  it("swaps only the dominant model, carrying its own cache breakdown", () => {
    const w = window([
      {
        model: "claude-opus-5",
        modelTier: "frontier",
        inputTokens: 100_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 90_000_000,
        cacheCreationTokens: 1_000_000,
        costUsd: 900,
      },
      {
        model: "claude-haiku-4-5",
        modelTier: "small",
        inputTokens: 10_000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.1,
      },
    ]);
    const finding = frontierShareRule.evaluate(w, {
      now: new Date("2026-09-15T00:00:00Z"),
    });
    expect(finding).not.toBeNull();
    expect(finding!.counterfactual).toEqual({
      model: "claude-sonnet-5",
      inputTokens: 100_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 90_000_000,
      cacheCreationTokens: 1_000_000,
    });
  });

  it("still produces a positive saving at a realistic 90% cache-read ratio", () => {
    // Regression guard for 9b1257b: pricing the sibling at full rate while
    // the dominant side got its cache discount clamped savings to 0 and
    // dropped the only card an OTEL-only user would see.
    const hits = runAggregateRules(
      window([
        {
          model: "claude-opus-5",
          modelTier: "frontier",
          inputTokens: 100_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 90_000_000,
          cacheCreationTokens: 0,
          costUsd: 900,
        },
      ]),
      new Date("2026-09-15T00:00:00Z"),
    );
    const hit = hits.find((h) => h.ruleId === "frontier_share");
    expect(hit).toBeDefined();
    expect(hit!.estimatedWastedUsd).toBeGreaterThan(0);
  });
});
