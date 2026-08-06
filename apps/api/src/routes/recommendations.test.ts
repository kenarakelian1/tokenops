import { beforeEach, describe, expect, it } from "vitest";
import type { UsageEvent } from "@tokenops/shared";
import { createApp } from "../app.js";
import { createFakeVerifier } from "../auth/clerk.js";
import { createMemoryAuthRepo } from "../auth/repo.js";
import { createMemoryEventsRepo } from "../services/events-repo.js";

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
