import { beforeEach, describe, expect, it } from "vitest";
import type { UsageEvent } from "@tokenops/shared";
import { createApp } from "../app.js";
import { createFakeVerifier } from "../auth/clerk.js";
import { createMemoryAuthRepo } from "../auth/repo.js";
import { createMemoryEventsRepo } from "../services/events-repo.js";
import { EVENTS_PAGE_SIZE, fetchWindowEvents } from "./recommendations.js";

// Harness copied from tenant-isolation.test.ts: provision a user JIT via
// /v1/auth/me and learn their local id, since the routes below authorize on
// the local user id, not the Clerk id.
const verifier = createFakeVerifier({
  "token-a": { clerkUserId: "user_a", email: "a@example.com" },
});

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * claude-opus-4, 20 in / 180 out — total 200 tokens, right at
 * frontier_trivial's cap, frontier tier, single message, no large paste.
 * Same fixture shape as packages/shared/src/rules/backtest.test.ts's `ev`,
 * which documents why this specific shape clears both frontier_trivial's
 * conditions and the MIN_WASTED_USD/MIN_WASTED_TOKENS materiality floor.
 * `timestamp` defaults to "just now" so it always lands inside whatever
 * trailing window the test requests, regardless of which day this runs.
 */
function trivialFrontierEvent(
  over: Partial<UsageEvent> & Pick<UsageEvent, "eventId">,
): UsageEvent {
  return {
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    machineId: "machine-a",
    machineName: "alice-laptop",
    app: "claude-code",
    provider: "anthropic",
    model: "claude-opus-4",
    inputTokens: 20,
    outputTokens: 180,
    costUsd: null,
    hasContent: false,
    features: {
      promptChars: 40,
      responseChars: 20,
      messageCount: 1,
      codeFenceCount: 0,
      largePasteScore: 0,
      fileDumpScore: 0,
      modelTier: "frontier",
    },
    ...over,
  };
}

/**
 * Cheap, request-grain, small-tier event that trips none of the request
 * rules (promptChars/fileDumpScore stay far under full_document_io's
 * FULL_DOC_MIN_PROMPT_CHARS, no sessionId so context_bloat never sees
 * session context, and modelTier "small" makes frontier_trivial bail out on
 * its very first check). Used as inert filler so a pagination fixture's
 * event *count* can be tested independently of rule hits.
 */
function fillerEvent(eventId: string, timestamp: string): UsageEvent {
  return {
    timestamp,
    machineId: "machine-a",
    machineName: "alice-laptop",
    app: "claude-code",
    provider: "anthropic",
    model: "claude-haiku-4",
    inputTokens: 10,
    outputTokens: 10,
    costUsd: null,
    hasContent: false,
    features: {
      promptChars: 10,
      responseChars: 10,
      messageCount: 1,
      codeFenceCount: 0,
      largePasteScore: 0,
      fileDumpScore: 0,
      modelTier: "small",
    },
    eventId,
  };
}

/**
 * Seeds EVENTS_PAGE_SIZE - 2 inert filler events (unique timestamps, all
 * strictly newer than `clusterTs`) plus a 5-event cluster that all share the
 * exact same timestamp `clusterTs` and are each shaped to trip
 * frontier_trivial. Since `listEvents` returns newest-first, the first page
 * (EVENTS_PAGE_SIZE rows) is exactly "all filler" + "first 2 cluster rows",
 * and the cluster's remaining 3 rows land on page two — deterministically
 * straddling the page boundary regardless of how ties within the cluster
 * happen to sort. Total seeded: EVENTS_PAGE_SIZE + 3.
 */
async function seedPaginationBoundaryFixture(
  eventsRepo: ReturnType<typeof createMemoryEventsRepo>,
  userId: string,
): Promise<{ total: number; clusterSize: number }> {
  const clusterTs = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const fillerCount = EVENTS_PAGE_SIZE - 2;
  const clusterSize = 5;

  for (let i = 0; i < fillerCount; i++) {
    // Strictly newer than clusterTs (later in ms), unique per event, all
    // still well inside the 30d default window.
    const ts = new Date(
      Date.parse(clusterTs) + (i + 1) * 1000,
    ).toISOString();
    await eventsRepo.insertEventIfNew(
      userId,
      fillerEvent(`evt-filler-${i}`, ts),
    );
  }

  for (let i = 0; i < clusterSize; i++) {
    await eventsRepo.insertEventIfNew(
      userId,
      trivialFrontierEvent({ eventId: `evt-cluster-${i}`, timestamp: clusterTs }),
    );
  }

  return { total: fillerCount + clusterSize, clusterSize };
}

describe("GET /v1/recommendations/backtest", () => {
  let app: ReturnType<typeof createApp>;
  let eventsRepo: ReturnType<typeof createMemoryEventsRepo>;
  let userId: string;

  beforeEach(async () => {
    const authRepo = createMemoryAuthRepo();
    eventsRepo = createMemoryEventsRepo();
    app = createApp({
      db: undefined as never,
      authRepo,
      eventsRepo,
      clerkVerifier: verifier,
    });

    const me = await app.request("/v1/auth/me", { headers: bearer("token-a") });
    expect(me.status).toBe(200);
    userId = ((await me.json()) as { id: string }).id;
  });

  it("rejects an unknown window rather than silently falling back", async () => {
    const res = await app.request("/v1/recommendations/backtest?window=42d", {
      headers: bearer("token-a"),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_window" });
  });

  it("defaults to 30d and returns rule rows", async () => {
    const res = await app.request("/v1/recommendations/backtest", {
      headers: bearer("token-a"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      windowStart: string;
      windowEnd: string;
      rows: unknown[];
    };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(typeof body.windowStart).toBe("string");
    expect(typeof body.windowEnd).toBe("string");

    // 30d default should span the same range as an explicit ?window=30d.
    const explicit = await app.request(
      "/v1/recommendations/backtest?window=30d",
      { headers: bearer("token-a") },
    );
    expect(explicit.status).toBe(200);
  });

  it("returns rule rows for stored request-grain history", async () => {
    await eventsRepo.insertEventIfNew(
      userId,
      trivialFrontierEvent({ eventId: "evt-trivial-1" }),
    );

    const res = await app.request("/v1/recommendations/backtest", {
      headers: bearer("token-a"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: { ruleId: string; hits: number; wouldHaveSavedUsd: number }[];
    };
    const row = body.rows.find((r) => r.ruleId === "frontier_trivial");
    expect(row).toBeDefined();
    expect(row!.hits).toBe(1);
    expect(row!.wouldHaveSavedUsd).toBeGreaterThan(0);
  });

  it("does not evaluate request-grain rules against an aggregate-grain event", async () => {
    // Same shape that would trip frontier_trivial if evaluated as a request
    // — mirrors the 712 OTEL-derived aggregate rows in production whose
    // features are fabricated placeholders. grain: "aggregate" must keep
    // runRules' isAggregate gate from firing on it.
    await eventsRepo.insertEventIfNew(
      userId,
      trivialFrontierEvent({ eventId: "evt-agg-1", grain: "aggregate" }),
    );

    const res = await app.request("/v1/recommendations/backtest", {
      headers: bearer("token-a"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: { ruleId: string }[];
    };
    expect(body.rows.find((r) => r.ruleId === "frontier_trivial")).toBeUndefined();
  });

  it("requires auth", async () => {
    const res = await app.request("/v1/recommendations/backtest");
    expect(res.status).toBe(401);
  });

  it("scans the whole window, not just the first page, and reports the true count", async () => {
    // Regression for the finding that a bare `listEvents(userId, { from, to })`
    // silently returns only the newest page (repo default/clamp), which would
    // make a back-test over more than a page of history report on a fraction
    // of it while claiming completeness. This must fail against a
    // single-call implementation: EVENTS_PAGE_SIZE + 3 events are seeded,
    // one page's worth is not enough to see them all.
    const { total } = await seedPaginationBoundaryFixture(eventsRepo, userId);
    expect(total).toBeGreaterThan(EVENTS_PAGE_SIZE);

    const res = await app.request("/v1/recommendations/backtest", {
      headers: bearer("token-a"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      eventsScanned: number;
      truncated: boolean;
    };
    expect(body.eventsScanned).toBe(total);
    expect(body.truncated).toBe(false);
  });

  it("does not double-count events whose timestamp straddles a page boundary", async () => {
    // The 5-event cluster in the fixture all share one timestamp positioned
    // so 2 of them land on page one and 3 on page two of the pagination
    // walk (see seedPaginationBoundaryFixture). `to` is an inclusive bound,
    // so page two re-fetches the 2 already seen on page one — if dedupe by
    // eventId were missing or wrong, frontier_trivial's hit count would be
    // inflated (7) or, if events were dropped instead, undercounted.
    const { clusterSize } = await seedPaginationBoundaryFixture(
      eventsRepo,
      userId,
    );

    const res = await app.request("/v1/recommendations/backtest", {
      headers: bearer("token-a"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: { ruleId: string; hits: number }[];
    };
    const row = body.rows.find((r) => r.ruleId === "frontier_trivial");
    expect(row).toBeDefined();
    expect(row!.hits).toBe(clusterSize);
  });
});

describe("GET /v1/recommendations coverage", () => {
  it("reports session coverage alongside the cards", async () => {
    // The panel shows at most 10 sessions per rule and drops turns that
    // carry no sessionId at all (sidechain turns, by the adapter's design).
    // Without these numbers the panel would present a truncated view as
    // complete.
    const authRepo = createMemoryAuthRepo();
    const eventsRepo = createMemoryEventsRepo();
    const app = createApp({
      db: undefined as never,
      authRepo,
      eventsRepo,
      clerkVerifier: verifier,
    });
    const me = await app.request("/v1/auth/me", { headers: bearer("token-a") });
    const userId = ((await me.json()) as { id: string }).id;

    // One turn attributed to a session, one with no sessionId — both inside
    // the trailing session-rules window — so sessionsConsidered and the
    // unattributed figures both come out non-zero rather than trivially 0.
    await eventsRepo.insertEventIfNew(
      userId,
      trivialFrontierEvent({ eventId: "evt-sess-1", sessionId: "sess-a" }),
    );
    await eventsRepo.insertEventIfNew(
      userId,
      trivialFrontierEvent({ eventId: "evt-unattributed-1" }),
    );

    const res = await app.request("/v1/recommendations", {
      headers: bearer("token-a"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      coverage: {
        sessionsConsidered: number;
        sessionsShownPerRule: number;
        unattributedTurns: number;
        unattributedInputTokens: number;
      };
    };
    expect(body.coverage).toEqual({
      sessionsConsidered: 1,
      sessionsShownPerRule: 10,
      unattributedTurns: 1,
      unattributedInputTokens: 20,
    });
  });

  it("still returns 200 with recommendations when sessionCoverage rejects", async () => {
    // usage_events has no indexes beyond its primary key, so sessionCoverage
    // is two sequential scans — slow enough to fail or time out on its own.
    // A failure there must degrade to no coverage note, not sink the whole
    // panel: the web client already types `coverage` as optional for
    // exactly this reason.
    const authRepo = createMemoryAuthRepo();
    const eventsRepo = createMemoryEventsRepo();
    eventsRepo.sessionCoverage = async () => {
      throw new Error("simulated sessionCoverage failure");
    };
    const app = createApp({
      db: undefined as never,
      authRepo,
      eventsRepo,
      clerkVerifier: verifier,
    });
    const me = await app.request("/v1/auth/me", { headers: bearer("token-a") });
    const userId = ((await me.json()) as { id: string }).id;

    await eventsRepo.insertEventIfNew(
      userId,
      trivialFrontierEvent({ eventId: "evt-coverage-failure" }),
    );

    const res = await app.request("/v1/recommendations", {
      headers: bearer("token-a"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recommendations: unknown[];
      coverage?: unknown;
    };
    expect(Array.isArray(body.recommendations)).toBe(true);
    expect(body.coverage).toBeUndefined();
  });
});

describe("fetchWindowEvents ceiling", () => {
  // Exercises MAX_BACKTEST_EVENTS' truncation behavior directly against the
  // exported function with an injected pageSize/maxEvents, rather than
  // seeding tens of thousands of rows through the full HTTP route to reach
  // the real 20,000-event ceiling.
  let eventsRepo: ReturnType<typeof createMemoryEventsRepo>;
  const userId = "user-ceiling-test";
  const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const windowEnd = new Date().toISOString();

  beforeEach(() => {
    eventsRepo = createMemoryEventsRepo();
  });

  async function seed(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await eventsRepo.insertEventIfNew(
        userId,
        fillerEvent(
          `evt-${i}`,
          new Date(Date.parse(windowStart) + (i + 1) * 1000).toISOString(),
        ),
      );
    }
  }

  it("reports truncated: true once more events exist than the injected ceiling", async () => {
    await seed(6);
    const { rows, truncated } = await fetchWindowEvents(
      eventsRepo,
      userId,
      windowStart,
      windowEnd,
      { pageSize: 2, maxEvents: 4 },
    );
    expect(rows).toHaveLength(4);
    expect(truncated).toBe(true);
  });

  it("reports truncated: false when the true count lands exactly on the ceiling", async () => {
    // Guards the probe-fetch logic: hitting the cap exactly on a full page
    // must not be conflated with "there is more data beyond it".
    await seed(4);
    const { rows, truncated } = await fetchWindowEvents(
      eventsRepo,
      userId,
      windowStart,
      windowEnd,
      { pageSize: 2, maxEvents: 4 },
    );
    expect(rows).toHaveLength(4);
    expect(truncated).toBe(false);
  });
});

describe("recToDto evidence fields", () => {
  it("exposes counterfactual and assumption on listed recommendations", async () => {
    const authRepo = createMemoryAuthRepo();
    const eventsRepo = createMemoryEventsRepo();
    const app = createApp({
      db: undefined as never,
      authRepo,
      eventsRepo,
      clerkVerifier: verifier,
    });
    const me = await app.request("/v1/auth/me", { headers: bearer("token-a") });
    const userId = ((await me.json()) as { id: string }).id;

    await eventsRepo.upsertRecommendation({
      userId,
      ruleId: "frontier_trivial",
      severity: "info",
      title: "seed",
      detail: "seed",
      estimatedWastedTokens: 200,
      estimatedWastedUsd: 0.012,
      eventIds: ["evt-1"],
      dedupeKey: "evt-1",
      counterfactual: {
        model: "claude-sonnet-5",
        inputTokens: 20,
        outputTokens: 180,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      },
      assumption: "claude-sonnet-5 handles requests this small as well as claude-opus-4",
    });

    const res = await app.request("/v1/recommendations", {
      headers: bearer("token-a"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recommendations: {
        counterfactual: unknown;
        assumption: string | null;
      }[];
    };
    expect(body.recommendations).toHaveLength(1);
    expect(body.recommendations[0]!.counterfactual).toEqual({
      model: "claude-sonnet-5",
      inputTokens: 20,
      outputTokens: 180,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
    expect(body.recommendations[0]!.assumption).toBe(
      "claude-sonnet-5 handles requests this small as well as claude-opus-4",
    );
  });
});
