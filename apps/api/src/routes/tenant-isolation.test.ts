import { beforeEach, describe, expect, it } from "vitest";
import type { UsageEvent } from "@tokenops/shared";
import { createApp } from "../app.js";
import { createFakeVerifier } from "../auth/clerk.js";
import { createMemoryAuthRepo } from "../auth/repo.js";
import { createMemoryEventsRepo } from "../services/events-repo.js";

const verifier = createFakeVerifier({
  "token-a": { clerkUserId: "user_a", email: "a@example.com" },
  "token-b": { clerkUserId: "user_b", email: "b@example.com" },
});

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function sampleEvent(eventId: string): UsageEvent {
  return {
    eventId,
    timestamp: "2026-07-01T12:00:00.000Z",
    machineId: "machine-a",
    machineName: "alice-laptop",
    app: "openai-proxy",
    provider: "openai",
    model: "gpt-4o-mini",
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.001,
    features: {
      promptChars: 200,
      responseChars: 80,
      messageCount: 2,
      codeFenceCount: 0,
      largePasteScore: 0,
      fileDumpScore: 0,
      modelTier: "small",
    },
    hasContent: false,
  };
}

/**
 * `createMemoryEventsRepo` has no `insertRecommendations` (plural) method —
 * the actual API is `upsertRecommendation` (singular), taking a single
 * `RecommendationInsert` with `userId` embedded and `estimatedWastedUsd` as
 * `number | null` (not a numeric string). Read from `events-repo.ts` before
 * trusting a brief's sketch.
 */
async function seedRecommendationFor(
  repo: ReturnType<typeof createMemoryEventsRepo>,
  userId: string,
): Promise<string> {
  await repo.upsertRecommendation({
    userId,
    ruleId: "frontier_for_trivial",
    severity: "medium",
    title: "seed",
    detail: "seed",
    estimatedWastedTokens: 1,
    estimatedWastedUsd: 0,
    eventIds: ["evt-1"],
    dedupeKey: "evt-1",
    counterfactual: null,
    assumption: null,
  });
  const [rec] = await repo.listRecommendations(userId, "open");
  return rec!.id;
}

describe("tenant isolation", () => {
  let app: ReturnType<typeof createApp>;
  let eventsRepo: ReturnType<typeof createMemoryEventsRepo>;
  let userA: string;
  let userB: string;

  beforeEach(async () => {
    const authRepo = createMemoryAuthRepo();
    eventsRepo = createMemoryEventsRepo();
    app = createApp({
      db: undefined as never,
      authRepo,
      eventsRepo,
      clerkVerifier: verifier,
    });

    // Provision both users JIT via /v1/auth/me, and learn their local ids —
    // the routes below authorize on the local user id, not the Clerk id.
    const meA = await app.request("/v1/auth/me", { headers: bearer("token-a") });
    expect(meA.status).toBe(200);
    userA = ((await meA.json()) as { id: string }).id;

    const meB = await app.request("/v1/auth/me", { headers: bearer("token-b") });
    expect(meB.status).toBe(200);
    userB = ((await meB.json()) as { id: string }).id;

    await eventsRepo.upsertMachine(userA, "machine-a", "alice-laptop", 0);
  });

  it("shows a user only their own machines", async () => {
    // GET /v1/machines returns { machines: [...] }, not a bare array.
    const own = await app.request("/v1/machines", { headers: bearer("token-a") });
    expect(own.status).toBe(200);
    const ownBody = (await own.json()) as {
      machines: { machineId: string }[];
    };
    expect(ownBody.machines.map((m) => m.machineId)).toEqual(["machine-a"]);

    const other = await app.request("/v1/machines", { headers: bearer("token-b") });
    expect(other.status).toBe(200);
    const otherBody = (await other.json()) as { machines: unknown[] };
    expect(otherBody.machines).toEqual([]);
  });

  it("shows a user only their own events", async () => {
    await eventsRepo.insertEventIfNew(userA, sampleEvent("evt-a-1"));

    // GET /v1/events returns { events: [...] }, not a bare array.
    const own = await app.request("/v1/events", { headers: bearer("token-a") });
    expect(own.status).toBe(200);
    const ownBody = (await own.json()) as { events: { eventId: string }[] };
    expect(ownBody.events.map((e) => e.eventId)).toEqual(["evt-a-1"]);

    const other = await app.request("/v1/events", { headers: bearer("token-b") });
    expect(other.status).toBe(200);
    const otherBody = (await other.json()) as { events: unknown[] };
    expect(otherBody.events).toEqual([]);
  });

  it("shows a user only their own aggregates", async () => {
    await eventsRepo.bumpDailyAggregate(
      userA,
      "2026-07-01",
      "machine-a",
      "openai-proxy",
      "gpt-4o-mini",
      100,
      50,
      0.001,
    );

    // GET /v1/aggregates returns { aggregates: [...] }, not a bare array.
    const own = await app.request("/v1/aggregates", { headers: bearer("token-a") });
    expect(own.status).toBe(200);
    const ownBody = (await own.json()) as { aggregates: { day: string }[] };
    expect(ownBody.aggregates.map((a) => a.day)).toEqual(["2026-07-01"]);

    const other = await app.request("/v1/aggregates", { headers: bearer("token-b") });
    expect(other.status).toBe(200);
    const otherBody = (await other.json()) as { aggregates: unknown[] };
    expect(otherBody.aggregates).toEqual([]);
  });

  it("shows a user only their own recommendations", async () => {
    const recId = await seedRecommendationFor(eventsRepo, userA);

    // GET /v1/recommendations returns { recommendations: [...] }, not a
    // bare array.
    const own = await app.request("/v1/recommendations", {
      headers: bearer("token-a"),
    });
    expect(own.status).toBe(200);
    const ownBody = (await own.json()) as {
      recommendations: { id: string }[];
    };
    expect(ownBody.recommendations.map((r) => r.id)).toEqual([recId]);

    const other = await app.request("/v1/recommendations", {
      headers: bearer("token-b"),
    });
    expect(other.status).toBe(200);
    const otherBody = (await other.json()) as { recommendations: unknown[] };
    expect(otherBody.recommendations).toEqual([]);
  });

  it("does not let one user dismiss another user's recommendation", async () => {
    // dismissRecommendation is scoped by userId; prove it, because a write
    // that ignores the owner is worse than a read that does.
    const recId = await seedRecommendationFor(eventsRepo, userA);

    const res = await app.request(`/v1/recommendations/${recId}/dismiss`, {
      method: "POST",
      headers: bearer("token-b"),
    });
    expect([403, 404]).toContain(res.status);

    const still = await eventsRepo.listRecommendations(userA, "open");
    expect(still.map((r) => r.id)).toContain(recId);

    // Positive case: the owner can dismiss their own recommendation.
    const ownRes = await app.request(`/v1/recommendations/${recId}/dismiss`, {
      method: "POST",
      headers: bearer("token-a"),
    });
    expect(ownRes.status).toBe(200);
    expect(await ownRes.json()).toEqual({ ok: true });

    const afterOwnDismiss = await eventsRepo.listRecommendations(userA, "open");
    expect(afterOwnDismiss.map((r) => r.id)).not.toContain(recId);
  });
});
