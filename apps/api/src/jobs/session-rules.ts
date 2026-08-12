import { randomUUID } from "node:crypto";
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
 * This is a panel-size budget, not a coverage claim. In the measured 7-day
 * window, 24 sessions carried mainline (non-sidechain) turns; of those, 17
 * fired `session_context_ceiling`. A cap of 10 keeps the 10 highest-savings
 * of those 17, so 7 sessions that genuinely fired the rule are omitted from
 * the panel — that is the trade-off this constant makes, not some
 * percentage of overall consumption.
 *
 * Session FILES are not sessions: the window held 228 `.jsonl` files, but
 * 203 of them are entirely subagent (sidechain) transcripts with no
 * mainline turns, so they never produce a rollup at all. 24 is the real
 * population this cap operates on; do not re-derive a larger figure by
 * counting files.
 *
 * PER RULE rather than overall, because the cap is per rule: the single
 * `session_cache_churn` finding keeps its own slot rather than sharing a
 * combined budget with the 10 `session_context_ceiling` cards and being
 * crowded out.
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
 *
 * Ordering hazard, accepted deliberately: per rule, this sweeps the whole
 * open set FIRST and writes the ranked survivors one upsert at a time
 * AFTER — the reverse of aggregate-rules.ts, which writes each new card
 * before superseding the stale one. That job can write-then-supersede
 * because its keepDedupeKey names the one card just written; this job
 * can't use the same trick (see above — one dedupeKey can't mean "keep
 * these N"), so the only way to express "clear everything, then lay down
 * this run's survivors" is to clear first. The cost: if an upsert throws
 * partway through a rule's ranked list (say the 4th of 10), that rule is
 * left with fewer open cards than it should have — silently short, not
 * merely stale — until the next hourly run repairs it. This is accepted,
 * not overlooked: every card here is derived state, fully recomputed from
 * `sessionRollups` every run, so a transient shortfall self-heals within
 * an hour. Making it atomic would mean widening
 * supersedeOpenRecommendations to accept a set of keys to keep instead of
 * one, which is out of scope for this task.
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
    // Clear the rule's whole open set first. A real dedupeKey is
    // `${ruleId}|${sessionId}`, and sessionId is unvalidated external event
    // data (z.string().optional(), no length or character restriction —
    // see packages/shared/src/schema/event.ts), so a fixed literal like
    // `${ruleId}|__sweep__` COULD collide with an actual session named
    // "__sweep__": supersedeOpenRecommendations' `dedupeKey <>
    // keepDedupeKey` predicate would then treat that one real card as
    // "kept" and it would survive a sweep meant to clear it, leaving a
    // stale card that never retires. Appending a fresh randomUUID() per
    // call makes collision require a client guessing this run's
    // just-generated UUID in advance, which is cryptographically
    // infeasible — see "sweeps a card whose session is literally named the
    // sweep sentinel" in session-rules.test.ts for the regression this
    // guards.
    const sweepKey = `${ruleId}|__sweep__${randomUUID()}`;
    await repo.supersedeOpenRecommendations(userId, ruleId, sweepKey);

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
