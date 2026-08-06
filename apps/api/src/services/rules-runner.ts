import {
  deriveNewContentRatio,
  runRules,
  type RuleHit,
  type UsageEvent,
} from "@tokenops/shared";
import type { EventsRepo } from "./events-repo.js";

/**
 * Ensure newContentRatio is present for session-aware rules.
 * Live capture paths (proxy / Claude adapter) often omit sessionPriorPromptChars,
 * so derive from the most recent prior event's promptChars when missing.
 * Expects sessionContext in chronological (oldest-first) order.
 */
export function enrichEventForRules(
  event: UsageEvent,
  sessionContext: UsageEvent[],
): UsageEvent {
  if (event.features.newContentRatio !== undefined) return event;
  if (sessionContext.length === 0) return event;
  if (event.features.promptChars == null) return event;

  const prior = sessionContext[sessionContext.length - 1]!;
  if (prior.features.promptChars == null) return event;

  const newContentRatio = deriveNewContentRatio(
    event.features.promptChars,
    prior.features.promptChars,
  );
  return {
    ...event,
    features: { ...event.features, newContentRatio },
  };
}

/**
 * Run shared efficiency rules for an event and upsert open recommendations.
 * Dedupe key: event.eventId (unique with user_id + rule_id).
 * sessionContext must be chronological (oldest first).
 */
export async function applyRulesForEvent(
  repo: EventsRepo,
  userId: string,
  event: UsageEvent,
  sessionContext: UsageEvent[],
): Promise<RuleHit[]> {
  const enriched = enrichEventForRules(event, sessionContext);
  const hits = runRules(enriched, sessionContext);
  for (const hit of hits) {
    await repo.upsertRecommendation({
      userId,
      ruleId: hit.ruleId,
      severity: hit.severity,
      title: hit.title,
      detail: hit.detail,
      estimatedWastedTokens: hit.estimatedWastedTokens,
      estimatedWastedUsd: hit.estimatedWastedUsd,
      eventIds: hit.eventIds,
      dedupeKey: event.eventId,
      counterfactual: hit.counterfactual,
      assumption: hit.assumption,
    });
  }
  return hits;
}
