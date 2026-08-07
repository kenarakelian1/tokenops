import type { Rule, RuleContext, RuleFinding } from "../contract.js";
import type { ModelWindowTotals } from "./index.js";

/** Below this cache-read/input ratio, cache reuse is considered poor. */
export const CACHE_EFFICIENCY_MIN_READ_RATIO = 0.5;

/**
 * Poor cache reuse for a model with material input volume.
 *
 * `null` vs `0` on cacheReadTokens is load-bearing and unchanged: `null`
 * means no cache breakdown was ever recorded for this slice of the window
 * (pre-migration events fold cache into inputTokens and report nothing
 * separately), so the rule stays silent — summing "don't know" as 0 would
 * either silence a user genuinely paying full price for context on every
 * call, or produce a confidently wrong low-reuse card on a window straddling
 * the migration. `0` means recorded and genuinely zero, and is a finding like
 * any other ratio.
 *
 * This rule used to report `estimatedWastedUsd: null`, with a comment saying
 * no per-token cache-read price existed. That stopped being true in 6e90aab,
 * which added the 0.1x read and 1.25x creation multipliers to
 * estimateCostUsd. The counterfactual below moves tokens from the full input
 * rate into the read rate, and the shared pricer values the difference — so
 * the rule now quotes dollars with no special case.
 *
 * Consequence worth knowing: materiality switches from the token fallback
 * (MIN_WASTED_TOKENS) to MIN_WASTED_USD, so small findings on cheap models
 * that used to surface now correctly drop below the floor.
 */
export const cacheEfficiencyRule: Rule<ModelWindowTotals> = {
  id: "cache_efficiency",
  grain: "aggregate",
  defaultSeverity: "warn",

  evaluate(totals: ModelWindowTotals, _ctx: RuleContext): RuleFinding | null {
    if (totals.cacheReadTokens === null) return null;
    if (totals.inputTokens <= 0) return null;

    const cacheReadTokens = totals.cacheReadTokens;
    const readRatio = cacheReadTokens / totals.inputTokens;
    if (readRatio >= CACHE_EFFICIENCY_MIN_READ_RATIO) return null;

    // Reads and creation tokens are both subsets of inputTokens (see
    // docs/rules/authoring.md § 4.4), so the achievable read target cannot
    // just be inputTokens * 0.5 — it has to leave room for whatever creation
    // tokens are already recorded. `?? 0` here mirrors trimCacheTokens: a
    // null cacheCreationTokens ("no breakdown recorded") is treated as 0 for
    // this arithmetic but still copied through as null on the counterfactual
    // below, so the null-vs-zero distinction on the emitted finding is
    // untouched.
    const cacheCreationTokens = totals.cacheCreationTokens ?? 0;
    const readCapacity = Math.max(0, totals.inputTokens - cacheCreationTokens);
    const targetReads = Math.min(
      totals.inputTokens * CACHE_EFFICIENCY_MIN_READ_RATIO,
      readCapacity,
    );
    const shortfall = Math.max(0, Math.round(targetReads - cacheReadTokens));
    if (shortfall === 0) return null;

    const pct = Math.round(readRatio * 100);

    return {
      title: "Low cache reuse",
      detail:
        `Only ${pct}% of ${totals.model}'s input tokens were served from ` +
        `cache in this window. Reusing more context (stable system prompts, ` +
        `repeated documents) can cut cost without changing model or output.`,
      eventIds: [],
      implicatedTokens: shortfall,
      counterfactual: {
        model: totals.model,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: targetReads,
        cacheCreationTokens: totals.cacheCreationTokens,
      },
      // Stated as the ratio actually targeted, not the constant 0.5 — when
      // readCapacity caps targetReads below inputTokens * 0.5 (heavy
      // recorded cache-creation volume), a card that still said "50%" would
      // assert an achievable ratio the counterfactual itself doesn't reach.
      //
      // No leading "Assumes" — the card renders the prefix (see
      // apps/web/src/pages/Recommendations.tsx). A rule states the belief;
      // the UI frames it.
      assumption: `a ${Math.round(
        (targetReads / totals.inputTokens) * 100,
      )}% cache-read ratio is achievable for this workload`,
    };
  },
};
