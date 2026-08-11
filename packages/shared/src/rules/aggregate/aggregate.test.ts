import { describe, it, expect } from "vitest";
import {
  runAggregateRules,
  frontierShareRule,
  AGGREGATE_RULE_IDS,
} from "./index.js";
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
});

describe("cache_efficiency retirement", () => {
  it("never emits a cache_efficiency hit, even on a window that would have tripped it", () => {
    // Read ratio 0.10, far below the retired 0.50 gate.
    const window = {
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-08-08T00:00:00.000Z",
      byModel: [
        {
          model: "claude-opus-5",
          modelTier: "frontier" as const,
          inputTokens: 10_000_000,
          outputTokens: 100_000,
          cacheReadTokens: 1_000_000,
          cacheCreationTokens: 9_000_000,
          costUsd: null,
        },
      ],
    };
    const hits = runAggregateRules(window, new Date("2026-08-11T00:00:00.000Z"));
    expect(hits.map((h) => h.ruleId)).not.toContain("cache_efficiency");
  });

  it("keeps the id in AGGREGATE_RULE_IDS so open cards still get retired", () => {
    // The job supersedes open cards for every id in this list that produced
    // no hit. Dropping the id would strand every cache_efficiency card
    // already in the database, open forever with no rule to retire it.
    expect([...AGGREGATE_RULE_IDS]).toContain("cache_efficiency");
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
