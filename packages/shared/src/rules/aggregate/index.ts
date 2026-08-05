import type { ModelTier } from "../../model-tier.js";
import { isMaterial } from "../materiality.js";
import type { RuleHit } from "../types.js";
import { checkCacheEfficiency } from "./cache-efficiency.js";
import { checkFrontierShare } from "./frontier-share.js";

export {
  FRONTIER_SHARE_THRESHOLD,
  checkFrontierShare,
} from "./frontier-share.js";
export {
  CACHE_EFFICIENCY_MIN_READ_RATIO,
  checkCacheEfficiency,
} from "./cache-efficiency.js";

/**
 * Per-model totals over a time window. This is what OTEL-derived data
 * naturally produces: time-bucketed sums with no single request inside
 * them, so per-event rules (runRules, in ../index.ts) cannot evaluate it.
 *
 * cacheReadTokens/cacheCreationTokens are always numbers here, never
 * undefined — but "0" is ambiguous: it means either "no cache was used" or
 * "this window predates cache-field recording and nothing was folded in
 * separately from inputTokens". Callers building these totals must not
 * paper over that by summing `undefined` as `0`; see checkCacheEfficiency's
 * hasCacheData() for how this module treats the ambiguity (silence, not a
 * false 0%).
 */
export type ModelWindowTotals = {
  model: string;
  modelTier: ModelTier;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
};

export type AggregateWindow = {
  start: string;
  end: string;
  byModel: ModelWindowTotals[];
};

/**
 * Run rules that evaluate a per-model window of aggregated totals rather
 * than a single request event. This is the entry point for OTEL-derived
 * data — runRules deliberately gates aggregates away since every per-request
 * rule reads features an aggregate cannot have, which would otherwise leave
 * OTEL-only users with an empty Recommendations panel.
 *
 * The materiality floor (isMaterial) is applied here too, same as runRules
 * does for per-event hits — otherwise aggregates would reintroduce the
 * noisy-finding problem in a new place.
 */
export function runAggregateRules(window: AggregateWindow): RuleHit[] {
  const hits: RuleHit[] = [];

  const frontier = checkFrontierShare(window);
  if (frontier) hits.push(frontier);

  for (const totals of window.byModel) {
    const cache = checkCacheEfficiency(totals);
    if (cache) hits.push(cache);
  }

  return hits.filter(isMaterial);
}
