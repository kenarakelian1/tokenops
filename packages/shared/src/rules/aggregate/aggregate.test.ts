import { describe, it, expect } from "vitest";
import { runAggregateRules } from "./index.js";
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

  it("is silent about cache when the fields are absent, not reporting 0%", () => {
    // Pre-migration events have no cache breakdown. Silence, not a false finding.
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
    expect(hits.find((h) => h.ruleId === "cache_efficiency")).toBeUndefined();
  });
});
