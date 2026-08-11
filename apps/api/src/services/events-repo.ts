import {
  and,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  CONTEXT_BAND_EDGES,
  contextBandIndex,
  getModelTier,
  type Counterfactual,
  type EventGrain,
  type ModelWindowTotals,
  type SessionRollup,
  type UsageEvent,
  type UsageFeatures,
} from "@tokenops/shared";
import type { Db } from "../db/client.js";
import {
  dailyAggregates,
  eventContent,
  machines,
  recommendations,
  usageEvents,
  type DailyAggregate,
  type Machine,
  type Recommendation,
  type RecommendationStatus,
  type UsageEventRow,
} from "../db/schema.js";

export type EventListFilters = {
  machineId?: string;
  app?: string;
  model?: string;
  from?: string;
  to?: string;
  limit?: number;
};

export type AggregateListFilters = {
  from?: string;
  to?: string;
};

export type SessionCoverage = {
  sessionsConsidered: number;
  unattributedTurns: number;
  unattributedInputTokens: number;
};

export type RecommendationInsert = {
  userId: string;
  ruleId: string;
  severity: string;
  title: string;
  detail: string;
  estimatedWastedTokens: number;
  estimatedWastedUsd: number | null;
  eventIds: string[];
  dedupeKey: string;
  counterfactual: Counterfactual | null;
  assumption: string | null;
};

/** Data access for usage events, aggregates, recommendations, machines. */
export type EventsRepo = {
  insertEventIfNew(
    userId: string,
    event: UsageEvent,
  ): Promise<"accepted" | "duplicate">;
  insertEventContent(
    eventId: string,
    content: { requestBody?: unknown; responseBody?: unknown },
    expiresAt: Date,
  ): Promise<void>;
  bumpDailyAggregate(
    userId: string,
    day: string,
    machineId: string,
    app: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    costUsd: number,
  ): Promise<void>;
  listSessionEvents(
    userId: string,
    sessionId: string,
    limit: number,
    beforeTimestamp?: Date,
  ): Promise<UsageEvent[]>;
  listEvents(userId: string, filters: EventListFilters): Promise<UsageEventRow[]>;
  countEvents(userId?: string): Promise<number>;
  listAggregates(
    userId: string,
    filters: AggregateListFilters,
  ): Promise<DailyAggregate[]>;
  /**
   * Per-model totals over [sinceIso, untilIso) for the aggregate rules
   * (see @tokenops/shared runAggregateRules). inputTokens/outputTokens are
   * plain sums (the columns are NOT NULL). cacheReadTokens,
   * cacheCreationTokens, and costUsd are nullable columns where NULL means
   * "never recorded" (pre cache-tracking / pre grain migration) and 0 means
   * "recorded as genuinely zero" — collapsing that distinction with
   * COALESCE(...,0) would silently understate a window that straddles the
   * migration and produce a confidently wrong finding. So each of those
   * three totals is `null` whenever ANY row contributing to the model's
   * group has a null value in that column, and otherwise is the real sum.
   */
  modelWindowTotals(
    userId: string,
    sinceIso: string,
    untilIso: string,
  ): Promise<ModelWindowTotals[]>;
  /**
   * Per-session totals plus a context-size histogram, for the session rules.
   *
   * Only request-grain events with a sessionId participate. Aggregate-grain
   * rows are time-bucketed sums with no single request inside them, so they
   * have no context size to band. Events with no sessionId (sidechain /
   * subagent turns, by the adapter's design) belong to no session — see
   * sessionCoverage, which reports what they add up to.
   *
   * cacheReadTokens/cacheCreationTokens are NULL for the whole session if
   * ANY turn in it lacks a breakdown, same rule as modelWindowTotals: a
   * COALESCE-to-0 sum would turn "unknown" into "checked, and zero".
   */
  sessionRollups(
    userId: string,
    sinceIso: string,
    untilIso: string,
  ): Promise<SessionRollup[]>;
  /**
   * How much of the window the session rollups actually cover. Lets the UI
   * state its own blind spot instead of presenting partial coverage as
   * total.
   */
  sessionCoverage(
    userId: string,
    sinceIso: string,
    untilIso: string,
  ): Promise<SessionCoverage>;
  upsertRecommendation(rec: RecommendationInsert): Promise<void>;
  /**
   * Delete every OPEN recommendation for (userId, ruleId) whose dedupeKey
   * is not `keepDedupeKey` — i.e. every stale card left over from a window
   * that has since rolled off. Used by the aggregate-rules job so at most
   * one live card per aggregate rule exists at a time, instead of
   * accumulating one new row per day forever.
   *
   * Delete, not dismiss: a superseded window isn't a user judgement, same
   * reasoning as clear-stale-recommendations.mjs. Returns the number of
   * rows removed.
   */
  supersedeOpenRecommendations(
    userId: string,
    ruleId: string,
    keepDedupeKey: string,
  ): Promise<number>;
  listRecommendations(
    userId: string,
    status?: RecommendationStatus,
  ): Promise<Recommendation[]>;
  dismissRecommendation(userId: string, id: string): Promise<boolean>;
  upsertMachine(
    userId: string,
    machineId: string,
    name: string,
    queueDepth?: number,
  ): Promise<void>;
  hasMachine(userId: string, machineId: string): Promise<boolean>;
  countMachines(userId: string): Promise<number>;
  listMachines(userId: string): Promise<Machine[]>;
};

/**
 * Map a stored row to the shape rules consume. Carries `grain` through
 * unchanged — `runRules`' aggregate gate (see @tokenops/shared `isAggregate`)
 * keys off it, and dropping it here would let request-grain rules evaluate
 * aggregate rows (whose features are fabricated placeholders) and manufacture
 * findings from garbage. Also carries `sessionId`, `cacheReadTokens`,
 * `cacheCreationTokens`, and `features` through unchanged for the same reason
 * — each feeds a rule or the pricer directly. Exported so callers that need
 * the same mapping (e.g. the recommendations backtest route) reuse this
 * instead of writing a second one.
 */
export function rowToUsageEvent(row: UsageEventRow): UsageEvent {
  return {
    eventId: row.eventId,
    timestamp: row.timestamp.toISOString(),
    machineId: row.machineId,
    machineName: row.machineName,
    app: row.app,
    provider: row.provider,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: row.costUsd != null ? Number(row.costUsd) : null,
    latencyMs: row.latencyMs ?? undefined,
    sessionId: row.sessionId ?? undefined,
    grain: (row.grain as EventGrain | null) ?? undefined,
    features: row.features as UsageFeatures,
    hasContent: row.hasContent,
    cacheReadTokens: row.cacheReadTokens ?? undefined,
    cacheCreationTokens: row.cacheCreationTokens ?? undefined,
  };
}

type BandRow = { sessionId: string | null; band: number; turns: string | number; reads: string | number };
type TotalRow = {
  sessionId: string | null;
  model: string;
  start: string | Date;
  end: string | Date;
  turns: string | number;
  inputTokens: string | number;
  outputTokens: string | number;
  cacheReadTokens: string | number | null;
  cacheCreationTokens: string | number | null;
};

/**
 * Fold per-(session, band) and per-(session, model) rows into one rollup per
 * session. Shared by both repo implementations so the memory repo used in
 * tests and the Drizzle repo the server runs cannot diverge in shape.
 *
 * The dominant model is the one with the most input tokens in the session,
 * because that is what the counterfactual is priced at — a session that is
 * 90% Opus and 10% Haiku must not be priced as Haiku.
 */
function assembleSessionRollups(
  bandRows: BandRow[],
  totalRows: TotalRow[],
): SessionRollup[] {
  const n = (v: string | number | null | undefined): number => Number(v ?? 0);
  const out = new Map<string, SessionRollup>();
  /**
   * sessionId -> the input-token count of the model currently holding the
   * "dominant" slot. Tracked separately because `rollup.inputTokens` is a
   * running SUM across models and so cannot be compared against a single
   * model's slice once more than one has been folded in.
   */
  const dominantInput = new Map<string, number>();

  for (const row of totalRows) {
    if (!row.sessionId) continue;
    const existing = out.get(row.sessionId);
    const inputTokens = n(row.inputTokens);
    const start = new Date(row.start).toISOString();
    const end = new Date(row.end).toISOString();

    if (!existing) {
      dominantInput.set(row.sessionId, inputTokens);
      out.set(row.sessionId, {
        sessionId: row.sessionId,
        start,
        end,
        turnCount: n(row.turns),
        model: row.model,
        modelTier: getModelTier(row.model),
        inputTokens,
        outputTokens: n(row.outputTokens),
        cacheReadTokens: row.cacheReadTokens === null ? null : n(row.cacheReadTokens),
        cacheCreationTokens: row.cacheCreationTokens === null ? null : n(row.cacheCreationTokens),
        turnsByContextBand: new Array(CONTEXT_BAND_EDGES.length).fill(0),
        cacheReadByContextBand: new Array(CONTEXT_BAND_EDGES.length).fill(0),
      });
      continue;
    }

    // A model slice with MORE input tokens than the incumbent takes over as
    // the session's dominant model.
    if (inputTokens > (dominantInput.get(row.sessionId) ?? 0)) {
      dominantInput.set(row.sessionId, inputTokens);
      existing.model = row.model;
      existing.modelTier = getModelTier(row.model);
    }
    existing.turnCount += n(row.turns);
    existing.inputTokens += inputTokens;
    existing.outputTokens += n(row.outputTokens);
    // null wins: if any model-slice of the session lacks a breakdown, the
    // session as a whole has an unknown one.
    existing.cacheReadTokens =
      row.cacheReadTokens === null || existing.cacheReadTokens === null
        ? null
        : existing.cacheReadTokens + n(row.cacheReadTokens);
    existing.cacheCreationTokens =
      row.cacheCreationTokens === null || existing.cacheCreationTokens === null
        ? null
        : existing.cacheCreationTokens + n(row.cacheCreationTokens);
    if (start < existing.start) existing.start = start;
    if (end > existing.end) existing.end = end;
  }

  for (const row of bandRows) {
    if (!row.sessionId) continue;
    const rollup = out.get(row.sessionId);
    if (!rollup) continue;
    rollup.turnsByContextBand[row.band] += n(row.turns);
    rollup.cacheReadByContextBand[row.band] += n(row.reads);
  }

  return [...out.values()];
}

/** Drizzle-backed EventsRepo for production. */
export function createDrizzleEventsRepo(db: Db): EventsRepo {
  return {
    async insertEventIfNew(userId, event) {
      const ts = new Date(event.timestamp);
      const result = await db
        .insert(usageEvents)
        .values({
          eventId: event.eventId,
          userId,
          timestamp: ts,
          machineId: event.machineId,
          machineName: event.machineName,
          app: event.app,
          provider: event.provider,
          model: event.model,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          costUsd:
            event.costUsd != null ? String(event.costUsd) : null,
          latencyMs: event.latencyMs ?? null,
          sessionId: event.sessionId ?? null,
          grain: event.grain ?? null,
          features: event.features,
          hasContent: event.hasContent && event.content != null,
          cacheReadTokens: event.cacheReadTokens ?? null,
          cacheCreationTokens: event.cacheCreationTokens ?? null,
        })
        .onConflictDoNothing({ target: usageEvents.eventId })
        .returning({ eventId: usageEvents.eventId });
      return result.length > 0 ? "accepted" : "duplicate";
    },

    async insertEventContent(eventId, content, expiresAt) {
      await db
        .insert(eventContent)
        .values({
          eventId,
          requestBody: content.requestBody ?? null,
          responseBody: content.responseBody ?? null,
          expiresAt,
        })
        .onConflictDoNothing({ target: eventContent.eventId });
    },

    async bumpDailyAggregate(
      userId,
      day,
      machineId,
      app,
      model,
      inputTokens,
      outputTokens,
      costUsd,
    ) {
      await db
        .insert(dailyAggregates)
        .values({
          userId,
          day,
          machineId,
          app,
          model,
          inputTokens,
          outputTokens,
          costUsd: String(costUsd),
          eventCount: 1,
        })
        .onConflictDoUpdate({
          target: [
            dailyAggregates.userId,
            dailyAggregates.day,
            dailyAggregates.machineId,
            dailyAggregates.app,
            dailyAggregates.model,
          ],
          set: {
            inputTokens: sql`${dailyAggregates.inputTokens} + ${inputTokens}`,
            outputTokens: sql`${dailyAggregates.outputTokens} + ${outputTokens}`,
            costUsd: sql`${dailyAggregates.costUsd} + ${String(costUsd)}`,
            eventCount: sql`${dailyAggregates.eventCount} + 1`,
          },
        });
    },

    async listSessionEvents(userId, sessionId, limit, beforeTimestamp) {
      const conditions = [
        eq(usageEvents.userId, userId),
        eq(usageEvents.sessionId, sessionId),
      ];
      if (beforeTimestamp) {
        conditions.push(lte(usageEvents.timestamp, beforeTimestamp));
      }
      const rows = await db
        .select()
        .from(usageEvents)
        .where(and(...conditions))
        .orderBy(desc(usageEvents.timestamp))
        .limit(limit);
      return rows.map(rowToUsageEvent);
    },

    async listEvents(userId, filters) {
      const conditions = [eq(usageEvents.userId, userId)];
      if (filters.machineId) {
        conditions.push(eq(usageEvents.machineId, filters.machineId));
      }
      if (filters.app) {
        conditions.push(eq(usageEvents.app, filters.app));
      }
      if (filters.model) {
        conditions.push(eq(usageEvents.model, filters.model));
      }
      if (filters.from) {
        conditions.push(gte(usageEvents.timestamp, new Date(filters.from)));
      }
      if (filters.to) {
        conditions.push(lte(usageEvents.timestamp, new Date(filters.to)));
      }
      const limit = Math.min(Math.max(filters.limit ?? 100, 1), 1000);
      return db
        .select()
        .from(usageEvents)
        .where(and(...conditions))
        .orderBy(desc(usageEvents.timestamp))
        .limit(limit);
    },

    async countEvents(userId) {
      if (userId) {
        const rows = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(usageEvents)
          .where(eq(usageEvents.userId, userId));
        return rows[0]?.count ?? 0;
      }
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(usageEvents);
      return rows[0]?.count ?? 0;
    },

    async listAggregates(userId, filters) {
      const conditions = [eq(dailyAggregates.userId, userId)];
      if (filters.from) {
        conditions.push(gte(dailyAggregates.day, filters.from.slice(0, 10)));
      }
      if (filters.to) {
        conditions.push(lte(dailyAggregates.day, filters.to.slice(0, 10)));
      }
      return db
        .select()
        .from(dailyAggregates)
        .where(and(...conditions))
        .orderBy(desc(dailyAggregates.day));
    },

    async modelWindowTotals(userId, sinceIso, untilIso) {
      const since = new Date(sinceIso);
      const until = new Date(untilIso);
      const rows = await db
        .select({
          model: usageEvents.model,
          inputTokens: sql<string>`SUM(${usageEvents.inputTokens})`,
          outputTokens: sql<string>`SUM(${usageEvents.outputTokens})`,
          // NULL whenever any row in the group has a NULL cache/cost value —
          // see the doc comment on EventsRepo.modelWindowTotals for why a
          // COALESCE-to-0 sum is wrong here.
          cacheReadTokens: sql<string | null>`CASE WHEN bool_or(${usageEvents.cacheReadTokens} IS NULL) THEN NULL ELSE SUM(${usageEvents.cacheReadTokens}) END`,
          cacheCreationTokens: sql<string | null>`CASE WHEN bool_or(${usageEvents.cacheCreationTokens} IS NULL) THEN NULL ELSE SUM(${usageEvents.cacheCreationTokens}) END`,
          costUsd: sql<string | null>`CASE WHEN bool_or(${usageEvents.costUsd} IS NULL) THEN NULL ELSE SUM(${usageEvents.costUsd}) END`,
        })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.userId, userId),
            gte(usageEvents.timestamp, since),
            lt(usageEvents.timestamp, until),
          ),
        )
        .groupBy(usageEvents.model);

      return rows.map((r) => ({
        model: r.model,
        modelTier: getModelTier(r.model),
        inputTokens: Number(r.inputTokens),
        outputTokens: Number(r.outputTokens),
        cacheReadTokens: r.cacheReadTokens == null ? null : Number(r.cacheReadTokens),
        cacheCreationTokens:
          r.cacheCreationTokens == null ? null : Number(r.cacheCreationTokens),
        costUsd: r.costUsd == null ? null : Number(r.costUsd),
      }));
    },

    async sessionRollups(userId, sinceIso, untilIso) {
      const since = new Date(sinceIso);
      const until = new Date(untilIso);
      // grain is nullable, and `grain <> 'aggregate'` evaluates to NULL (so
      // the row is EXCLUDED) wherever grain is NULL, which is the common
      // case for ordinary request events. Without the `or(isNull(...), ...)`
      // branch this filter would silently drop nearly every event.
      const scope = and(
        eq(usageEvents.userId, userId),
        gte(usageEvents.timestamp, since),
        lt(usageEvents.timestamp, until),
        isNotNull(usageEvents.sessionId),
        or(isNull(usageEvents.grain), ne(usageEvents.grain, "aggregate")),
      );

      // Band index derived from CONTEXT_BAND_EDGES rather than written out,
      // so the SQL cannot drift from the rule's own edges.
      const bandCase = sql.raw(
        `CASE ${CONTEXT_BAND_EDGES.slice(1)
          .map((edge, i) => `WHEN input_tokens < ${edge} THEN ${i}`)
          .join(" ")} ELSE ${CONTEXT_BAND_EDGES.length - 1} END`,
      );

      const bandRows = await db
        .select({
          sessionId: usageEvents.sessionId,
          band: sql<number>`${bandCase}`,
          turns: sql<string>`COUNT(*)`,
          reads: sql<string>`COALESCE(SUM(${usageEvents.cacheReadTokens}), 0)`,
        })
        .from(usageEvents)
        .where(scope)
        .groupBy(usageEvents.sessionId, sql`${bandCase}`);

      const totalRows = await db
        .select({
          sessionId: usageEvents.sessionId,
          model: usageEvents.model,
          start: sql<string>`MIN(${usageEvents.timestamp})`,
          end: sql<string>`MAX(${usageEvents.timestamp})`,
          turns: sql<string>`COUNT(*)`,
          inputTokens: sql<string>`SUM(${usageEvents.inputTokens})`,
          outputTokens: sql<string>`SUM(${usageEvents.outputTokens})`,
          cacheReadTokens: sql<string | null>`CASE WHEN bool_or(${usageEvents.cacheReadTokens} IS NULL) THEN NULL ELSE SUM(${usageEvents.cacheReadTokens}) END`,
          cacheCreationTokens: sql<string | null>`CASE WHEN bool_or(${usageEvents.cacheCreationTokens} IS NULL) THEN NULL ELSE SUM(${usageEvents.cacheCreationTokens}) END`,
        })
        .from(usageEvents)
        .where(scope)
        .groupBy(usageEvents.sessionId, usageEvents.model);

      return assembleSessionRollups(bandRows, totalRows);
    },

    async sessionCoverage(userId, sinceIso, untilIso) {
      const since = new Date(sinceIso);
      const until = new Date(untilIso);
      const inWindow = and(
        eq(usageEvents.userId, userId),
        gte(usageEvents.timestamp, since),
        lt(usageEvents.timestamp, until),
        or(isNull(usageEvents.grain), ne(usageEvents.grain, "aggregate")),
      );

      const [sessions] = await db
        .select({ n: sql<string>`COUNT(DISTINCT ${usageEvents.sessionId})` })
        .from(usageEvents)
        .where(and(inWindow, isNotNull(usageEvents.sessionId)));

      const [orphans] = await db
        .select({
          turns: sql<string>`COUNT(*)`,
          inputTokens: sql<string>`COALESCE(SUM(${usageEvents.inputTokens}), 0)`,
        })
        .from(usageEvents)
        .where(and(inWindow, isNull(usageEvents.sessionId)));

      return {
        sessionsConsidered: Number(sessions?.n ?? 0),
        unattributedTurns: Number(orphans?.turns ?? 0),
        unattributedInputTokens: Number(orphans?.inputTokens ?? 0),
      };
    },

    async upsertRecommendation(rec) {
      await db
        .insert(recommendations)
        .values({
          userId: rec.userId,
          ruleId: rec.ruleId,
          severity: rec.severity,
          title: rec.title,
          detail: rec.detail,
          estimatedWastedTokens: rec.estimatedWastedTokens,
          estimatedWastedUsd:
            rec.estimatedWastedUsd != null
              ? String(rec.estimatedWastedUsd)
              : null,
          eventIds: rec.eventIds,
          counterfactual: rec.counterfactual,
          assumption: rec.assumption,
          dedupeKey: rec.dedupeKey,
          status: "open",
        })
        .onConflictDoUpdate({
          target: [
            recommendations.userId,
            recommendations.ruleId,
            recommendations.dedupeKey,
          ],
          // Principle: on conflict, refresh everything the RULE computes;
          // preserve only what the user or the system owns. A rule that
          // re-fires against a grown window (e.g. an hourly aggregate job
          // re-hitting the same UTC-day dedupeKey) recomputes severity,
          // title, detail, tokens, USD, counterfactual, and eventIds
          // together as one consistent snapshot — refreshing some of those
          // fields while leaving others (e.g. `detail`'s interpolated
          // percentage) at their first-insert values reproduces the exact
          // "stale narrative beside fresh numbers" bug this task exists to
          // eliminate. `status` and `createdAt` are deliberately excluded:
          // status records the USER's dismissal judgement, which a re-fire
          // must never overturn, and createdAt records when the finding
          // FIRST appeared, not when it was last recomputed.
          set: {
            severity: rec.severity,
            title: rec.title,
            detail: rec.detail,
            estimatedWastedTokens: rec.estimatedWastedTokens,
            estimatedWastedUsd:
              rec.estimatedWastedUsd != null
                ? String(rec.estimatedWastedUsd)
                : null,
            eventIds: rec.eventIds,
            counterfactual: rec.counterfactual,
            assumption: rec.assumption,
          },
        });
    },

    async supersedeOpenRecommendations(userId, ruleId, keepDedupeKey) {
      const deleted = await db
        .delete(recommendations)
        .where(
          and(
            eq(recommendations.userId, userId),
            eq(recommendations.ruleId, ruleId),
            eq(recommendations.status, "open"),
            ne(recommendations.dedupeKey, keepDedupeKey),
          ),
        )
        .returning({ id: recommendations.id });
      return deleted.length;
    },

    async listRecommendations(userId, status) {
      const conditions = [eq(recommendations.userId, userId)];
      if (status) {
        conditions.push(eq(recommendations.status, status));
      }
      return db
        .select()
        .from(recommendations)
        .where(and(...conditions))
        // Savings first, so a $0.94 finding can never sit above a $23 one.
        // NULLS LAST: an unpriceable finding is not a large one.
        // estimated_wasted_usd is numeric, so the raw column sorts
        // numerically (not lexically) — do not cast it to text.
        .orderBy(
          sql`${recommendations.estimatedWastedUsd} DESC NULLS LAST`,
          desc(recommendations.createdAt),
        );
    },

    async dismissRecommendation(userId, id) {
      const result = await db
        .update(recommendations)
        .set({ status: "dismissed" })
        .where(
          and(eq(recommendations.id, id), eq(recommendations.userId, userId)),
        )
        .returning({ id: recommendations.id });
      return result.length > 0;
    },

    async upsertMachine(userId, machineId, name, queueDepth) {
      const now = new Date();
      await db
        .insert(machines)
        .values({
          machineId,
          userId,
          name,
          lastSeenAt: now,
          lastQueueDepth: queueDepth ?? 0,
        })
        .onConflictDoUpdate({
          target: [machines.userId, machines.machineId],
          set: {
            name,
            lastSeenAt: now,
            ...(queueDepth !== undefined
              ? { lastQueueDepth: queueDepth }
              : {}),
          },
        });
    },

    async hasMachine(userId, machineId) {
      const [row] = await db
        .select({ machineId: machines.machineId })
        .from(machines)
        .where(
          and(eq(machines.userId, userId), eq(machines.machineId, machineId)),
        )
        .limit(1);
      return row != null;
    },

    async countMachines(userId) {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(machines)
        .where(eq(machines.userId, userId));
      return rows[0]?.count ?? 0;
    },

    async listMachines(userId) {
      return db
        .select()
        .from(machines)
        .where(eq(machines.userId, userId))
        .orderBy(desc(machines.lastSeenAt));
    },
  };
}

type MemEvent = UsageEventRow;
type MemContent = {
  eventId: string;
  requestBody: unknown;
  responseBody: unknown;
  expiresAt: Date;
};
type MemAgg = DailyAggregate;
type MemRec = Recommendation;
type MemMachine = Machine;

/** In-memory EventsRepo for unit/route tests (no Postgres). */
export function createMemoryEventsRepo(): EventsRepo {
  const eventMap = new Map<string, MemEvent>();
  const contentMap = new Map<string, MemContent>();
  const aggMap = new Map<string, MemAgg>();
  const recMap = new Map<string, MemRec>();
  const machineMap = new Map<string, MemMachine>();
  let recSeq = 0;

  function aggKey(
    userId: string,
    day: string,
    machineId: string,
    app: string,
    model: string,
  ): string {
    return `${userId}|${day}|${machineId}|${app}|${model}`;
  }

  function recDedupeKey(userId: string, ruleId: string, dedupe: string): string {
    return `${userId}|${ruleId}|${dedupe}`;
  }

  // Mirrors the (user_id, machine_id) primary key. Keying on machineId alone
  // would let this fake pass tests that production fails.
  function machineKey(userId: string, machineId: string): string {
    return `${userId}|${machineId}`;
  }

  return {
    async insertEventIfNew(userId, event) {
      if (eventMap.has(event.eventId)) {
        return "duplicate";
      }
      const row: MemEvent = {
        eventId: event.eventId,
        userId,
        timestamp: new Date(event.timestamp),
        machineId: event.machineId,
        machineName: event.machineName,
        app: event.app,
        provider: event.provider,
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        costUsd: event.costUsd != null ? String(event.costUsd) : null,
        latencyMs: event.latencyMs ?? null,
        sessionId: event.sessionId ?? null,
        grain: event.grain ?? null,
        features: event.features,
        hasContent: Boolean(event.hasContent && event.content),
        cacheReadTokens: event.cacheReadTokens ?? null,
        cacheCreationTokens: event.cacheCreationTokens ?? null,
      };
      eventMap.set(event.eventId, row);
      return "accepted";
    },

    async insertEventContent(eventId, content, expiresAt) {
      if (contentMap.has(eventId)) return;
      contentMap.set(eventId, {
        eventId,
        requestBody: content.requestBody ?? null,
        responseBody: content.responseBody ?? null,
        expiresAt,
      });
    },

    async bumpDailyAggregate(
      userId,
      day,
      machineId,
      app,
      model,
      inputTokens,
      outputTokens,
      costUsd,
    ) {
      const key = aggKey(userId, day, machineId, app, model);
      const existing = aggMap.get(key);
      if (existing) {
        existing.inputTokens += inputTokens;
        existing.outputTokens += outputTokens;
        existing.costUsd = String(Number(existing.costUsd) + costUsd);
        existing.eventCount += 1;
      } else {
        aggMap.set(key, {
          userId,
          day,
          machineId,
          app,
          model,
          inputTokens,
          outputTokens,
          costUsd: String(costUsd),
          eventCount: 1,
        });
      }
    },

    async listSessionEvents(userId, sessionId, limit, beforeTimestamp) {
      const rows = [...eventMap.values()]
        .filter(
          (e) =>
            e.userId === userId &&
            e.sessionId === sessionId &&
            (beforeTimestamp == null || e.timestamp <= beforeTimestamp),
        )
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, limit);
      return rows.map(rowToUsageEvent);
    },

    async listEvents(userId, filters) {
      const limit = Math.min(Math.max(filters.limit ?? 100, 1), 1000);
      const from = filters.from ? new Date(filters.from) : null;
      const to = filters.to ? new Date(filters.to) : null;
      return [...eventMap.values()]
        .filter((e) => {
          if (e.userId !== userId) return false;
          if (filters.machineId && e.machineId !== filters.machineId)
            return false;
          if (filters.app && e.app !== filters.app) return false;
          if (filters.model && e.model !== filters.model) return false;
          if (from && e.timestamp < from) return false;
          if (to && e.timestamp > to) return false;
          return true;
        })
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, limit);
    },

    async countEvents(userId) {
      if (!userId) return eventMap.size;
      return [...eventMap.values()].filter((e) => e.userId === userId).length;
    },

    async listAggregates(userId, filters) {
      const fromDay = filters.from?.slice(0, 10);
      const toDay = filters.to?.slice(0, 10);
      return [...aggMap.values()]
        .filter((a) => {
          if (a.userId !== userId) return false;
          if (fromDay && a.day < fromDay) return false;
          if (toDay && a.day > toDay) return false;
          return true;
        })
        .sort((a, b) => b.day.localeCompare(a.day));
    },

    async modelWindowTotals(userId, sinceIso, untilIso) {
      const since = new Date(sinceIso);
      const until = new Date(untilIso);

      type Acc = {
        model: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadSum: number;
        cacheReadAnyNull: boolean;
        cacheCreationSum: number;
        cacheCreationAnyNull: boolean;
        costSum: number;
        costAnyNull: boolean;
      };
      const byModel = new Map<string, Acc>();

      for (const e of eventMap.values()) {
        if (e.userId !== userId) continue;
        if (e.timestamp < since || e.timestamp >= until) continue;

        let acc = byModel.get(e.model);
        if (!acc) {
          acc = {
            model: e.model,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadSum: 0,
            cacheReadAnyNull: false,
            cacheCreationSum: 0,
            cacheCreationAnyNull: false,
            costSum: 0,
            costAnyNull: false,
          };
          byModel.set(e.model, acc);
        }

        acc.inputTokens += e.inputTokens;
        acc.outputTokens += e.outputTokens;

        if (e.cacheReadTokens == null) acc.cacheReadAnyNull = true;
        else acc.cacheReadSum += e.cacheReadTokens;

        if (e.cacheCreationTokens == null) acc.cacheCreationAnyNull = true;
        else acc.cacheCreationSum += e.cacheCreationTokens;

        if (e.costUsd == null) acc.costAnyNull = true;
        else acc.costSum += Number(e.costUsd);
      }

      return [...byModel.values()].map((acc) => ({
        model: acc.model,
        modelTier: getModelTier(acc.model),
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        cacheReadTokens: acc.cacheReadAnyNull ? null : acc.cacheReadSum,
        cacheCreationTokens: acc.cacheCreationAnyNull ? null : acc.cacheCreationSum,
        costUsd: acc.costAnyNull ? null : acc.costSum,
      }));
    },

    async sessionRollups(userId, sinceIso, untilIso) {
      const since = new Date(sinceIso);
      const until = new Date(untilIso);

      // Only request-grain events with a sessionId participate — same scope
      // as the Drizzle implementation's `scope`. `e.grain !== "aggregate"`
      // is correct here (unlike the raw SQL `<>`) because both `null` and
      // `undefined` compare `!== "aggregate"` as true in JS.
      const scoped = [...eventMap.values()].filter(
        (e) =>
          e.userId === userId &&
          e.timestamp >= since &&
          e.timestamp < until &&
          e.sessionId != null &&
          e.grain !== "aggregate",
      );

      type BandAcc = { sessionId: string; band: number; turns: number; reads: number };
      type TotalAcc = {
        sessionId: string;
        model: string;
        start: Date;
        end: Date;
        turns: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadSum: number;
        cacheReadAnyNull: boolean;
        cacheCreationSum: number;
        cacheCreationAnyNull: boolean;
      };
      const bandMap = new Map<string, BandAcc>();
      const totalMap = new Map<string, TotalAcc>();

      for (const e of scoped) {
        const sessionId = e.sessionId!;
        const band = contextBandIndex(e.inputTokens);

        const bandKey = `${sessionId}|${band}`;
        const bandAcc = bandMap.get(bandKey);
        if (bandAcc) {
          bandAcc.turns += 1;
          bandAcc.reads += e.cacheReadTokens ?? 0;
        } else {
          bandMap.set(bandKey, {
            sessionId,
            band,
            turns: 1,
            reads: e.cacheReadTokens ?? 0,
          });
        }

        const totalKey = `${sessionId}|${e.model}`;
        const totalAcc = totalMap.get(totalKey);
        if (totalAcc) {
          totalAcc.turns += 1;
          totalAcc.inputTokens += e.inputTokens;
          totalAcc.outputTokens += e.outputTokens;
          if (e.cacheReadTokens == null) totalAcc.cacheReadAnyNull = true;
          else totalAcc.cacheReadSum += e.cacheReadTokens;
          if (e.cacheCreationTokens == null) totalAcc.cacheCreationAnyNull = true;
          else totalAcc.cacheCreationSum += e.cacheCreationTokens;
          if (e.timestamp < totalAcc.start) totalAcc.start = e.timestamp;
          if (e.timestamp > totalAcc.end) totalAcc.end = e.timestamp;
        } else {
          totalMap.set(totalKey, {
            sessionId,
            model: e.model,
            start: e.timestamp,
            end: e.timestamp,
            turns: 1,
            inputTokens: e.inputTokens,
            outputTokens: e.outputTokens,
            cacheReadSum: e.cacheReadTokens ?? 0,
            cacheReadAnyNull: e.cacheReadTokens == null,
            cacheCreationSum: e.cacheCreationTokens ?? 0,
            cacheCreationAnyNull: e.cacheCreationTokens == null,
          });
        }
      }

      const bandRows = [...bandMap.values()];
      const totalRows = [...totalMap.values()].map((r) => ({
        sessionId: r.sessionId,
        model: r.model,
        start: r.start,
        end: r.end,
        turns: r.turns,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadAnyNull ? null : r.cacheReadSum,
        cacheCreationTokens: r.cacheCreationAnyNull ? null : r.cacheCreationSum,
      }));

      return assembleSessionRollups(bandRows, totalRows);
    },

    async sessionCoverage(userId, sinceIso, untilIso) {
      const since = new Date(sinceIso);
      const until = new Date(untilIso);

      const inWindow = [...eventMap.values()].filter(
        (e) =>
          e.userId === userId &&
          e.timestamp >= since &&
          e.timestamp < until &&
          e.grain !== "aggregate",
      );

      const sessionIds = new Set<string>();
      let unattributedTurns = 0;
      let unattributedInputTokens = 0;
      for (const e of inWindow) {
        if (e.sessionId != null) {
          sessionIds.add(e.sessionId);
        } else {
          unattributedTurns += 1;
          unattributedInputTokens += e.inputTokens;
        }
      }

      return {
        sessionsConsidered: sessionIds.size,
        unattributedTurns,
        unattributedInputTokens,
      };
    },

    async upsertRecommendation(rec) {
      const key = recDedupeKey(rec.userId, rec.ruleId, rec.dedupeKey);
      const existing = recMap.get(key);
      if (existing) {
        // Principle: on conflict, refresh everything the RULE computes;
        // preserve only what the user or the system owns — same reasoning
        // as the Drizzle onConflictDoUpdate `set` above, kept symmetric so
        // this fake can't pass a test the real implementation fails.
        // `status` and `createdAt` are the two exceptions: status is the
        // user's dismissal judgement (a re-fire must never overturn it),
        // and createdAt is when the finding first appeared, not when it
        // was last recomputed — both are left untouched below.
        existing.severity = rec.severity;
        existing.title = rec.title;
        existing.detail = rec.detail;
        existing.estimatedWastedTokens = rec.estimatedWastedTokens;
        existing.estimatedWastedUsd =
          rec.estimatedWastedUsd != null ? String(rec.estimatedWastedUsd) : null;
        existing.eventIds = rec.eventIds;
        existing.counterfactual = rec.counterfactual;
        existing.assumption = rec.assumption;
        return;
      }
      recSeq += 1;
      const id = `00000000-0000-4000-8000-${String(recSeq).padStart(12, "0")}`;
      recMap.set(key, {
        id,
        userId: rec.userId,
        ruleId: rec.ruleId,
        severity: rec.severity,
        title: rec.title,
        detail: rec.detail,
        estimatedWastedTokens: rec.estimatedWastedTokens,
        estimatedWastedUsd:
          rec.estimatedWastedUsd != null
            ? String(rec.estimatedWastedUsd)
            : null,
        eventIds: rec.eventIds,
        counterfactual: rec.counterfactual,
        assumption: rec.assumption,
        dedupeKey: rec.dedupeKey,
        status: "open",
        createdAt: new Date(),
      });
    },

    async supersedeOpenRecommendations(userId, ruleId, keepDedupeKey) {
      let deleted = 0;
      for (const [key, rec] of recMap.entries()) {
        if (
          rec.userId === userId &&
          rec.ruleId === ruleId &&
          rec.status === "open" &&
          rec.dedupeKey !== keepDedupeKey
        ) {
          recMap.delete(key);
          deleted += 1;
        }
      }
      return deleted;
    },

    async listRecommendations(userId, status) {
      return [...recMap.values()]
        .filter((r) => {
          if (r.userId !== userId) return false;
          if (status && r.status !== status) return false;
          return true;
        })
        .sort((a, b) => {
          // Mirrors the Drizzle `estimated_wasted_usd DESC NULLS LAST, created_at DESC`
          // ordering above — kept symmetric so this fake can't pass a test
          // the real implementation fails. Compared as numbers, not strings:
          // estimatedWastedUsd is stored as a string, and string comparison
          // would put "9.00" above "23.00".
          const au = a.estimatedWastedUsd == null ? null : Number(a.estimatedWastedUsd);
          const bu = b.estimatedWastedUsd == null ? null : Number(b.estimatedWastedUsd);
          if (au == null && bu != null) return 1;
          if (bu == null && au != null) return -1;
          if (au != null && bu != null && au !== bu) return bu - au;
          return b.createdAt.getTime() - a.createdAt.getTime();
        });
    },

    async dismissRecommendation(userId, id) {
      for (const rec of recMap.values()) {
        if (rec.id === id && rec.userId === userId) {
          rec.status = "dismissed";
          return true;
        }
      }
      return false;
    },

    async upsertMachine(userId, machineId, name, queueDepth) {
      const key = machineKey(userId, machineId);
      const existing = machineMap.get(key);
      const now = new Date();
      if (existing) {
        existing.name = name;
        existing.lastSeenAt = now;
        if (queueDepth !== undefined) {
          existing.lastQueueDepth = queueDepth;
        }
      } else {
        machineMap.set(key, {
          machineId,
          userId,
          name,
          lastSeenAt: now,
          lastQueueDepth: queueDepth ?? 0,
        });
      }
    },

    async hasMachine(userId, machineId) {
      const m = machineMap.get(machineKey(userId, machineId));
      return m != null && m.userId === userId;
    },

    async countMachines(userId) {
      return [...machineMap.values()].filter((m) => m.userId === userId)
        .length;
    },

    async listMachines(userId) {
      return [...machineMap.values()]
        .filter((m) => m.userId === userId)
        .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
    },
  };
}
