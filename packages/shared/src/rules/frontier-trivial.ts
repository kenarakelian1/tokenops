import { cheaperSiblingModel, estimateCostUsd } from "../pricing.js";
import type { UsageEvent } from "../schema/event.js";
import type { RuleHit } from "./types.js";

/** Max total tokens for a call to be considered "trivial". */
export const FRONTIER_TRIVIAL_MAX_TOTAL_TOKENS = 200;

/**
 * Frontier model used for a trivial request (few tokens, few messages, no large paste).
 * Savings: cost(frontier) − cost(default small model).
 */
export function checkFrontierTrivial(event: UsageEvent): RuleHit | null {
  const { features, inputTokens, outputTokens } = event;
  const totalTokens = inputTokens + outputTokens;

  if (features.modelTier !== "frontier") return null;
  if (totalTokens > FRONTIER_TRIVIAL_MAX_TOTAL_TOKENS) return null;
  if (features.messageCount == null) return null;
  if (features.largePasteScore == null) return null;
  if (features.messageCount > 2) return null;
  if (features.largePasteScore >= 0.3) return null;

  // Cross-vendor advice is not actionable — a user can't switch an
  // individual call from, say, Claude Opus to GPT-4o-mini. If there's no
  // cheaper model in the same vendor family, there's no recommendation to
  // make.
  const suggestedModel = cheaperSiblingModel(event.model);
  if (!suggestedModel) return null;

  const frontierCost =
    event.costUsd ??
    estimateCostUsd(event.model, inputTokens, outputTokens);
  const smallCost = estimateCostUsd(suggestedModel, inputTokens, outputTokens);

  let estimatedWastedUsd: number | null = null;
  if (frontierCost != null && smallCost != null) {
    estimatedWastedUsd = Math.max(0, frontierCost - smallCost);
  } else if (frontierCost != null) {
    estimatedWastedUsd = frontierCost;
  }

  return {
    ruleId: "frontier_trivial",
    severity: "warn",
    title: "Frontier model for trivial task",
    detail:
      `This request used a frontier-tier model for a small prompt/response. ` +
      `Consider switching to ${suggestedModel} for simple tasks like this.`,
    estimatedWastedTokens: totalTokens,
    estimatedWastedUsd,
    eventIds: [event.eventId],
  };
}
