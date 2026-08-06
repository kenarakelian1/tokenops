import { cheaperSiblingModel } from "../../pricing.js";
import type { Actual } from "../counterfactual.js";
import type { Rule, RuleContext, RuleFinding } from "../contract.js";
import type { AggregateWindow, ModelWindowTotals } from "./index.js";

/** Fire when frontier-tier models account for more than this share of window tokens. */
export const FRONTIER_SHARE_THRESHOLD = 0.8;

/**
 * The dominant frontier contributor and the in-vendor sibling it should
 * move to, or null if the rule shouldn't fire at all.
 *
 * Both `evaluate` and `resolveActual` call this rather than duplicating the
 * selection logic — a Rule is a stateless singleton shared across all users,
 * so caching the choice on the object between the two calls would leak
 * across users. Re-selecting here is cheap (a filter, a sum, a sort over the
 * window's per-model rows) and keeps the two methods provably in sync.
 */
function selectDominant(
  window: AggregateWindow,
): { dominant: ModelWindowTotals; suggestedModel: string } | null {
  const { byModel } = window;

  const totalTokens = byModel.reduce(
    (sum, m) => sum + m.inputTokens + m.outputTokens,
    0,
  );
  if (totalTokens <= 0) return null;

  const frontierModels = byModel.filter((m) => m.modelTier === "frontier");
  if (frontierModels.length === 0) return null;

  const frontierTokens = frontierModels.reduce(
    (sum, m) => sum + m.inputTokens + m.outputTokens,
    0,
  );

  const frontierFraction = frontierTokens / totalTokens;
  if (frontierFraction <= FRONTIER_SHARE_THRESHOLD) return null;

  // Name the largest frontier contributor with an actual in-vendor
  // alternative — "prefer a smaller model" isn't actionable, a specific
  // model name is.
  const byVolumeDesc = [...frontierModels].sort(
    (a, b) =>
      b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );
  for (const m of byVolumeDesc) {
    const sibling = cheaperSiblingModel(m.model);
    if (sibling) return { dominant: m, suggestedModel: sibling };
  }
  return null;
}

/**
 * A token mix dominated by frontier-tier models, aggregated across a window.
 * This is answerable from OTEL totals alone (no per-request features needed),
 * which is exactly why it belongs here rather than in the per-event rules.
 *
 * The percentage is the frontier share of ALL tokens in the window, which
 * can span several frontier-tier models across different vendors — the
 * detail wording says so explicitly rather than implying the percentage
 * belongs to the one model it names.
 *
 * Savings, by contrast, are deliberately NOT summed across vendors: pricing
 * every frontier model's tokens at one sibling's rate would silently compare
 * across vendors (e.g. pricing gpt-4o tokens as if they were claude-sonnet-5),
 * which is exactly the cross-vendor comparison this rule (and
 * frontier-trivial.ts) otherwise refuses to make. So the counterfactual only
 * covers the largest frontier contributor's own tokens, priced against its
 * own in-vendor sibling by the shared pricer (see resolveActual and
 * ../index.ts's priceFinding). If that contributor has no in-vendor sibling,
 * selectDominant falls back to the next-largest frontier model before giving
 * up on a recommendation entirely.
 */
export const frontierShareRule: Rule<AggregateWindow> = {
  id: "frontier_share",
  grain: "aggregate",
  defaultSeverity: "warn",

  evaluate(window: AggregateWindow, _ctx: RuleContext): RuleFinding | null {
    const selected = selectDominant(window);
    if (!selected) return null;
    const { dominant, suggestedModel } = selected;

    const frontierModels = window.byModel.filter(
      (m) => m.modelTier === "frontier",
    );
    const frontierTokens = frontierModels.reduce(
      (sum, m) => sum + m.inputTokens + m.outputTokens,
      0,
    );
    const totalTokens = window.byModel.reduce(
      (sum, m) => sum + m.inputTokens + m.outputTokens,
      0,
    );
    const frontierFraction = frontierTokens / totalTokens;
    const pct = Math.floor(frontierFraction * 100);
    const multipleFrontierModels = frontierModels.length > 1;

    const detail = multipleFrontierModels
      ? `${pct}% of your tokens in this window went to frontier-tier models, ` +
        `the largest being ${dominant.model}. Consider ${suggestedModel} for ` +
        `routine work.`
      : `${pct}% of your tokens in this window went to a frontier-tier model ` +
        `(${dominant.model}). Consider ${suggestedModel} for routine work.`;

    return {
      title: "Frontier-heavy token mix",
      detail,
      eventIds: [],
      implicatedTokens: frontierTokens,
      counterfactual: {
        model: suggestedModel,
        inputTokens: dominant.inputTokens,
        outputTokens: dominant.outputTokens,
        cacheReadTokens: dominant.cacheReadTokens,
        cacheCreationTokens: dominant.cacheCreationTokens,
      },
      assumption:
        `Assumes routine work moves from ${dominant.model} to ${suggestedModel}. ` +
        `Other vendors' frontier tokens are counted in the share but not repriced.`,
    };
  },

  /**
   * The dominant model's own totals — NOT the window's. Pricing the whole
   * window against one sibling's rate would compare across vendors, which is
   * exactly what this rule otherwise refuses to do.
   *
   * Re-selects rather than caching: a Rule is a stateless singleton, so
   * stashing the selection between evaluate() and resolveActual() would leak
   * across users. selectDominant() is the shared helper both call.
   */
  resolveActual(window: AggregateWindow): Actual | null {
    const selected = selectDominant(window);
    if (!selected) return null;
    const { dominant } = selected;
    return {
      model: dominant.model,
      inputTokens: dominant.inputTokens,
      outputTokens: dominant.outputTokens,
      cacheReadTokens: dominant.cacheReadTokens,
      cacheCreationTokens: dominant.cacheCreationTokens,
    };
  },
};
