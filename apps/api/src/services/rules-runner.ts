import { runRules, type RuleHit, type UsageEvent } from "@tokenops/shared";
import type { EventsRepo } from "./events-repo.js";

/**
 * Run shared efficiency rules for an event and upsert open recommendations.
 * Dedupe key: event.eventId (unique with user_id + rule_id).
 */
export async function applyRulesForEvent(
  repo: EventsRepo,
  userId: string,
  event: UsageEvent,
  sessionContext: UsageEvent[],
): Promise<RuleHit[]> {
  const hits = runRules(event, sessionContext);
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
    });
  }
  return hits;
}
