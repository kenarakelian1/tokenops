import { describe, expect, it } from "vitest";
import type { RuleContext } from "../contract.js";
import type { SessionRollup } from "./rollup.js";
import {
  SESSION_CONTEXT_TARGET_TOKENS,
  SESSION_MIN_TURNS,
  sessionContextCeilingRule,
} from "./context-ceiling.js";
import { CONTEXT_BAND_EDGES } from "./rollup.js";

const ctx: RuleContext = { now: new Date("2026-08-11T00:00:00.000Z") };

function rollup(over: Partial<SessionRollup> = {}): SessionRollup {
  return {
    sessionId: "s1",
    start: "2026-08-01T00:00:00.000Z",
    end: "2026-08-01T06:00:00.000Z",
    turnCount: 100,
    model: "claude-opus-5",
    modelTier: "frontier",
    inputTokens: 60_000_000,
    outputTokens: 200_000,
    cacheReadTokens: 59_000_000,
    cacheCreationTokens: 1_000_000,
    // 40 turns at/above the 300k target (bands 3,4,5), carrying 24M reads.
    turnsByContextBand: [20, 20, 20, 10, 10, 20],
    cacheReadByContextBand: [1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000, 15_000_000],
    ...over,
  };
}

describe("sessionContextCeilingRule", () => {
  it("declares an aggregate grain so the per-request runner skips it", () => {
    expect(sessionContextCeilingRule.grain).toBe("aggregate");
    expect(sessionContextCeilingRule.id).toBe("session_context_ceiling");
    expect(sessionContextCeilingRule.defaultSeverity).toBe("warn");
  });

  it("targets a value that is an actual band edge", () => {
    // Not a style check: a target between edges cannot be summed exactly
    // from the histogram, so the rule would be interpolating.
    expect([...CONTEXT_BAND_EDGES]).toContain(SESSION_CONTEXT_TARGET_TOKENS);
  });

  it("fires on a session carrying reads above the target", () => {
    const finding = sessionContextCeilingRule.evaluate(rollup(), ctx);
    expect(finding).not.toBeNull();
    // Bands 3,4,5 = 4M + 5M + 15M reads over 40 turns.
    expect(finding!.implicatedTokens).toBe(24_000_000);
    expect(finding!.eventIds).toEqual([]);
  });

  it("prices the counterfactual as those same turns each reading the target", () => {
    const finding = sessionContextCeilingRule.evaluate(rollup(), ctx)!;
    // 40 turns above target x 300_000 = 12_000_000.
    expect(finding.counterfactual.inputTokens).toBe(12_000_000);
    expect(finding.counterfactual.cacheReadTokens).toBe(12_000_000);
    // Output and cache creation are unchanged by the advice, so they are
    // set to 0 on BOTH sides and cancel out of the subtraction.
    expect(finding.counterfactual.outputTokens).toBe(0);
    expect(finding.counterfactual.cacheCreationTokens).toBe(0);
    expect(finding.counterfactual.model).toBe("claude-opus-5");
  });

  it("resolves the actual to only the above-target turns", () => {
    const finding = sessionContextCeilingRule.evaluate(rollup(), ctx)!;
    const actual = sessionContextCeilingRule.resolveActual!(rollup(), finding);
    expect(actual).toEqual({
      model: "claude-opus-5",
      inputTokens: 24_000_000,
      outputTokens: 0,
      cacheReadTokens: 24_000_000,
      cacheCreationTokens: 0,
    });
  });

  it("stays silent on a session shorter than the turn floor", () => {
    expect(
      sessionContextCeilingRule.evaluate(
        rollup({ turnCount: SESSION_MIN_TURNS - 1 }),
        ctx,
      ),
    ).toBeNull();
  });

  it("fires exactly at the turn floor", () => {
    expect(
      sessionContextCeilingRule.evaluate(
        rollup({ turnCount: SESSION_MIN_TURNS }),
        ctx,
      ),
    ).not.toBeNull();
  });

  it("stays silent when no turn reached the target", () => {
    expect(
      sessionContextCeilingRule.evaluate(
        rollup({
          turnsByContextBand: [50, 50, 0, 0, 0, 0],
          cacheReadByContextBand: [1_000_000, 2_000_000, 0, 0, 0, 0],
        }),
        ctx,
      ),
    ).toBeNull();
  });

  it("stays silent when no cache breakdown was recorded", () => {
    // null is "never recorded", not "zero" — a finding here would be
    // invented from absent data.
    expect(
      sessionContextCeilingRule.evaluate(rollup({ cacheReadTokens: null }), ctx),
    ).toBeNull();
    expect(
      sessionContextCeilingRule.evaluate(
        rollup({ cacheCreationTokens: null }),
        ctx,
      ),
    ).toBeNull();
  });

  it("stays silent when above-target reads do not exceed the counterfactual", () => {
    // 40 turns x 300k = 12M counterfactual; 6M actual reads is less, so
    // there is nothing to claim. Emitting here would rely on the pricer's
    // Math.max(0, ...) clamp to hide a negative saving.
    expect(
      sessionContextCeilingRule.evaluate(
        rollup({
          cacheReadByContextBand: [0, 0, 0, 2_000_000, 2_000_000, 2_000_000],
        }),
        ctx,
      ),
    ).toBeNull();
  });

  it("throws when the rollup's band arrays are the wrong length", () => {
    expect(() =>
      sessionContextCeilingRule.evaluate(
        rollup({ turnsByContextBand: [1, 2, 3] }),
        ctx,
      ),
    ).toThrow(/turnsByContextBand/);
  });

  it("names the session and its turn count in the detail", () => {
    const finding = sessionContextCeilingRule.evaluate(rollup(), ctx)!;
    expect(finding.detail).toContain("40");
    expect(finding.title).toMatch(/context/i);
  });
});
