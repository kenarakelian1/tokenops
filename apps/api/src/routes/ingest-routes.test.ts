import { describe, it, expect } from "vitest";
import type { UsageEvent } from "@tokenops/shared";
import { createApp } from "../app.js";
import { createFakeVerifier } from "../auth/clerk.js";
import { createMemoryAuthRepo } from "../auth/repo.js";
import { createMemoryEventsRepo } from "../services/events-repo.js";
import { createPat } from "../auth/pat.js";

function sampleEvent(
  eventId: string,
  overrides: Partial<UsageEvent> = {},
): UsageEvent {
  return {
    eventId,
    timestamp: "2026-07-01T12:00:00.000Z",
    machineId: "m1",
    machineName: "desk",
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
    ...overrides,
  };
}

function frontierTrivial(eventId: string): UsageEvent {
  return sampleEvent(eventId, {
    model: "gpt-4o",
    inputTokens: 20,
    outputTokens: 10,
    costUsd: 0.01,
    features: {
      promptChars: 40,
      responseChars: 20,
      messageCount: 1,
      codeFenceCount: 0,
      largePasteScore: 0,
      fileDumpScore: 0,
      modelTier: "frontier",
    },
  });
}

async function setup(opts: { hostedLimits?: boolean } = {}) {
  const authRepo = createMemoryAuthRepo();
  const eventsRepo = createMemoryEventsRepo();
  const clerkVerifier = createFakeVerifier({
    "token-owner": { clerkUserId: "user_owner", email: "owner@example.com" },
  });
  const user = await authRepo.insertClerkUser(
    "owner@example.com",
    "user_owner",
  );
  const { token } = await createPat(authRepo, user.id, "agent");
  const app = createApp({
    db: null as never,
    authRepo,
    eventsRepo,
    clerkVerifier,
    hostedLimits: opts.hostedLimits ?? false,
  });
  return {
    app,
    authRepo,
    eventsRepo,
    userId: user.id,
    pat: token,
    userAuth: "Bearer token-owner",
  };
}

describe("POST /v1/events", () => {
  it("requires PAT", async () => {
    const { app } = await setup();
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [sampleEvent("e1")] }),
    });
    expect(res.status).toBe(401);
  });

  it("ingests batch and is idempotent", async () => {
    const { app, pat } = await setup();
    const body = JSON.stringify({ events: [sampleEvent("e1")] });
    const r1 = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${pat}`,
      },
      body,
    });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ accepted: 1, duplicates: 0 });

    const r2 = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${pat}`,
      },
      body,
    });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ accepted: 0, duplicates: 1 });
  });

  it("rejects invalid body", async () => {
    const { app, pat } = await setup();
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${pat}`,
      },
      body: JSON.stringify({ events: [{ bad: true }] }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 403 machine_limit when hosted and over cap", async () => {
    const { app, pat } = await setup({ hostedLimits: true });
    for (let i = 1; i <= 3; i++) {
      const res = await app.request("/v1/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${pat}`,
        },
        body: JSON.stringify({
          events: [
            sampleEvent(`e${i}`, {
              machineId: `m${i}`,
              machineName: `n${i}`,
            }),
          ],
        }),
      });
      expect(res.status).toBe(200);
    }
    const blocked = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${pat}`,
      },
      body: JSON.stringify({
        events: [
          sampleEvent("e4", { machineId: "m4", machineName: "n4" }),
        ],
      }),
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: "machine_limit" });
  });
});

describe("GET /v1/events + aggregates + recommendations", () => {
  it("lists events with dashboard auth", async () => {
    const { app, pat, userAuth } = await setup();
    await app.request("/v1/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${pat}`,
      },
      body: JSON.stringify({
        events: [
          sampleEvent("e1", { model: "gpt-4o-mini" }),
          frontierTrivial("ft1"),
        ],
      }),
    });

    const unauth = await app.request("/v1/events");
    expect(unauth.status).toBe(401);

    const list = await app.request("/v1/events?model=gpt-4o-mini", {
      headers: { Authorization: userAuth },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { events: { eventId: string }[] };
    expect(body.events).toHaveLength(1);
    expect(body.events[0].eventId).toBe("e1");

    const aggs = await app.request("/v1/aggregates?from=2026-07-01&to=2026-07-01", {
      headers: { Authorization: userAuth },
    });
    expect(aggs.status).toBe(200);
    const aggBody = (await aggs.json()) as {
      aggregates: { eventCount: number }[];
    };
    expect(aggBody.aggregates.length).toBeGreaterThanOrEqual(1);
    expect(
      aggBody.aggregates.reduce((s, a) => s + a.eventCount, 0),
    ).toBe(2);

    const recs = await app.request("/v1/recommendations?status=open", {
      headers: { Authorization: userAuth },
    });
    expect(recs.status).toBe(200);
    const recBody = (await recs.json()) as {
      recommendations: { id: string; ruleId: string }[];
    };
    expect(
      recBody.recommendations.some((r) => r.ruleId === "frontier_trivial"),
    ).toBe(true);

    const id = recBody.recommendations.find(
      (r) => r.ruleId === "frontier_trivial",
    )!.id;
    const dismiss = await app.request(`/v1/recommendations/${id}/dismiss`, {
      method: "POST",
      headers: { Authorization: userAuth },
    });
    expect(dismiss.status).toBe(200);

    const openAfter = await app.request("/v1/recommendations?status=open", {
      headers: { Authorization: userAuth },
    });
    const openBody = (await openAfter.json()) as {
      recommendations: unknown[];
    };
    expect(openBody.recommendations).toHaveLength(0);
  });
});

describe("POST /v1/heartbeats + GET /v1/machines", () => {
  it("records heartbeat and lists machines", async () => {
    const { app, pat, userAuth } = await setup();
    const hb = await app.request("/v1/heartbeats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${pat}`,
      },
      body: JSON.stringify({
        machineId: "mac-1",
        machineName: "laptop",
        queueDepth: 2,
      }),
    });
    expect(hb.status).toBe(200);

    const machines = await app.request("/v1/machines", {
      headers: { Authorization: userAuth },
    });
    expect(machines.status).toBe(200);
    const body = (await machines.json()) as {
      machines: { machineId: string; lastQueueDepth: number }[];
    };
    expect(body.machines).toEqual([
      expect.objectContaining({
        machineId: "mac-1",
        lastQueueDepth: 2,
      }),
    ]);
  });
});

describe("PUT /v1/settings", () => {
  it("updates budgetUsdMonthly", async () => {
    const { app, userAuth } = await setup();
    const res = await app.request("/v1/settings", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        Authorization: userAuth,
      },
      body: JSON.stringify({ budgetUsdMonthly: 50 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ budgetUsdMonthly: 50 });

    const me = await app.request("/v1/auth/me", {
      headers: { Authorization: userAuth },
    });
    expect(await me.json()).toMatchObject({ budgetUsdMonthly: "50" });
  });
});
