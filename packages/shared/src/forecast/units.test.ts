import { describe, expect, it } from "vitest";
import type { UsageEvent } from "../schema/event.js";
import { consumptionUnits, hasCacheBreakdown } from "./units.js";

function ev(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    eventId: "e1",
    timestamp: "2026-08-01T00:00:00.000Z",
    machineId: "m",
    machineName: "n",
    app: "claude-code",
    provider: "anthropic",
    model: "claude-opus-5",
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    hasContent: false,
    features: { modelTier: "frontier" },
    ...over,
  };
}

describe("consumptionUnits", () => {
  it("weights each component by its billing multiplier", () => {
    // 1000 raw + 2000 creation + 7000 read = 10_000 inputTokens.
    // 1000*1.0 + 2000*1.25 + 7000*0.10 + 100*5.0 = 1000 + 2500 + 700 + 500
    const u = consumptionUnits(
      ev({
        inputTokens: 10_000,
        cacheCreationTokens: 2_000,
        cacheReadTokens: 7_000,
        outputTokens: 100,
      }),
    );
    expect(u).toBeCloseTo(4_700, 6);
  });

  it("treats a cache read as far cheaper than a cache write", () => {
    // The whole premise of the ledger: a write costs 12.5x a read.
    const read = consumptionUnits(ev({ inputTokens: 1_000, cacheReadTokens: 1_000 }));
    const write = consumptionUnits(ev({ inputTokens: 1_000, cacheCreationTokens: 1_000 }));
    expect(write / read).toBeCloseTo(12.5, 6);
  });

  it("never returns a negative raw component when the breakdown exceeds inputTokens", () => {
    // Defensive: cache fields are documented as subsets of inputTokens, but a
    // malformed producer must not make the whole window go negative.
    const u = consumptionUnits(
      ev({ inputTokens: 100, cacheReadTokens: 900, cacheCreationTokens: 900 }),
    );
    expect(u).toBeGreaterThan(0);
  });

  it("counts an event with no breakdown from what was actually recorded", () => {
    // No breakdown means we cannot know the split. Charging all input at the
    // raw weight is the known-information answer; fabricating a zero for the
    // cache fields would silently claim we checked.
    const u = consumptionUnits(ev({ inputTokens: 1_000, outputTokens: 10 }));
    expect(u).toBeCloseTo(1_000 * 1.0 + 10 * 5.0, 6);
  });

  it("is zero for an event with no tokens at all", () => {
    expect(consumptionUnits(ev())).toBe(0);
  });
});

describe("hasCacheBreakdown", () => {
  it("is true only when both cache fields were recorded", () => {
    expect(hasCacheBreakdown(ev({ cacheReadTokens: 0, cacheCreationTokens: 0 }))).toBe(true);
    expect(hasCacheBreakdown(ev({ cacheReadTokens: 5 }))).toBe(false);
    expect(hasCacheBreakdown(ev())).toBe(false);
  });

  it("treats a recorded zero as recorded, not as missing", () => {
    // The absent-vs-zero distinction the whole ledger depends on.
    expect(hasCacheBreakdown(ev({ cacheReadTokens: 0, cacheCreationTokens: 0 }))).toBe(true);
  });
});
