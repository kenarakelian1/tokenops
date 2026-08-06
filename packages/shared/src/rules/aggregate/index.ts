import type { ModelTier } from "../../model-tier.js";
import type { RuleContext } from "../contract.js";
import { priceFinding } from "../index.js";
import { isMaterial } from "../materiality.js";
import type { RuleHit } from "../types.js";
import { cacheEfficiencyRule } from "./cache-efficiency.js";
import { frontierShareRule } from "./frontier-share.js";

export {
  FRONTIER_SHARE_THRESHOLD,
  frontierShareRule,
} from "./frontier-share.js";
export {
  CACHE_EFFICIENCY_MIN_READ_RATIO,
  cacheEfficiencyRule,
} from "./cache-efficiency.js";

/**
 * Every ruleId `runAggregateRules` can emit. Used by the aggregate-rules job
 * to know which rules to retire a card for when a run produces no hit for
 * them — otherwise a card latches forever once its rule stops firing, since
 * `supersedeOpenRecommendations` is only ever called for rules that DID hit
 * this run (see aggregate-rules.ts).
 */
export const AGGREGATE_RULE_IDS = ["frontier_share", "cache_efficiency"] as const;

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
 * window straddling the migration). See cacheEfficiencyRule for how this
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
 * @param now Comparison instant forwarded to frontierShareRule for
 *   date-gated pricing (e.g. the Claude Sonnet 5 introductory rate).
 *   Defaults to the real current time; tests pass a fixed Date to pin
 *   behavior on either side of a cutoff.
 */
/**
 * Is `candidate` a worse (more wasteful) cache_efficiency hit than
 * `current`? Ranks by highest estimatedWastedUsd — the same currency every
 * other rule ranks on — falling back to estimatedWastedTokens only when
 * BOTH sides are unpriced (USD null on both). A null USD never beats a real
 * one: a model this pricer can't price shouldn't outrank one it can.
 */
function isWorseCacheHit(candidate: RuleHit, current: RuleHit): boolean {
  if (candidate.estimatedWastedUsd == null && current.estimatedWastedUsd == null) {
    return candidate.estimatedWastedTokens > current.estimatedWastedTokens;
  }
  return (candidate.estimatedWastedUsd ?? -Infinity) > (current.estimatedWastedUsd ?? -Infinity);
}

export function runAggregateRules(
  window: AggregateWindow,
  now: Date = new Date(),
): RuleHit[] {
  const hits: RuleHit[] = [];
  const ctx: RuleContext = { now };

  const finding = frontierShareRule.evaluate(window, ctx);
  if (finding) {
    const actual = frontierShareRule.resolveActual!(window, finding);
    if (actual) hits.push(priceFinding(frontierShareRule, finding, actual, ctx));
  }

  // cacheEfficiencyRule can fire once per model, but its dedupeKey (ruleId +
  // window start, built by the aggregate-rules job) carries no model — two
  // hits in the same run collide on that key, and whichever survives the
  // memory repo's has()/Drizzle's onConflictDoNothing depends on
  // non-deterministic GROUP BY order. Keep only the worst-offending model
  // (see isWorseCacheHit) so the choice is deterministic instead.
  let worstCache: RuleHit | null = null;
  for (const totals of window.byModel) {
    const finding = cacheEfficiencyRule.evaluate(totals, ctx);
    if (!finding) continue;
    const actual = {
      model: totals.model,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheCreationTokens: totals.cacheCreationTokens,
    };
    const hit = priceFinding(cacheEfficiencyRule, finding, actual, ctx);
    if (!worstCache || isWorseCacheHit(hit, worstCache)) {
      worstCache = hit;
    }
  }
  if (worstCache) hits.push(worstCache);

  return hits.filter(isMaterial);
}
