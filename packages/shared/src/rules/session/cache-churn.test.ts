import { describe, expect, it } from "vitest";
import type { RuleContext } from "../contract.js";
import type { SessionRollup } from "./rollup.js";
import {
  SESSION_CHURN_BASELINE_TOKEN_SHARE,
  SESSION_CHURN_MIN_COST_SHARE,
  churnCostShare,
  sessionCacheChurnRule,
} from "./cache-churn.js";
import { SESSION_MIN_TURNS } from "./context-ceiling.js";

const ctx: RuleContext = { now: new Date("2026-08-11T00:00:00.000Z") };

function rollup(over: Partial<SessionRollup> = {}): SessionRollup {
  return {
    sessionId: "s1",
    start: "2026-08-01T00:00:00.000Z",
    end: "2026-08-01T06:00:00.000Z",
    turnCount: 100,
    model: "claude-opus-5",
    modelTier: "frontier",
    inputTokens: 10_000_000,
    outputTokens: 100_000,
    // churn share = 2M*1.25 / (2M*1.25 + 8M*0.1) = 2.5 / 3.3 = 0.757
    cacheReadTokens: 8_000_000,
    cacheCreationTokens: 2_000_000,
    turnsByContextBand: [50, 20, 10, 10, 5, 5],
    cacheReadByContextBand: [1, 1, 1, 1, 1, 1],
    ...over,
  };
}

describe("churnCostShare", () => {
  it("weights creation at 1.25x and reads at 0.1x", () => {
    // 100*1.25 = 125; 100*0.1 = 10; 125/135
    expect(churnCostShare(100, 100)).toBeCloseTo(125 / 135, 10);
  });

  it("is 0 when there is no creation", () => {
    expect(churnCostShare(1_000, 0)).toBe(0);
  });

  it("is 0 when there is neither, rather than NaN", () => {
    expect(churnCostShare(0, 0)).toBe(0);
  });
});

describe("SESSION_CHURN_BASELINE_TOKEN_SHARE", () => {
  it("is the creation share that yields a 25% baseline cost share", () => {
    // Solving 1.25C / (1.25C + 0.1(T-C)) = 0.25 for C/T gives 0.02597.
    // This test is the constant's derivation, executable.
    const T = 1_000_000;
    const C = T * SESSION_CHURN_BASELINE_TOKEN_SHARE;
    expect(churnCostShare(T - C, C)).toBeCloseTo(0.25, 2);
  });
});

describe("sessionCacheChurnRule", () => {
  it("declares an aggregate grain and info severity", () => {
    expect(sessionCacheChurnRule.grain).toBe("aggregate");
    expect(sessionCacheChurnRule.id).toBe("session_cache_churn");
    expect(sessionCacheChurnRule.defaultSeverity).toBe("info");
  });

  it("fires when churn dominates the session's input cost", () => {
    const finding = sessionCacheChurnRule.evaluate(rollup(), ctx);
    expect(finding).not.toBeNull();
    expect(finding!.implicatedTokens).toBe(2_000_000);
  });

  it("preserves total input tokens across the counterfactual", () => {
    // The advice is "the prefix should have been re-read, not rewritten" —
    // it moves tokens between buckets, it does not remove them.
    const finding = sessionCacheChurnRule.evaluate(rollup(), ctx)!;
    const cf = finding.counterfactual;
    expect(cf.inputTokens).toBe(10_000_000);
    expect(cf.cacheCreationTokens! + cf.cacheReadTokens!).toBe(10_000_000);
    expect(cf.cacheCreationTokens).toBe(260_000); // 10M * 0.026
    expect(cf.cacheReadTokens).toBe(9_740_000);
    expect(cf.model).toBe("claude-opus-5");
    expect(cf.outputTokens).toBe(0);
  });

  it("stays silent just below the cost-share threshold", () => {
    // Pick read/creation that land just under 0.45.
    // C=1, R=17.4 -> 1.25 / (1.25 + 1.74) = 0.418
    expect(
      sessionCacheChurnRule.evaluate(
        rollup({ cacheCreationTokens: 1_000_000, cacheReadTokens: 17_400_000, inputTokens: 18_400_000 }),
        ctx,
      ),
    ).toBeNull();
  });

  it("fires just above the cost-share threshold", () => {
    // C=1, R=15 -> 1.25 / (1.25 + 1.5) = 0.4545
    const finding = sessionCacheChurnRule.evaluate(
      rollup({ cacheCreationTokens: 1_000_000, cacheReadTokens: 15_000_000, inputTokens: 16_000_000 }),
      ctx,
    );
    expect(finding).not.toBeNull();
    expect(churnCostShare(15_000_000, 1_000_000)).toBeGreaterThan(
      SESSION_CHURN_MIN_COST_SHARE,
    );
  });

  it("stays silent on a session shorter than the turn floor", () => {
    expect(
      sessionCacheChurnRule.evaluate(
        rollup({ turnCount: SESSION_MIN_TURNS - 1 }),
        ctx,
      ),
    ).toBeNull();
  });

  it("stays silent when no cache breakdown was recorded", () => {
    expect(
      sessionCacheChurnRule.evaluate(rollup({ cacheReadTokens: null }), ctx),
    ).toBeNull();
    expect(
      sessionCacheChurnRule.evaluate(rollup({ cacheCreationTokens: null }), ctx),
    ).toBeNull();
  });

  it("cost-share gate already implies creation is above baseline", () => {
    // Solving 1.25x / (0.1 + 1.15x) = SESSION_CHURN_MIN_COST_SHARE for the
    // creation token share x gives x = 0.0614. Anything passing the gate
    // therefore carries creation well above the 2.6% baseline, so a
    // separate baseline check would be unreachable code. This test fails
    // if either constant is ever retuned far enough for them to overlap.
    const crossover = 0.0614;
    expect(crossover).toBeGreaterThan(SESSION_CHURN_BASELINE_TOKEN_SHARE);
    expect(churnCostShare(1 - crossover, crossover)).toBeCloseTo(
      SESSION_CHURN_MIN_COST_SHARE,
      3,
    );
  });

  it("resolves the actual to the session's own cache split", () => {
    const finding = sessionCacheChurnRule.evaluate(rollup(), ctx)!;
    const actual = sessionCacheChurnRule.resolveActual!(rollup(), finding);
    expect(actual).toEqual({
      model: "claude-opus-5",
      inputTokens: 10_000_000,
      outputTokens: 0,
      cacheReadTokens: 8_000_000,
      cacheCreationTokens: 2_000_000,
    });
  });
});
