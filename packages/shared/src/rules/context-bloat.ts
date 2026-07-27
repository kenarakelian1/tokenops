import { estimateCostUsd } from "../pricing.js";
import type { UsageEvent } from "../schema/event.js";
import type { RuleHit } from "./types.js";

/** Minimum events in session (including current) before bloat is evaluated. */
export const BLOAT_MIN_EVENTS = 3;

/** Current inputTokens / first inputTokens must be at least this ratio. */
export const BLOAT_INPUT_GROWTH_RATIO = 1.8;

/** Max new-content ratio — low values mean mostly repeated context. */
export const BLOAT_MAX_NEW_CONTENT_RATIO = 0.25;

/**
 * Session context growing with little new content (history / stale files bloating context).
 * Requires sessionId and sessionContext with enough prior events.
 * Wasted = current.inputTokens − first.inputTokens.
 */
export function checkContextBloat(
  event: UsageEvent,
  sessionContext?: UsageEvent[],
): RuleHit | null {
  if (!event.sessionId) return null;
  if (!sessionContext || sessionContext.length < 2) return null;
  // current + prior must meet minimum event count
  if (sessionContext.length + 1 < BLOAT_MIN_EVENTS) return null;

  const first = sessionContext[0]!;
  if (first.inputTokens <= 0) return null;

  const growth = event.inputTokens / first.inputTokens;
  if (growth < BLOAT_INPUT_GROWTH_RATIO) return null;

  const newContentRatio = event.features.newContentRatio;
  if (newContentRatio === undefined) return null;
  if (newContentRatio > BLOAT_MAX_NEW_CONTENT_RATIO) return null;

  const estimatedWastedTokens = Math.max(
    0,
    event.inputTokens - first.inputTokens,
  );
  if (estimatedWastedTokens === 0) return null;

  const totalCost =
    event.costUsd ??
    estimateCostUsd(event.model, event.inputTokens, event.outputTokens);
  const totalTokens = event.inputTokens + event.outputTokens;
  let estimatedWastedUsd: number | null = null;
  if (totalCost != null && totalTokens > 0) {
    estimatedWastedUsd = totalCost * (estimatedWastedTokens / totalTokens);
  }

  const eventIds = [
    ...sessionContext.map((e) => e.eventId),
    event.eventId,
  ];

  return {
    ruleId: "context_bloat",
    severity: "warn",
    title: "Context bloat",
    detail:
      "Input tokens grew substantially across this session while little new content " +
      "was added. Trim history, summarize, or drop stale files from context.",
    estimatedWastedTokens,
    estimatedWastedUsd,
    eventIds,
  };
}
