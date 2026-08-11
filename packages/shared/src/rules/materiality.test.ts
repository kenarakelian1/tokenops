import { describe, it, expect } from "vitest";
import { isMaterial, MIN_WASTED_USD, MIN_WASTED_TOKENS } from "./materiality.js";
import type { RuleHit } from "./types.js";

const base: RuleHit = {
  ruleId: "frontier_trivial",
  severity: "warn",
  title: "t",
  detail: "d",
  estimatedWastedTokens: 0,
  estimatedWastedUsd: null,
  eventIds: ["e1"],
  // isMaterial only reads estimatedWastedTokens/estimatedWastedUsd; these
  // two fields are irrelevant to it but required by the RuleHit type since
  // Task 2 extended it with counterfactual/assumption.
  counterfactual: null,
  assumption: null,
};

describe("isMaterial", () => {
  it("drops a finding worth 89 tokens and no known cost", () => {
    expect(
      isMaterial({ ...base, estimatedWastedTokens: 89, estimatedWastedUsd: null }),
    ).toBe(false);
  });

  it("keeps a finding above the token floor when cost is unknown", () => {
    expect(
      isMaterial({
        ...base,
        estimatedWastedTokens: 50_000,
        estimatedWastedUsd: null,
      }),
    ).toBe(true);
  });

  it("prefers cost when it is known", () => {
    expect(
      isMaterial({ ...base, estimatedWastedTokens: 10, estimatedWastedUsd: 5 }),
    ).toBe(true);
    expect(
      isMaterial({
        ...base,
        estimatedWastedTokens: 999_999,
        estimatedWastedUsd: 0.0001,
      }),
    ).toBe(false);
  });

  it("exposes the exact thresholds as named constants", () => {
    expect(MIN_WASTED_USD).toBe(0.01);
    expect(MIN_WASTED_TOKENS).toBe(5_000);
  });
});
