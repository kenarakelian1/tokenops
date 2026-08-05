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
 * The percentage is the frontier share of ALL tokens in the window, which
 * can span several frontier-tier models across different vendors — the
 * detail wording says so explicitly rather than implying the percentage
 * belongs to the one model it names.
 *
 * Savings, by contrast, are deliberately NOT summed across vendors: pricing
 * every frontier model's tokens at one sibling's rate would silently compare
 * across vendors (e.g. pricing gpt-4o tokens as if they were claude-sonnet-5),
 * which is exactly the cross-vendor comparison this rule (and
 * frontier-trivial.ts) otherwise refuses to make. So estimatedWastedUsd only
 * prices the largest frontier contributor's own tokens against its own
 * in-vendor sibling. If that contributor has no in-vendor sibling, we fall
 * back to the next-largest frontier model before giving up on a
 * recommendation entirely.
 *
 * @param now Comparison instant for date-gated pricing (e.g. the Claude
 *   Sonnet 5 introductory rate). Defaults to the real current time; tests
 *   pass a fixed Date to pin behavior on either side of a cutoff.
 */
export function checkFrontierShare(
  window: AggregateWindow,
  now: Date = new Date(),
): RuleHit | null {
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
  const multipleFrontierModels = frontierModels.length > 1;

  // Priced against the dominant model's OWN tokens only — see the doc
  // comment above for why this must not sum other frontier models in.
  const dominantCost =
    dominant.costUsd ??
    estimateCostUsd(
      dominant.model,
      dominant.inputTokens,
      dominant.outputTokens,
      undefined,
      now,
    );
  const siblingCost = estimateCostUsd(
    suggestedModel,
    dominant.inputTokens,
    dominant.outputTokens,
    undefined,
    now,
  );

  let estimatedWastedUsd: number | null = null;
  if (dominantCost != null && siblingCost != null) {
    estimatedWastedUsd = Math.max(0, dominantCost - siblingCost);
  }

  const detail = multipleFrontierModels
    ? `${pct}% of your tokens in this window went to frontier-tier models, ` +
      `the largest being ${dominant.model}. Consider ${suggestedModel} for ` +
      `routine work.`
    : `${pct}% of your tokens in this window went to a frontier-tier model ` +
      `(${dominant.model}). Consider ${suggestedModel} for routine work.`;

  return {
    ruleId: "frontier_share",
    severity: "warn",
    title: "Frontier-heavy token mix",
    detail,
    estimatedWastedTokens: frontierTokens,
    estimatedWastedUsd,
    eventIds: [],
  };
}
