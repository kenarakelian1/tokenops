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
 * Window bounds for a given instant: 7 days ending "now". Only the START is
 * truncated to the UTC day — that's what keeps `startIso` (and therefore
 * the dedupe key built from it) stable across every run within the same
 * day, so re-running the job hourly doesn't mint a new window each time.
 * The END is `now` itself, NOT truncated: truncating the end to the start
 * of today would exclude every event timestamped today, which is exactly
 * wrong for a brand-new OTEL-only user whose recommendations come
 * exclusively from these aggregate rules (runRules gates aggregates away) —
 * their first day of usage would otherwise show an empty panel for up to
 * 24 hours.
 */
export function aggregateWindowBounds(now: Date): {
  startIso: string;
  endIso: string;
} {
  const start = new Date(
    truncateToUtcDay(now).getTime() -
      AGGREGATE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  return { startIso: start.toISOString(), endIso: now.toISOString() };
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
 *
 * That alone isn't sufficient, though: the window's start date advances
 * daily, so left unchecked this still mints one new row per rule per day,
 * forever — the same pile-of-near-identical-cards problem at 1/day instead
 * of 25. So after upserting each hit, supersede: delete any other still-open
 * card for that ruleId whose dedupeKey doesn't match this run's (i.e. every
 * card from a window that has since rolled off), so at most one live card
 * per aggregate rule exists at a time. Superseded rows are deleted, not
 * dismissed — a rolled-off window isn't a user judgement.
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
    const dedupeKey = `${hit.ruleId}|${startIso}`;
    await repo.upsertRecommendation({
      userId,
      ruleId: hit.ruleId,
      severity: hit.severity,
      title: hit.title,
      detail: hit.detail,
      estimatedWastedTokens: hit.estimatedWastedTokens,
      estimatedWastedUsd: hit.estimatedWastedUsd,
      eventIds: hit.eventIds,
      dedupeKey,
    });
    await repo.supersedeOpenRecommendations(userId, hit.ruleId, dedupeKey);
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
 * Run aggregate rules once for every user. Swallows errors per-user so one
 * bad user (e.g. a transient query failure) doesn't skip every user after
 * them until the next hour — the try/catch is scoped inside the loop, not
 * around it. Listing user ids itself can still fail the whole run; that's
 * caught separately since there's nothing left to iterate over.
 */
export async function runAggregateRulesOnce(
  db: Db,
  repo: EventsRepo,
  log: Pick<Console, "info" | "error"> = console,
  now: Date = new Date(),
): Promise<void> {
  let userIds: string[];
  try {
    userIds = await distinctUserIds(db);
  } catch (err) {
    log.error("aggregate-rules job failed to list users", err);
    return;
  }

  let hitCount = 0;
  for (const userId of userIds) {
    try {
      hitCount += await runAggregateRulesForUser(repo, userId, now);
    } catch (err) {
      log.error(`aggregate-rules job failed for user ${userId}`, err);
    }
  }
  log.info(
    `aggregate-rules: usersProcessed=${userIds.length} hits=${hitCount}`,
  );
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
