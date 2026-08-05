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
 * cacheReadTokens/cacheCreationTokens are `number | null`, and the two are
 * NOT interchangeable: `null` means "no cache breakdown was ever recorded
 * for this slice of the window" (pre-migration events fold cache into
 * inputTokens and can't report it separately); `0` means "recorded, and
 * genuinely zero". Callers building these totals must preserve that
 * distinction rather than defaulting a missing value to `0` — summing
 * `undefined`/`null` as `0` collapses "don't know" into "we checked and it's
 * zero", which produces a confidently wrong finding either way (silence
 * when a real zero-cache-usage card is owed, or a false low-reuse card on a
 * window straddling the migration). See checkCacheEfficiency for how this
 * module acts on the distinction.
 */
export type ModelWindowTotals = {
  model: string;
  modelTier: ModelTier;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
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
 *
 * @param now Comparison instant forwarded to checkFrontierShare for
 *   date-gated pricing (e.g. the Claude Sonnet 5 introductory rate).
 *   Defaults to the real current time; tests pass a fixed Date to pin
 *   behavior on either side of a cutoff.
 */
export function runAggregateRules(
  window: AggregateWindow,
  now: Date = new Date(),
): RuleHit[] {
  const hits: RuleHit[] = [];

  const frontier = checkFrontierShare(window, now);
  if (frontier) hits.push(frontier);

  for (const totals of window.byModel) {
    const cache = checkCacheEfficiency(totals);
    if (cache) hits.push(cache);
  }

  return hits.filter(isMaterial);
}
