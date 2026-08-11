import {
  CACHE_CREATION_PRICE_MULTIPLIER,
  CACHE_READ_PRICE_MULTIPLIER,
} from "../../pricing.js";
import type { Rule, RuleFinding } from "../contract.js";
import type { Actual } from "../counterfactual.js";
import { SESSION_MIN_TURNS } from "./context-ceiling.js";
import type { SessionRollup } from "./rollup.js";

/**
 * Cache creation's share of a session's INPUT COST (not of its tokens).
 * Measured across a real week: p10 24.0%, p50 45.4%, p90 69.6%. Creation is
 * only 3.3% of tokens but 29.7% of the input bill, so a token-share
 * threshold would be reading the wrong axis entirely.
 */
export const SESSION_CHURN_MIN_COST_SHARE = 0.45;

/**
 * Creation as a share of total input TOKENS in the counterfactual.
 *
 * Derived, not chosen. Holding T = C + R fixed and solving
 *   1.25C / (1.25C + 0.10(T - C)) = 0.25
 * for the 25%-of-input-cost baseline (measured p10 is 24.0%) gives
 * C = 0.02597 T, rounded here to 0.026. cache-churn.test.ts re-derives it
 * so the constant cannot drift away from its own justification.
 */
export const SESSION_CHURN_BASELINE_TOKEN_SHARE = 0.026;

/**
 * Cache creation's share of input cost, using the same multipliers the
 * pricer bills at. Returns 0 rather than NaN when there is no input at all.
 */
export function churnCostShare(
  cacheReadTokens: number,
  cacheCreationTokens: number,
): number {
  const creationCost = cacheCreationTokens * CACHE_CREATION_PRICE_MULTIPLIER;
  const readCost = cacheReadTokens * CACHE_READ_PRICE_MULTIPLIER;
  const total = creationCost + readCost;
  return total === 0 ? 0 : creationCost / total;
}

/**
 * A cached prefix that keeps invalidating gets rewritten at 12.5x the rate
 * it would be read at. This rule fires when that rewriting dominates a
 * session's input cost.
 *
 * Severity is `info`, not `warn`, deliberately: the 90 sessions above this
 * threshold in the measured week account for only 8.2% of consumption. The
 * finding is real and actionable — stop editing files already early in
 * context — but it is not where the money is, and ranking it alongside
 * session_context_ceiling would misrepresent that.
 */
export const sessionCacheChurnRule: Rule<SessionRollup> = {
  id: "session_cache_churn",
  grain: "aggregate",
  defaultSeverity: "info",

  evaluate(rollup: SessionRollup): RuleFinding | null {
    if (rollup.turnCount < SESSION_MIN_TURNS) return null;
    if (rollup.cacheReadTokens === null) return null;
    if (rollup.cacheCreationTokens === null) return null;

    const read = rollup.cacheReadTokens;
    const creation = rollup.cacheCreationTokens;
    if (churnCostShare(read, creation) <= SESSION_CHURN_MIN_COST_SHARE) {
      return null;
    }

    const total = read + creation;
    const baselineCreation = Math.round(
      total * SESSION_CHURN_BASELINE_TOKEN_SHARE,
    );
    if (creation <= baselineCreation) return null;

    const sharePct = Math.round(churnCostShare(read, creation) * 100);
    return {
      title: "Cached prefix keeps being rewritten",
      detail:
        `Cache writes are ${sharePct}% of this session's input cost across ${rollup.turnCount} turns ` +
        `(${creation.toLocaleString("en-US")} tokens written, ${read.toLocaleString("en-US")} read). ` +
        `A write costs 12.5x a read, so a prefix that stayed valid would have cost far less.`,
      eventIds: [],
      implicatedTokens: creation,
      counterfactual: {
        model: rollup.model,
        // Tokens move between buckets; none are removed. The advice is
        // "this should have been re-read, not rewritten".
        inputTokens: total,
        outputTokens: 0,
        cacheReadTokens: total - baselineCreation,
        cacheCreationTokens: baselineCreation,
      },
      assumption:
        "a stable cached prefix would have re-read this content instead of rewriting it",
    };
  },

  /**
   * Compared against the session's cache split alone, with output zeroed on
   * both sides — output is untouched by this advice and would otherwise sit
   * identically on both sides of the subtraction.
   */
  resolveActual(rollup: SessionRollup): Actual | null {
    if (rollup.cacheReadTokens === null) return null;
    if (rollup.cacheCreationTokens === null) return null;
    return {
      model: rollup.model,
      inputTokens: rollup.cacheReadTokens + rollup.cacheCreationTokens,
      outputTokens: 0,
      cacheReadTokens: rollup.cacheReadTokens,
      cacheCreationTokens: rollup.cacheCreationTokens,
    };
  },
};
