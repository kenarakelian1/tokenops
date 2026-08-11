import { describe, it, expect } from "vitest";
import {
  CONTEXT_BAND_EDGES,
  type EventGrain,
  type UsageEvent,
} from "@tokenops/shared";
import { createMemoryEventsRepo, type EventsRepo } from "./events-repo.js";

// Window bounds for the sessionRollups/sessionCoverage tests below — wide
// enough to contain every generated timestamp with room either side.
const SINCE = "2026-07-31T00:00:00.000Z";
const UNTIL = "2026-08-10T00:00:00.000Z";
const SESSION_TEST_BASE_MS = Date.parse("2026-08-01T00:00:00.000Z");

function makeMemoryRepo(): EventsRepo {
  return createMemoryEventsRepo();
}

let sessionTestEventSeq = 0;

/**
 * Insert one request-grain (unless overridden) usage event for the
 * sessionRollups/sessionCoverage tests. Mirrors the shape the rest of this
 * file already builds by hand, just parameterized to the fields those tests
 * vary: model, token counts, sessionId, and grain.
 */
async function insertEvent(
  repo: EventsRepo,
  opts: {
    userId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    sessionId?: string;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    grain?: EventGrain;
  },
): Promise<void> {
  sessionTestEventSeq += 1;
  const event: UsageEvent = {
    eventId: `evt-session-test-${sessionTestEventSeq}`,
    timestamp: new Date(
      SESSION_TEST_BASE_MS + sessionTestEventSeq * 1_000,
    ).toISOString(),
    machineId: "machine-1",
    machineName: "ci-runner",
    app: "claude-code",
    provider: "anthropic",
    model: opts.model,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    costUsd: null,
    grain: opts.grain,
    features: { modelTier: "unknown" },
    hasContent: false,
    cacheReadTokens: opts.cacheReadTokens,
    cacheCreationTokens: opts.cacheCreationTokens,
    sessionId: opts.sessionId,
  };
  await repo.insertEventIfNew(opts.userId, event);
}

describe("events-repo", () => {
  it("does not let one user's heartbeat mutate another user's machine row", async () => {
    const repo = createMemoryEventsRepo();

    await repo.upsertMachine("user-a", "machine-1", "alice-laptop", 0);
    await repo.upsertMachine("user-b", "machine-1", "mallory-laptop", 5);

    const alice = await repo.listMachines("user-a");
    expect(alice).toHaveLength(1);
    expect(alice[0]!.name).toBe("alice-laptop");
    expect(alice[0]!.lastQueueDepth).toBe(0);

    const mallory = await repo.listMachines("user-b");
    expect(mallory).toHaveLength(1);
    expect(mallory[0]!.name).toBe("mallory-laptop");
  });

  it("round-trips grain and cache token fields through insert and read-back", async () => {
    // Regression for the OTEL persistence gap: an aggregate event with cache
    // tokens must survive insertEventIfNew -> listSessionEvents unchanged, or
    // window rules reading from the DB (e.g. cache_efficiency) silently see
    // "request" grain and zero cache — the exact false-finding class this
    // change exists to eliminate.
    const repo = createMemoryEventsRepo();
    const event: UsageEvent = {
      eventId: "evt-aggregate-cache-1",
      timestamp: new Date().toISOString(),
      machineId: "machine-1",
      machineName: "ci-runner",
      app: "claude-code",
      provider: "anthropic",
      model: "claude-sonnet-4",
      inputTokens: 105,
      outputTokens: 20,
      costUsd: 0.01,
      grain: "aggregate",
      features: { modelTier: "mid" },
      hasContent: false,
      cacheReadTokens: 90,
      cacheCreationTokens: 5,
      sessionId: "session-1",
    };

    const result = await repo.insertEventIfNew("user-a", event);
    expect(result).toBe("accepted");

    const [row] = await repo.listSessionEvents("user-a", "session-1", 10);
    expect(row).toBeDefined();
    expect(row!.grain).toBe("aggregate");
    expect(row!.cacheReadTokens).toBe(90);
    expect(row!.cacheCreationTokens).toBe(5);
    expect(row!.inputTokens).toBe(105);
  });

  it("modelWindowTotals: a window straddling the cache-tracking migration totals null, not a partial sum", async () => {
    // One row recorded a real cache breakdown (post-migration), the other
    // never did (pre-migration, cache folded silently into inputTokens).
    // COALESCE(SUM(...), 0) would report 90 — a partial sum that understates
    // the window and produces a confidently wrong "low cache reuse" card.
    // The correct total is null: "don't know" must not collapse into "zero".
    const repo = createMemoryEventsRepo();
    const base = {
      machineId: "machine-1",
      machineName: "ci-runner",
      app: "claude-code",
      provider: "anthropic",
      model: "claude-opus-5[1m]",
      features: { modelTier: "unknown" as const },
      hasContent: false,
    };
    await repo.insertEventIfNew("user-a", {
      ...base,
      eventId: "evt-with-cache",
      timestamp: "2026-08-01T00:00:00.000Z",
      inputTokens: 1_000,
      outputTokens: 100,
      costUsd: 0.01,
      cacheReadTokens: 90,
      cacheCreationTokens: 10,
    });
    await repo.insertEventIfNew("user-a", {
      ...base,
      eventId: "evt-no-cache",
      timestamp: "2026-08-02T00:00:00.000Z",
      inputTokens: 2_000,
      outputTokens: 200,
      costUsd: 0.02,
      // No cacheReadTokens/cacheCreationTokens at all: pre-migration row.
    });

    const totals = await repo.modelWindowTotals(
      "user-a",
      "2026-07-29T00:00:00.000Z",
      "2026-08-05T00:00:00.000Z",
    );
    expect(totals).toHaveLength(1);
    expect(totals[0]!.inputTokens).toBe(3_000); // plain sums are unaffected
    expect(totals[0]!.outputTokens).toBe(300);
    expect(totals[0]!.cacheReadTokens).toBeNull();
    expect(totals[0]!.cacheCreationTokens).toBeNull();
  });

  it("modelWindowTotals: sums real cache and cost data straight through when every row has it", async () => {
    // The null-propagation test above only ever pins the null side of the
    // three CASE expressions (cacheReadTokens, cacheCreationTokens,
    // costUsd). An implementation that returned null unconditionally for
    // all three would pass that test too — this asserts the positive case:
    // when no row in the group is missing a value, the real sum comes
    // through, not null.
    const repo = createMemoryEventsRepo();
    const base = {
      machineId: "machine-1",
      machineName: "ci-runner",
      app: "claude-code",
      provider: "anthropic",
      model: "claude-opus-5[1m]",
      features: { modelTier: "unknown" as const },
      hasContent: false,
    };
    await repo.insertEventIfNew("user-a", {
      ...base,
      eventId: "evt-full-1",
      timestamp: "2026-08-01T00:00:00.000Z",
      inputTokens: 1_000,
      outputTokens: 100,
      costUsd: 0.5,
      cacheReadTokens: 400,
      cacheCreationTokens: 50,
    });
    await repo.insertEventIfNew("user-a", {
      ...base,
      eventId: "evt-full-2",
      timestamp: "2026-08-02T00:00:00.000Z",
      inputTokens: 2_000,
      outputTokens: 200,
      costUsd: 1.25,
      cacheReadTokens: 600,
      cacheCreationTokens: 75,
    });

    const totals = await repo.modelWindowTotals(
      "user-a",
      "2026-07-29T00:00:00.000Z",
      "2026-08-05T00:00:00.000Z",
    );
    expect(totals).toHaveLength(1);
    expect(totals[0]!.inputTokens).toBe(3_000);
    expect(totals[0]!.outputTokens).toBe(300);
    expect(totals[0]!.cacheReadTokens).toBe(1_000);
    expect(totals[0]!.cacheCreationTokens).toBe(125);
    expect(totals[0]!.costUsd).toBeCloseTo(1.75, 8);
  });

  it("round-trips a counterfactual and assumption on a recommendation", async () => {
    const repo = createMemoryEventsRepo();
    await repo.upsertRecommendation({
      userId: "u1",
      ruleId: "frontier_trivial",
      severity: "info",
      title: "t",
      detail: "d",
      estimatedWastedTokens: 160,
      estimatedWastedUsd: 0.02,
      eventIds: ["e1"],
      dedupeKey: "e1",
      counterfactual: {
        model: "claude-sonnet-5",
        inputTokens: 120,
        outputTokens: 40,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      },
      assumption: "claude-sonnet-5 handles small requests as well",
    });
    const [row] = await repo.listRecommendations("u1", "open");
    expect(row!.counterfactual).toEqual({
      model: "claude-sonnet-5",
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
    expect(row!.assumption).toBe("claude-sonnet-5 handles small requests as well");
  });

  it("refreshes every rule-computed field on a second upsert with the same dedupe key, instead of keeping the first insert's stale values", async () => {
    // A re-fired rule must overwrite, not merely coexist with, the prior
    // card's evidence — this is the onConflictDoUpdate (Drizzle) /
    // update-in-place (in-memory) path Task 8 added specifically so a
    // dedupe-key collision refreshes rather than goes stale. Nothing else
    // in the suite reaches this branch: the other round-trip test upserts
    // once, and ingest.test.ts's dedupe test never re-runs rules for an
    // already-seen eventId.
    //
    // Every field below that the RULE computes differs between the two
    // upserts — model, both token counts, cacheReadTokens null->number (so
    // the null-vs-zero distinction is pinned across an UPDATE, not just an
    // INSERT), severity, title, detail, and eventIds — because a partial
    // `set` clause silently dropping any ONE of them reproduces the exact
    // "stale narrative beside fresh numbers" bug this task exists to
    // eliminate: e.g. frontier_share's `detail` interpolates a percentage
    // and a model name that must move in lockstep with estimatedWastedUsd
    // and counterfactual when the window it's computed over grows.
    // createdAt is captured from the FIRST upsert and asserted unchanged —
    // it's the one field a re-fire must never touch (see the dismissed-row
    // test below for the other: status).
    const repo = createMemoryEventsRepo();
    const base = {
      userId: "u1",
      ruleId: "frontier_trivial",
      dedupeKey: "e1",
    };

    await repo.upsertRecommendation({
      ...base,
      severity: "info",
      title: "Frontier model for trivial task",
      detail: "82% of your tokens went to the frontier tier, the largest being claude-opus-5",
      eventIds: ["e1"],
      estimatedWastedTokens: 160,
      estimatedWastedUsd: 0.02,
      counterfactual: {
        model: "claude-sonnet-5",
        inputTokens: 120,
        outputTokens: 40,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      },
      assumption: "claude-sonnet-5 handles small requests as well",
    });
    const [firstRow] = await repo.listRecommendations("u1", "open");
    const firstCreatedAt = firstRow!.createdAt;

    await repo.upsertRecommendation({
      ...base,
      severity: "high",
      title: "Frontier share is high",
      detail: "91% of your tokens went to the frontier tier, the largest being claude-opus-4",
      eventIds: ["e1", "e2", "e3"],
      estimatedWastedTokens: 999,
      estimatedWastedUsd: 0.09,
      counterfactual: {
        model: "claude-haiku-4-5",
        inputTokens: 300,
        outputTokens: 75,
        cacheReadTokens: 50,
        cacheCreationTokens: 10,
      },
      assumption: "claude-haiku-4-5 handles requests at this size just as well",
    });

    const rows = await repo.listRecommendations("u1", "open");
    // Still exactly one card for this dedupe key — a re-fire updates the
    // existing row, it does not insert a sibling.
    expect(rows).toHaveLength(1);
    const [row] = rows;

    expect(row!.severity).toBe("high");
    expect(row!.title).toBe("Frontier share is high");
    expect(row!.detail).toBe(
      "91% of your tokens went to the frontier tier, the largest being claude-opus-4",
    );
    expect(row!.eventIds).toEqual(["e1", "e2", "e3"]);
    expect(row!.counterfactual).toEqual({
      model: "claude-haiku-4-5",
      inputTokens: 300,
      outputTokens: 75,
      cacheReadTokens: 50,
      cacheCreationTokens: 10,
    });
    expect(row!.assumption).toBe(
      "claude-haiku-4-5 handles requests at this size just as well",
    );
    // The priced savings that go with the new counterfactual must refresh
    // too — a card showing fresh evidence next to the OLD dollar figure
    // would misrepresent what that evidence actually prices out to.
    expect(row!.estimatedWastedTokens).toBe(999);
    expect(Number(row!.estimatedWastedUsd)).toBeCloseTo(0.09, 8);
    // createdAt records when the finding FIRST appeared, not when it was
    // last recomputed — a re-fire must never touch it.
    expect(row!.createdAt).toEqual(firstCreatedAt);
  });

  it("leaves a dismissed recommendation dismissed when the same rule fires again with new evidence", async () => {
    // status is the other field a re-fire must never touch: it records the
    // USER's judgement (they dismissed this card), not anything the rule
    // computes. Silently flipping a dismissed card back to "open" because
    // the underlying rule fired again would overturn that judgement without
    // the user asking for it — a materially worse bug than stale evidence,
    // since it makes a dismissed recommendation reappear.
    const repo = createMemoryEventsRepo();
    const base = {
      userId: "u1",
      ruleId: "frontier_trivial",
      dedupeKey: "e1",
      severity: "info",
      title: "t",
      eventIds: ["e1"],
    };

    await repo.upsertRecommendation({
      ...base,
      detail: "first",
      estimatedWastedTokens: 160,
      estimatedWastedUsd: 0.02,
      counterfactual: {
        model: "claude-sonnet-5",
        inputTokens: 120,
        outputTokens: 40,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      },
      assumption: "first assumption",
    });
    const [inserted] = await repo.listRecommendations("u1", "open");
    const dismissed = await repo.dismissRecommendation("u1", inserted!.id);
    expect(dismissed).toBe(true);

    await repo.upsertRecommendation({
      ...base,
      detail: "second — rule fired again with fresh evidence",
      estimatedWastedTokens: 999,
      estimatedWastedUsd: 0.09,
      counterfactual: {
        model: "claude-haiku-4-5",
        inputTokens: 300,
        outputTokens: 75,
        cacheReadTokens: 50,
        cacheCreationTokens: 10,
      },
      assumption: "second assumption",
    });

    const openRows = await repo.listRecommendations("u1", "open");
    expect(openRows).toHaveLength(0);

    const allRows = await repo.listRecommendations("u1");
    expect(allRows).toHaveLength(1);
    const [row] = allRows;
    expect(row!.status).toBe("dismissed");
    // Evidence still refreshes underneath the dismissal — a user who
    // un-dismisses later should see the current numbers, not the stale
    // ones from when they first dismissed it.
    expect(row!.detail).toBe("second — rule fired again with fresh evidence");
    expect(row!.estimatedWastedTokens).toBe(999);
  });

  it("orders recommendations by savings, nulls last", async () => {
    // A $0.94 finding must never sit above a $23 one, and a finding whose
    // savings could not be priced (null) is not thereby a large one — it
    // sinks below every priced card regardless of token count.
    const repo = createMemoryEventsRepo();
    const base = {
      userId: "u1",
      severity: "warn",
      title: "t",
      detail: "d",
      estimatedWastedTokens: 1,
      eventIds: [],
      counterfactual: null,
      assumption: null,
    };
    await repo.upsertRecommendation({
      ...base, ruleId: "frontier_trivial", estimatedWastedUsd: 0.94, dedupeKey: "a",
    });
    await repo.upsertRecommendation({
      ...base, ruleId: "cache_efficiency", estimatedWastedUsd: 23.1, dedupeKey: "b",
    });
    await repo.upsertRecommendation({
      // A huge token count must not compensate for an unpriceable USD value
      // — null-USD findings sink to the bottom regardless.
      ...base,
      ruleId: "context_bloat",
      estimatedWastedUsd: null,
      estimatedWastedTokens: 999_999,
      dedupeKey: "c",
    });

    const rows = await repo.listRecommendations("u1", "open");
    expect(rows.map((r) => r.ruleId)).toEqual([
      "cache_efficiency",
      "frontier_trivial",
      "context_bloat",
    ]);
  });

  it("orders by savings numerically, not lexically — a $9.00 finding must not lexically outrank $23.00", async () => {
    // estimated_wasted_usd is a numeric column stored as a string. String
    // comparison of "9.00" vs "23.00" puts "9" above "23" character-by-
    // character; the fix must compare as numbers on both the Drizzle
    // (Postgres numeric column) and in-memory (Number(...) coercion) side.
    const repo = createMemoryEventsRepo();
    const base = {
      userId: "u1",
      severity: "warn",
      title: "t",
      detail: "d",
      estimatedWastedTokens: 1,
      eventIds: [],
      counterfactual: null,
      assumption: null,
    };
    await repo.upsertRecommendation({
      ...base, ruleId: "frontier_trivial", estimatedWastedUsd: 9.0, dedupeKey: "nine",
    });
    await repo.upsertRecommendation({
      ...base, ruleId: "cache_efficiency", estimatedWastedUsd: 23.0, dedupeKey: "twentythree",
    });

    const rows = await repo.listRecommendations("u1", "open");
    expect(rows.map((r) => r.ruleId)).toEqual([
      "cache_efficiency",
      "frontier_trivial",
    ]);
  });
});

describe("sessionRollups", () => {
  it("buckets each turn into the band its context size falls in", async () => {
    const repo = makeMemoryRepo();
    const base = {
      userId: "u1",
      model: "claude-opus-5",
      outputTokens: 1_000,
      sessionId: "sess-a",
    };
    // inputTokens IS the context size: cache tokens are folded into it.
    await insertEvent(repo, { ...base, inputTokens: 50_000, cacheReadTokens: 40_000, cacheCreationTokens: 1_000 });
    await insertEvent(repo, { ...base, inputTokens: 350_000, cacheReadTokens: 340_000, cacheCreationTokens: 2_000 });
    await insertEvent(repo, { ...base, inputTokens: 700_000, cacheReadTokens: 690_000, cacheCreationTokens: 3_000 });

    const [rollup] = await repo.sessionRollups("u1", SINCE, UNTIL);
    expect(rollup!.sessionId).toBe("sess-a");
    expect(rollup!.turnCount).toBe(3);
    // bands: 50k -> 0, 350k -> 3, 700k -> 5
    expect(rollup!.turnsByContextBand).toEqual([1, 0, 0, 1, 0, 1]);
    expect(rollup!.cacheReadByContextBand).toEqual([40_000, 0, 0, 340_000, 0, 690_000]);
    expect(rollup!.cacheReadTokens).toBe(1_070_000);
    expect(rollup!.cacheCreationTokens).toBe(6_000);
    expect(rollup!.inputTokens).toBe(1_100_000);
  });

  it("reports null cache totals when ANY turn in the session lacks a breakdown", async () => {
    // Summing a missing breakdown as 0 would turn "we don't know" into "we
    // checked and it's zero", which both session rules act on differently.
    const repo = makeMemoryRepo();
    await insertEvent(repo, { userId: "u1", sessionId: "sess-b", model: "claude-opus-5", inputTokens: 500_000, outputTokens: 1_000, cacheReadTokens: 490_000, cacheCreationTokens: 1_000 });
    await insertEvent(repo, { userId: "u1", sessionId: "sess-b", model: "claude-opus-5", inputTokens: 500_000, outputTokens: 1_000 });

    const [rollup] = await repo.sessionRollups("u1", SINCE, UNTIL);
    expect(rollup!.cacheReadTokens).toBeNull();
    expect(rollup!.cacheCreationTokens).toBeNull();
  });

  it("picks the dominant model by input tokens", async () => {
    const repo = makeMemoryRepo();
    await insertEvent(repo, { userId: "u1", sessionId: "sess-c", model: "claude-haiku-4-5", inputTokens: 100_000, outputTokens: 100, cacheReadTokens: 90_000, cacheCreationTokens: 100 });
    await insertEvent(repo, { userId: "u1", sessionId: "sess-c", model: "claude-opus-5", inputTokens: 900_000, outputTokens: 100, cacheReadTokens: 890_000, cacheCreationTokens: 100 });

    const [rollup] = await repo.sessionRollups("u1", SINCE, UNTIL);
    expect(rollup!.model).toBe("claude-opus-5");
    expect(rollup!.modelTier).toBe("frontier");
  });

  it("emits band arrays of exactly the published length", async () => {
    const repo = makeMemoryRepo();
    await insertEvent(repo, { userId: "u1", sessionId: "sess-d", model: "claude-opus-5", inputTokens: 10_000, outputTokens: 100, cacheReadTokens: 9_000, cacheCreationTokens: 100 });
    const [rollup] = await repo.sessionRollups("u1", SINCE, UNTIL);
    expect(rollup!.turnsByContextBand).toHaveLength(CONTEXT_BAND_EDGES.length);
    expect(rollup!.cacheReadByContextBand).toHaveLength(CONTEXT_BAND_EDGES.length);
  });

  it("excludes events with no sessionId", async () => {
    const repo = makeMemoryRepo();
    await insertEvent(repo, { userId: "u1", model: "claude-opus-5", inputTokens: 500_000, outputTokens: 100, cacheReadTokens: 490_000, cacheCreationTokens: 100 });
    expect(await repo.sessionRollups("u1", SINCE, UNTIL)).toEqual([]);
  });

  it("excludes aggregate-grain events, which have no single request inside them", async () => {
    const repo = makeMemoryRepo();
    await insertEvent(repo, { userId: "u1", sessionId: "sess-e", grain: "aggregate", model: "claude-opus-5", inputTokens: 5_000_000, outputTokens: 100, cacheReadTokens: 4_900_000, cacheCreationTokens: 100 });
    expect(await repo.sessionRollups("u1", SINCE, UNTIL)).toEqual([]);
  });
});

describe("sessionCoverage", () => {
  it("counts sessions and reports what no session claims", async () => {
    // Sidechain turns carry no sessionId by the adapter's design, so their
    // consumption belongs to no rollup. The panel must be able to say so
    // rather than presenting partial coverage as total.
    const repo = makeMemoryRepo();
    await insertEvent(repo, { userId: "u1", sessionId: "sess-f", model: "claude-opus-5", inputTokens: 100_000, outputTokens: 100, cacheReadTokens: 90_000, cacheCreationTokens: 100 });
    await insertEvent(repo, { userId: "u1", model: "claude-opus-5", inputTokens: 400_000, outputTokens: 100, cacheReadTokens: 390_000, cacheCreationTokens: 100 });
    await insertEvent(repo, { userId: "u1", model: "claude-opus-5", inputTokens: 600_000, outputTokens: 100, cacheReadTokens: 590_000, cacheCreationTokens: 100 });

    const coverage = await repo.sessionCoverage("u1", SINCE, UNTIL);
    expect(coverage.sessionsConsidered).toBe(1);
    expect(coverage.unattributedTurns).toBe(2);
    expect(coverage.unattributedInputTokens).toBe(1_000_000);
  });

  it("treats an empty-string sessionId as no session, so its tokens land in the unattributed figures instead of vanishing", async () => {
    // Fix round 1 regression: assembleSessionRollups already drops falsy
    // sessionIds (including ""), but the scope predicates admitted "" as
    // if it were a real session, and sessionCoverage counted it as a
    // "considered session" rather than unattributed. An event with
    // sessionId: "" therefore produced no rollup AND was not counted as
    // unattributed either — its tokens were in no rollup and no
    // unattributed figure, the exact blind spot sessionCoverage exists to
    // close. sessionId is optional with no .min(1) on ingest, so "" is a
    // reachable client input, not a hypothetical.
    const repo = makeMemoryRepo();
    await insertEvent(repo, { userId: "u1", sessionId: "sess-g", model: "claude-opus-5", inputTokens: 100_000, outputTokens: 100, cacheReadTokens: 90_000, cacheCreationTokens: 100 });
    await insertEvent(repo, { userId: "u1", sessionId: "", model: "claude-opus-5", inputTokens: 500_000, outputTokens: 100, cacheReadTokens: 490_000, cacheCreationTokens: 100 });

    // The empty-string turn must not produce a rollup of its own, and must
    // not silently merge into "sess-g" either.
    const rollups = await repo.sessionRollups("u1", SINCE, UNTIL);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]!.sessionId).toBe("sess-g");
    expect(rollups[0]!.inputTokens).toBe(100_000);

    // sessionsConsidered must be unaffected by the empty-string row — it is
    // not a second session — while its turn and tokens must show up as
    // unattributed, same as a row with no sessionId at all.
    const coverage = await repo.sessionCoverage("u1", SINCE, UNTIL);
    expect(coverage.sessionsConsidered).toBe(1);
    expect(coverage.unattributedTurns).toBe(1);
    expect(coverage.unattributedInputTokens).toBe(500_000);
  });
});
