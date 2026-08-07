import { describe, it, expect } from "vitest";
import { priceCounterfactual } from "./counterfactual.js";
import type { Actual, Counterfactual } from "./counterfactual.js";

const NOW = new Date("2026-09-15T00:00:00Z"); // after the Sonnet 5 intro expiry

const actual = (over: Partial<Actual> = {}): Actual => ({
  model: "claude-opus-5",
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  ...over,
});

const cf = (over: Partial<Counterfactual> = {}): Counterfactual => ({
  model: "claude-opus-5",
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  ...over,
});

describe("priceCounterfactual", () => {
  it("prices a model swap as the rate difference", () => {
    // opus-5 in = $5/MTok, sonnet-5 standard in = $3/MTok -> $2 on 1M tokens
    const res = priceCounterfactual(
      actual(),
      cf({ model: "claude-sonnet-5" }),
      { now: NOW },
    );
    expect(res.estimatedWastedUsd).toBeCloseTo(2, 6);
  });

  it("prices a cache-reuse counterfactual through the read multiplier", () => {
    // 1M input at full $5 = $5. Counterfactual: half served from cache at
    // 0.1x -> 500k * $5 + 500k * $5 * 0.1 = $2.50 + $0.25 = $2.75. Saves $2.25.
    const res = priceCounterfactual(
      actual({ cacheReadTokens: 0, cacheCreationTokens: 0 }),
      cf({ cacheReadTokens: 500_000, cacheCreationTokens: 0 }),
      { now: NOW },
    );
    expect(res.estimatedWastedUsd).toBeCloseTo(2.25, 6);
  });

  it("returns null savings when either side cannot be priced", () => {
    const res = priceCounterfactual(
      actual({ model: "some-unknown-model" }),
      cf({ model: "some-unknown-model" }),
      { now: NOW },
    );
    expect(res.estimatedWastedUsd).toBeNull();
  });

  it("never returns negative savings", () => {
    const res = priceCounterfactual(
      actual({ model: "claude-sonnet-5" }),
      cf({ model: "claude-opus-5" }), // "counterfactual" is more expensive
      { now: NOW },
    );
    expect(res.estimatedWastedUsd).toBe(0);
  });

  it("prices both sides at the same instant across the Sonnet 5 cutoff", () => {
    const during = new Date("2026-08-15T00:00:00Z"); // intro active: $2/MTok
    const after = new Date("2026-09-15T00:00:00Z"); // standard: $3/MTok
    const swap = () => cf({ model: "claude-sonnet-5" });
    const a = priceCounterfactual(actual(), swap(), { now: during });
    const b = priceCounterfactual(actual(), swap(), { now: after });
    expect(a.estimatedWastedUsd).toBeCloseTo(3, 6); // $5 - $2
    expect(b.estimatedWastedUsd).toBeCloseTo(2, 6); // $5 - $3
  });

  it("passes implicated tokens through unchanged", () => {
    const res = priceCounterfactual(actual(), cf(), {
      now: NOW,
      implicatedTokens: 4321,
    });
    expect(res.estimatedWastedTokens).toBe(4321);
  });
});
