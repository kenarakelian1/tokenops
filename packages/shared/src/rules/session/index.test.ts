import { describe, expect, it } from "vitest";
import type { SessionRollup } from "./rollup.js";
import { SESSION_RULE_IDS, runSessionRules } from "./index.js";

const NOW = new Date("2026-08-11T00:00:00.000Z");

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
    turnsByContextBand: [20, 20, 20, 10, 10, 20],
    cacheReadByContextBand: [1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000, 15_000_000],
    ...over,
  };
}

describe("SESSION_RULE_IDS", () => {
  it("lists exactly the ids runSessionRules can emit", () => {
    // The job retires cards for every id in this list that produced no hit,
    // so an id missing here means a card that can never be retired.
    expect([...SESSION_RULE_IDS]).toEqual([
      "session_context_ceiling",
      "session_cache_churn",
    ]);
  });
});

describe("runSessionRules", () => {
  it("prices a ceiling hit into real dollars", () => {
    const hits = runSessionRules(rollup(), NOW);
    const ceiling = hits.find((h) => h.ruleId === "session_context_ceiling");
    expect(ceiling).toBeDefined();
    expect(ceiling!.estimatedWastedUsd).toBeGreaterThan(0);
    expect(ceiling!.estimatedWastedTokens).toBe(24_000_000);
    expect(ceiling!.severity).toBe("warn");
    expect(ceiling!.assumption).toContain("resetting context");
  });

  it("emits both rules when a session trips both", () => {
    const hits = runSessionRules(
      rollup({ cacheReadTokens: 8_000_000, cacheCreationTokens: 2_000_000 }),
      NOW,
    );
    expect(hits.map((h) => h.ruleId).sort()).toEqual([
      "session_cache_churn",
      "session_context_ceiling",
    ]);
  });

  it("returns nothing for a session below the turn floor", () => {
    expect(runSessionRules(rollup({ turnCount: 5 }), NOW)).toEqual([]);
  });

  it("drops immaterial hits", () => {
    // A tiny session that technically trips the gate but is worth far less
    // than a cent must not reach the panel.
    const hits = runSessionRules(
      rollup({
        turnCount: 20,
        turnsByContextBand: [0, 0, 0, 20, 0, 0],
        cacheReadByContextBand: [0, 0, 0, 6_000_001, 0, 0],
        cacheReadTokens: 6_000_001,
        cacheCreationTokens: 0,
      }),
      NOW,
    );
    // 6_000_001 reads vs 20*300_000 = 6_000_000 counterfactual: a 1-token
    // difference, far under MIN_WASTED_USD.
    expect(hits.find((h) => h.ruleId === "session_context_ceiling")).toBeUndefined();
  });

  it("prices at the instant it is given, not wall-clock now", () => {
    // Sonnet 5's introductory rate expires 2026-08-31; a replay must price
    // historical traffic at its own timestamp.
    const before = runSessionRules(
      rollup({ model: "claude-sonnet-5" }),
      new Date("2026-08-01T00:00:00.000Z"),
    );
    const after = runSessionRules(
      rollup({ model: "claude-sonnet-5" }),
      new Date("2026-09-01T00:00:00.000Z"),
    );
    const usdBefore = before.find((h) => h.ruleId === "session_context_ceiling")!.estimatedWastedUsd!;
    const usdAfter = after.find((h) => h.ruleId === "session_context_ceiling")!.estimatedWastedUsd!;
    expect(usdAfter).toBeGreaterThan(usdBefore);
  });
});
