import { cheaperSiblingModel } from "../pricing.js";
import type { UsageEvent } from "../schema/event.js";
import type { Rule, RuleContext, RuleFinding } from "./contract.js";

/** Max total tokens for a call to be considered "trivial". */
export const FRONTIER_TRIVIAL_MAX_TOTAL_TOKENS = 200;

/**
 * Frontier model used for a trivial request (few tokens, few messages, no
 * large paste). Counterfactual: the same call served by the cheapest sibling
 * in the SAME vendor family — cross-vendor advice isn't actionable, since a
 * user can't switch one call from Claude Opus to GPT-4o-mini.
 *
 * Declared `info`: capped at 200 tokens, the most this can ever save on one
 * call is a fraction of a cent, and in a coding agent the user does not pick
 * a model per request at all. Ordering by savings keeps it below rules that
 * carry real money.
 */
export const frontierTrivialRule: Rule<UsageEvent> = {
  id: "frontier_trivial",
  grain: "request",
  defaultSeverity: "info",

  evaluate(event: UsageEvent, _ctx: RuleContext): RuleFinding | null {
    const { features, inputTokens, outputTokens } = event;
    const totalTokens = inputTokens + outputTokens;

    if (features.modelTier !== "frontier") return null;
    if (totalTokens > FRONTIER_TRIVIAL_MAX_TOTAL_TOKENS) return null;
    if (features.messageCount == null) return null;
    if (features.largePasteScore == null) return null;
    if (features.messageCount > 2) return null;
    if (features.largePasteScore >= 0.3) return null;

    const suggestedModel = cheaperSiblingModel(event.model);
    if (!suggestedModel) return null;

    return {
      title: "Frontier model for trivial task",
      detail:
        `This request used a frontier-tier model for a small prompt/response. ` +
        `Consider switching to ${suggestedModel} for simple tasks like this.`,
      eventIds: [event.eventId],
      implicatedTokens: totalTokens,
      counterfactual: {
        model: suggestedModel,
        inputTokens,
        outputTokens,
        cacheReadTokens: event.cacheReadTokens ?? null,
        cacheCreationTokens: event.cacheCreationTokens ?? null,
      },
      assumption: `${suggestedModel} handles requests at or under ${FRONTIER_TRIVIAL_MAX_TOTAL_TOKENS} tokens as well as ${event.model}`,
    };
  },
};
