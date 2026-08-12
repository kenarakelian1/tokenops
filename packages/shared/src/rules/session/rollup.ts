import type { ModelTier } from "../../model-tier.js";

/**
 * Context-size band edges, owned here and imported by the rollup builder in
 * the API. Band `i` covers [edge[i], edge[i+1]); the last band is
 * open-ended, so a rollup's band arrays always have length === 6.
 *
 * These are load-bearing rather than cosmetic: a rule threshold must BE one
 * of these edges, because the histogram can only be summed at boundaries.
 * A threshold between edges would require interpolating within a band —
 * an estimate presented to the user as an exact sum.
 */
export const CONTEXT_BAND_EDGES = [
  0, 100_000, 200_000, 300_000, 400_000, 600_000,
] as const;

/**
 * Per-session totals plus a context-size histogram.
 *
 * The histogram, rather than per-turn samples, is what keeps this bounded:
 * the largest session measured carries 1,935 turns, and a rollup that grew
 * with turn count could not be stored or passed around cheaply.
 *
 * cacheReadTokens/cacheCreationTokens keep the `number | null` semantics
 * established on ModelWindowTotals: `null` means no cache breakdown was
 * recorded for this session, `0` means recorded and genuinely zero.
 * Collapsing the two produces a confidently wrong finding in either
 * direction, so both session rules stay silent on `null`.
 */
export type SessionRollup = {
  sessionId: string;
  start: string;
  end: string;
  turnCount: number;
  /** Dominant model by input tokens — what the counterfactual is priced at. */
  model: string;
  modelTier: ModelTier;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** Turn counts per band. length === CONTEXT_BAND_EDGES.length. */
  turnsByContextBand: number[];
  /** Cache-read tokens per band. length === CONTEXT_BAND_EDGES.length. */
  cacheReadByContextBand: number[];
};

/**
 * Which band a context size falls in.
 *
 * A value sitting exactly on an edge belongs to the band that edge OPENS,
 * not the one it closes. That choice is what makes "reads at or above the
 * target" an exact sum starting at the target's own index.
 */
export function contextBandIndex(contextTokens: number): number {
  if (contextTokens < 0) {
    throw new Error(
      `contextBandIndex: negative context size ${contextTokens}`,
    );
  }
  let index = 0;
  for (let i = 0; i < CONTEXT_BAND_EDGES.length; i += 1) {
    if (contextTokens >= CONTEXT_BAND_EDGES[i]!) index = i;
  }
  return index;
}

/** Sum band values from `fromIndex` to the end, inclusive. */
export function sumBandsFrom(values: number[], fromIndex: number): number {
  let total = 0;
  for (let i = fromIndex; i < values.length; i += 1) total += values[i]!;
  return total;
}

/**
 * Guard the rollup builder's output shape.
 *
 * A mismatched length is a programming error upstream, never user data, so
 * this throws rather than padding or truncating — truncation would silently
 * discard the top band, which carries 46.9% of all cache reads.
 */
export function assertBandArrays(rollup: SessionRollup): void {
  const expected = CONTEXT_BAND_EDGES.length;
  if (rollup.turnsByContextBand.length !== expected) {
    throw new Error(
      `SessionRollup.turnsByContextBand must have length ${expected}, got ${rollup.turnsByContextBand.length}`,
    );
  }
  if (rollup.cacheReadByContextBand.length !== expected) {
    throw new Error(
      `SessionRollup.cacheReadByContextBand must have length ${expected}, got ${rollup.cacheReadByContextBand.length}`,
    );
  }
}
