import type { RuleHit } from "../types.js";
import type { ModelWindowTotals } from "./index.js";

/** Below this cache-read/input ratio, cache reuse is considered poor. */
export const CACHE_EFFICIENCY_MIN_READ_RATIO = 0.5;

/**
 * Poor cache reuse for a model with material input volume: cache reads are
 * a small fraction of input tokens. Silent only when the totals never
 * recorded a cache breakdown at all (cacheReadTokens === null) — that is
 * genuinely different from a recorded, but zero, read count.
 *
 * `null` vs. `0` on ModelWindowTotals.cacheReadTokens is load-bearing:
 * cache-field recording only started this week, so a window can straddle
 * the migration — pre-migration events fold cache into inputTokens and
 * report nothing separately, post-migration events report real numbers,
 * including genuine zero. Summing "no breakdown recorded" as 0 would either
 * (a) silence a user who is genuinely paying full price for context on every
 * call (a real, actionable finding), or (b) understate the ratio for a
 * straddling window, since inputTokens is inflated by pre-migration events
 * whose cache reads can never show up in cacheReadTokens — producing a
 * confidently wrong "low cache reuse" card. `null` means "don't know, stay
 * silent"; `0` means "we know, and it's genuinely zero" and is treated as a
 * finding like any other ratio. Task 6 builds ModelWindowTotals from the
 * database, where NULL and 0 are genuinely distinguishable per-row.
 *
 * There's no per-token cache-read price in the pricing table, so savings
 * aren't priced in USD here — estimatedWastedUsd is left null and the
 * materiality floor falls back to the token count (the gap between actual
 * cache reads and reads at the minimum healthy ratio), same fallback
 * runRules' rules use when cost is unknown.
 */
export function checkCacheEfficiency(
  totals: ModelWindowTotals,
): RuleHit | null {
  if (totals.cacheReadTokens === null) return null;
  if (totals.inputTokens <= 0) return null;

  const cacheReadTokens = totals.cacheReadTokens;
  const readRatio = cacheReadTokens / totals.inputTokens;
  if (readRatio >= CACHE_EFFICIENCY_MIN_READ_RATIO) return null;

  const targetReads = totals.inputTokens * CACHE_EFFICIENCY_MIN_READ_RATIO;
  const estimatedWastedTokens = Math.max(
    0,
    Math.round(targetReads - cacheReadTokens),
  );
  if (estimatedWastedTokens === 0) return null;

  const pct = Math.round(readRatio * 100);

  return {
    ruleId: "cache_efficiency",
    severity: "info",
    title: "Low cache reuse",
    detail:
      `Only ${pct}% of ${totals.model}'s input tokens were served from ` +
      `cache in this window. Reusing more context (stable system prompts, ` +
      `repeated documents) can cut cost without changing model or output.`,
    estimatedWastedTokens,
    estimatedWastedUsd: null,
    eventIds: [],
  };
}
