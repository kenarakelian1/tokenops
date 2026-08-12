import { describe, expect, it } from "vitest";
import {
  CONTEXT_BAND_EDGES,
  contextBandIndex,
  sumBandsFrom,
  assertBandArrays,
  type SessionRollup,
} from "./rollup.js";

function rollup(over: Partial<SessionRollup> = {}): SessionRollup {
  return {
    sessionId: "s1",
    start: "2026-08-01T00:00:00.000Z",
    end: "2026-08-01T01:00:00.000Z",
    turnCount: 30,
    model: "claude-opus-5",
    modelTier: "frontier",
    inputTokens: 1_000_000,
    outputTokens: 10_000,
    cacheReadTokens: 990_000,
    cacheCreationTokens: 10_000,
    turnsByContextBand: [1, 2, 3, 4, 5, 15],
    cacheReadByContextBand: [10, 20, 30, 40, 50, 60],
    ...over,
  };
}

describe("CONTEXT_BAND_EDGES", () => {
  it("is the exact published set of edges", () => {
    expect([...CONTEXT_BAND_EDGES]).toEqual([
      0, 100_000, 200_000, 300_000, 400_000, 600_000,
    ]);
  });

  it("is strictly ascending and starts at zero", () => {
    expect(CONTEXT_BAND_EDGES[0]).toBe(0);
    for (let i = 1; i < CONTEXT_BAND_EDGES.length; i += 1) {
      expect(CONTEXT_BAND_EDGES[i]).toBeGreaterThan(CONTEXT_BAND_EDGES[i - 1]);
    }
  });
});

describe("contextBandIndex", () => {
  it("places a value at a band's lower edge in that band, not the one below", () => {
    // The rule sums "reads at or above the target", so an off-by-one at the
    // edge silently moves a whole band's tokens across the threshold.
    expect(contextBandIndex(300_000)).toBe(3);
    expect(contextBandIndex(299_999)).toBe(2);
  });

  it("places every edge in its own band", () => {
    CONTEXT_BAND_EDGES.forEach((edge, i) => {
      expect(contextBandIndex(edge)).toBe(i);
    });
  });

  it("puts everything above the last edge in the final open-ended band", () => {
    expect(contextBandIndex(600_000)).toBe(5);
    expect(contextBandIndex(998_027)).toBe(5);
    expect(contextBandIndex(50_000_000)).toBe(5);
  });

  it("puts zero in the first band", () => {
    expect(contextBandIndex(0)).toBe(0);
  });

  it("throws on a negative context size rather than returning band 0", () => {
    expect(() => contextBandIndex(-1)).toThrow(/negative/i);
  });
});

describe("sumBandsFrom", () => {
  it("sums from the given index to the end, inclusive", () => {
    expect(sumBandsFrom([10, 20, 30, 40, 50, 60], 3)).toBe(150);
  });

  it("sums everything from index 0", () => {
    expect(sumBandsFrom([10, 20, 30, 40, 50, 60], 0)).toBe(210);
  });

  it("returns 0 when the index is past the end", () => {
    expect(sumBandsFrom([10, 20], 5)).toBe(0);
  });
});

describe("assertBandArrays", () => {
  it("accepts arrays matching the edge count", () => {
    expect(() => assertBandArrays(rollup())).not.toThrow();
  });

  it("throws when a band array is the wrong length", () => {
    // A wrong-length array is a bug in the rollup builder, not user data.
    // Truncating silently would drop the highest band — the one carrying
    // 46.9% of cache reads.
    expect(() =>
      assertBandArrays(rollup({ turnsByContextBand: [1, 2, 3] })),
    ).toThrow(/turnsByContextBand/);
    expect(() =>
      assertBandArrays(rollup({ cacheReadByContextBand: [1, 2, 3] })),
    ).toThrow(/cacheReadByContextBand/);
  });
});
