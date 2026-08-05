import type { RuleHit } from "../types.js";
import type { ModelWindowTotals } from "./index.js";

/** Below this cache-read/input ratio, cache reuse is considered poor. */
export const CACHE_EFFICIENCY_MIN_READ_RATIO = 0.5;

/**
 * Whether this window's totals actually recorded a cache breakdown, as
 * opposed to summing to zero because no breakdown was ever recorded.
 *
 * Every event already in the database has cache tokens folded into
 * inputTokens; the separate cacheReadTokens/cacheCreationTokens fields only
 * started being recorded this week. So a window built entirely from
 * pre-migration events sums to cacheReadTokens === 0 &&
 * cacheCreationTokens === 0 — indistinguishable, from the totals alone,
 * from a window that genuinely never touched the cache. We cannot tell
 * those apart here, so all-zero is treated as "no data" rather than "0%
 * reuse": firing on it would produce a confident, wrong finding, which is
 * the exact class of bug this rule exists to avoid.
 */
function hasCacheData(totals: ModelWindowTotals): boolean {
  return totals.cacheReadTokens > 0 || totals.cacheCreationTokens > 0;
}

/**
 * Poor cache reuse for a model with material input volume: cache reads are
 * a small fraction of input tokens. Silent when no cache breakdown was ever
 * recorded (see hasCacheData) or when there's no input volume to judge.
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
  if (!hasCacheData(totals)) return null;
  if (totals.inputTokens <= 0) return null;

  const readRatio = totals.cacheReadTokens / totals.inputTokens;
  if (readRatio >= CACHE_EFFICIENCY_MIN_READ_RATIO) return null;

  const targetReads = totals.inputTokens * CACHE_EFFICIENCY_MIN_READ_RATIO;
  const estimatedWastedTokens = Math.max(
    0,
    Math.round(targetReads - totals.cacheReadTokens),
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
