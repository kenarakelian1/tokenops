import { cheaperSiblingModel, estimateCostUsd } from "../../pricing.js";
import type { RuleHit } from "../types.js";
import type { AggregateWindow, ModelWindowTotals } from "./index.js";

/** Fire when frontier-tier models account for more than this share of window tokens. */
export const FRONTIER_SHARE_THRESHOLD = 0.8;

/**
 * A token mix dominated by frontier-tier models, aggregated across a window.
 * This is answerable from OTEL totals alone (no per-request features needed),
 * which is exactly why it belongs here rather than in the per-event rules.
 *
 * Savings: total frontier cost across the window minus the same frontier
 * token volume priced at a cheaper in-vendor sibling of the largest frontier
 * contributor. Cross-vendor advice is skipped (see frontier-trivial.ts) —
 * if the biggest contributor has no in-vendor sibling, we fall back to the
 * next-largest frontier model before giving up on the recommendation.
 */
export function checkFrontierShare(window: AggregateWindow): RuleHit | null {
  const { byModel } = window;

  const totalTokens = byModel.reduce(
    (sum, m) => sum + m.inputTokens + m.outputTokens,
    0,
  );
  if (totalTokens <= 0) return null;

  const frontierModels = byModel.filter((m) => m.modelTier === "frontier");
  if (frontierModels.length === 0) return null;

  const frontierInputTokens = frontierModels.reduce(
    (sum, m) => sum + m.inputTokens,
    0,
  );
  const frontierOutputTokens = frontierModels.reduce(
    (sum, m) => sum + m.outputTokens,
    0,
  );
  const frontierTokens = frontierInputTokens + frontierOutputTokens;

  const frontierFraction = frontierTokens / totalTokens;
  if (frontierFraction <= FRONTIER_SHARE_THRESHOLD) return null;

  // Name the largest frontier contributor with an actual in-vendor
  // alternative — "prefer a smaller model" isn't actionable, a specific
  // model name is.
  const byVolumeDesc = [...frontierModels].sort(
    (a, b) =>
      b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );
  let dominant: ModelWindowTotals | null = null;
  let suggestedModel: string | null = null;
  for (const m of byVolumeDesc) {
    const sibling = cheaperSiblingModel(m.model);
    if (sibling) {
      dominant = m;
      suggestedModel = sibling;
      break;
    }
  }
  if (!dominant || !suggestedModel) return null;

  const pct = Math.floor(frontierFraction * 100);

  let frontierCost: number | null = 0;
  for (const m of frontierModels) {
    const cost = m.costUsd ?? estimateCostUsd(m.model, m.inputTokens, m.outputTokens);
    if (cost == null) {
      frontierCost = null;
      break;
    }
    frontierCost += cost;
  }
  const siblingCost = estimateCostUsd(
    suggestedModel,
    frontierInputTokens,
    frontierOutputTokens,
  );

  let estimatedWastedUsd: number | null = null;
  if (frontierCost != null && siblingCost != null) {
    estimatedWastedUsd = Math.max(0, frontierCost - siblingCost);
  }

  return {
    ruleId: "frontier_share",
    severity: "warn",
    title: "Frontier-heavy token mix",
    detail:
      `${pct}% of your tokens in this window went to a frontier-tier model ` +
      `(${dominant.model}). Consider ${suggestedModel} for routine work.`,
    estimatedWastedTokens: frontierTokens,
    estimatedWastedUsd,
    eventIds: [],
  };
}
