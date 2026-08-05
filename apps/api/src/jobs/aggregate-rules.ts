import { runAggregateRules, type AggregateWindow } from "@tokenops/shared";
import type { Db } from "../db/client.js";
import { usageEvents } from "../db/schema.js";
import type { EventsRepo } from "../services/events-repo.js";

export const HOUR_MS = 60 * 60 * 1000;

/** Trailing window size for the aggregate rules. */
export const AGGREGATE_WINDOW_DAYS = 7;

function truncateToUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/**
 * Window bounds for a given instant: 7 days ending "now", truncated to the
 * day. Truncating keeps `startIso` (and therefore the dedupe key built from
 * it) stable across every run within the same UTC day, so re-running the
 * job hourly doesn't mint a new window — and a new card — each time.
 */
export function aggregateWindowBounds(now: Date): {
  startIso: string;
  endIso: string;
} {
  const end = truncateToUtcDay(now);
  const start = new Date(
    end.getTime() - AGGREGATE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

/**
 * Evaluate the aggregate rules for one user's trailing window and upsert
 * any hits.
 *
 * Dedupe key is `${ruleId}|${windowStart}` — deliberately NOT an event id.
 * An aggregate hit isn't about any single event, and keying on one anyway
 * (the bug this task fixes) meant every hourly run minted a fresh
 * "duplicate" card for the same finding: 25 identical frontier_trivial rows
 * in production. Keying on the rule + the window's start date instead means
 * running this job any number of times within the same window produces
 * exactly one open card per rule.
 */
export async function runAggregateRulesForUser(
  repo: EventsRepo,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const { startIso, endIso } = aggregateWindowBounds(now);
  const byModel = await repo.modelWindowTotals(userId, startIso, endIso);
  const window: AggregateWindow = { start: startIso, end: endIso, byModel };
  const hits = runAggregateRules(window, now);

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
      dedupeKey: `${hit.ruleId}|${startIso}`,
    });
  }

  return hits.length;
}

/** Every user id with at least one usage event, in no particular order. */
async function distinctUserIds(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: usageEvents.userId })
    .from(usageEvents);
  return rows.map((r) => r.userId);
}

/**
 * Run aggregate rules once for every user. Swallows errors so the interval
 * stays alive, same as runExpireContentOnce.
 */
export async function runAggregateRulesOnce(
  db: Db,
  repo: EventsRepo,
  log: Pick<Console, "info" | "error"> = console,
  now: Date = new Date(),
): Promise<void> {
  try {
    const userIds = await distinctUserIds(db);
    let hitCount = 0;
    for (const userId of userIds) {
      hitCount += await runAggregateRulesForUser(repo, userId, now);
    }
    log.info(
      `aggregate-rules: usersProcessed=${userIds.length} hits=${hitCount}`,
    );
  } catch (err) {
    log.error("aggregate-rules job failed", err);
  }
}

/**
 * Schedule hourly aggregate-rules evaluation across all users. Runs once
 * immediately, then every `intervalMs` — same pattern as
 * startExpireContentJob in ./expire-content.ts.
 */
export function startAggregateRulesJob(
  db: Db,
  repo: EventsRepo,
  intervalMs: number = HOUR_MS,
  log: Pick<Console, "info" | "error"> = console,
): NodeJS.Timeout {
  void runAggregateRulesOnce(db, repo, log);
  const handle = setInterval(() => {
    void runAggregateRulesOnce(db, repo, log);
  }, intervalMs);
  // Allow process to exit if nothing else is keeping it open (tests).
  if (typeof handle.unref === "function") {
    handle.unref();
  }
  return handle;
}
