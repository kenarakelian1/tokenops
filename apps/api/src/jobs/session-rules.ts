import {
  SESSION_RULE_IDS,
  runSessionRules,
  type RuleHit,
  type SessionRollup,
} from "@tokenops/shared";
import type { Db } from "../db/client.js";
import { usageEvents } from "../db/schema.js";
import type { EventsRepo } from "../services/events-repo.js";

export const HOUR_MS = 60 * 60 * 1000;

/** Trailing window the session rules look back over. */
export const SESSION_WINDOW_DAYS = 7;

/**
 * Open cards per rule, ranked by savings.
 *
 * Ten because consumption is that concentrated: across a measured week the
 * top 10 sessions of 190 were 80.1% of all consumption, so ten cards cover
 * most of what is worth acting on. PER RULE rather than overall, because
 * ceiling findings are worth far more than churn findings and a single
 * shared cap would crowd churn out of the panel entirely.
 */
export const MAX_SESSION_CARDS_PER_RULE = 10;

function truncateToUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/** 7 days ending now, start truncated to the UTC day. Mirrors aggregateWindowBounds. */
export function sessionWindowBounds(now: Date): {
  startIso: string;
  endIso: string;
} {
  const start = new Date(
    truncateToUtcDay(now).getTime() -
      SESSION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  return { startIso: start.toISOString(), endIso: now.toISOString() };
}

/** Descending by savings; a known USD always outranks an unpriceable null. */
function bySavingsDesc(a: { hit: RuleHit }, b: { hit: RuleHit }): number {
  const au = a.hit.estimatedWastedUsd;
  const bu = b.hit.estimatedWastedUsd;
  if (au == null && bu == null) {
    return b.hit.estimatedWastedTokens - a.hit.estimatedWastedTokens;
  }
  return (bu ?? -Infinity) - (au ?? -Infinity);
}

/**
 * Evaluate the session rules over one user's trailing window.
 *
 * Two differences from the aggregate job:
 *
 *  - The dedupe key is `ruleId|sessionId`, not `ruleId|windowStart`. A
 *    session is a stable identity, so re-running this job any number of
 *    times updates the same card in place rather than minting a new one as
 *    the window's start date advances.
 *  - Because the key no longer encodes the run, supersession cannot use the
 *    aggregate job's "keep this key, delete the rest" trick — that would
 *    delete every OTHER session's card on each write. Instead the whole
 *    rule's open set is cleared once, before any writes, with a key that
 *    matches nothing; the surviving cards are then re-written. That is also
 *    exactly what retires a rule that stopped firing, so no separate sweep
 *    is needed for the zero-hit case.
 *
 * Dismissal survives this sweep-then-write for two independent reasons,
 * both confirmed by reading events-repo.ts: supersedeOpenRecommendations'
 * delete is scoped to `status = "open"`, so it can never touch a dismissed
 * row; and upsertRecommendation's onConflictDoUpdate `set` deliberately
 * excludes `status` — a re-fire on the same dedupeKey refreshes what the
 * rule computed but leaves the user's dismissal judgement alone. See
 * session-rules.test.ts's "does not resurrect a session card the user
 * dismissed" for the end-to-end regression.
 */
export async function runSessionRulesForUser(
  repo: Pick<
    EventsRepo,
    "sessionRollups" | "upsertRecommendation" | "supersedeOpenRecommendations"
  >,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const { startIso, endIso } = sessionWindowBounds(now);
  const rollups: SessionRollup[] = await repo.sessionRollups(
    userId,
    startIso,
    endIso,
  );

  const byRule = new Map<string, { rollup: SessionRollup; hit: RuleHit }[]>();
  for (const rollup of rollups) {
    // Price each session at its OWN end instant. Using wall-clock `now`
    // would reprice history every time a date-gated rate changes.
    for (const hit of runSessionRules(rollup, new Date(rollup.end))) {
      const list = byRule.get(hit.ruleId) ?? [];
      list.push({ rollup, hit });
      byRule.set(hit.ruleId, list);
    }
  }

  let written = 0;
  for (const ruleId of SESSION_RULE_IDS) {
    // Clear the rule's whole open set first. "__sweep__" cannot collide
    // with any real dedupeKey, which is what makes this a full clear.
    await repo.supersedeOpenRecommendations(
      userId,
      ruleId,
      `${ruleId}|__sweep__`,
    );

    const ranked = (byRule.get(ruleId) ?? [])
      .sort(bySavingsDesc)
      .slice(0, MAX_SESSION_CARDS_PER_RULE);

    for (const { rollup, hit } of ranked) {
      await repo.upsertRecommendation({
        userId,
        ruleId: hit.ruleId,
        severity: hit.severity,
        title: hit.title,
        detail: hit.detail,
        estimatedWastedTokens: hit.estimatedWastedTokens,
        estimatedWastedUsd: hit.estimatedWastedUsd,
        eventIds: hit.eventIds,
        dedupeKey: `${hit.ruleId}|${rollup.sessionId}`,
        counterfactual: hit.counterfactual,
        assumption: hit.assumption,
      });
      written += 1;
    }
  }

  return written;
}

/** Every user id with at least one usage event, in no particular order. */
async function distinctUserIds(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: usageEvents.userId })
    .from(usageEvents);
  return rows.map((r) => r.userId);
}

/**
 * Run the session rules once for every user. Errors are swallowed per user
 * so one bad user doesn't skip everyone after them, same as the aggregate
 * job; failing to list users at all is caught separately since there is
 * nothing left to iterate.
 */
export async function runSessionRulesOnce(
  db: Db,
  repo: EventsRepo,
  log: Pick<Console, "info" | "error"> = console,
  now: Date = new Date(),
): Promise<void> {
  let userIds: string[];
  try {
    userIds = await distinctUserIds(db);
  } catch (err) {
    log.error("session-rules job failed to list users", err);
    return;
  }

  let cardCount = 0;
  for (const userId of userIds) {
    try {
      cardCount += await runSessionRulesForUser(repo, userId, now);
    } catch (err) {
      log.error(`session-rules job failed for user ${userId}`, err);
    }
  }
  log.info(
    `session-rules: usersProcessed=${userIds.length} cards=${cardCount}`,
  );
}

/** Hourly schedule, mirroring startAggregateRulesJob. */
export function startSessionRulesJob(
  db: Db,
  repo: EventsRepo,
  intervalMs: number = HOUR_MS,
  log: Pick<Console, "info" | "error"> = console,
): NodeJS.Timeout {
  void runSessionRulesOnce(db, repo, log);
  const handle = setInterval(() => {
    void runSessionRulesOnce(db, repo, log);
  }, intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  return handle;
}
