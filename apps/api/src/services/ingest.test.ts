import { describe, it, expect } from "vitest";
import type { UsageEvent } from "@tokenops/shared";
import { createMemoryEventsRepo } from "./events-repo.js";
import { ingest, MachineLimitError, recordHeartbeat } from "./ingest.js";

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

function frontierTrivialFixture(eventId = "ft-1"): UsageEvent {
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

describe("ingest", () => {
  it("counts duplicates on second ingest", async () => {
    const repo = createMemoryEventsRepo();
    const userId = "user-1";
    const batch = { events: [sampleEvent("e1")] };

    const r1 = await ingest(repo, userId, batch);
    const r2 = await ingest(repo, userId, batch);

    expect(r1.accepted).toBe(1);
    expect(r1.duplicates).toBe(0);
    expect(r2.accepted).toBe(0);
    expect(r2.duplicates).toBe(1);
    expect(await repo.countEvents(userId)).toBe(1);
  });

  it("does not double-count aggregates on duplicate", async () => {
    const repo = createMemoryEventsRepo();
    const userId = "user-1";
    const batch = { events: [sampleEvent("e1")] };
    await ingest(repo, userId, batch);
    await ingest(repo, userId, batch);
    const aggs = await repo.listAggregates(userId, {});
    expect(aggs).toHaveLength(1);
    expect(aggs[0].eventCount).toBe(1);
    expect(aggs[0].inputTokens).toBe(100);
  });

  it("creates frontier_trivial recommendation", async () => {
    const repo = createMemoryEventsRepo();
    const userId = "user-1";
    await ingest(repo, userId, { events: [frontierTrivialFixture()] });
    const recs = await repo.listRecommendations(userId);
    expect(recs.some((r) => r.ruleId === "frontier_trivial")).toBe(true);
  });

  it("dedupes recommendations by user+rule+eventId", async () => {
    const repo = createMemoryEventsRepo();
    const userId = "user-1";
    const batch = { events: [frontierTrivialFixture("same")] };
    await ingest(repo, userId, batch);
    // Force re-run rules path would skip on duplicate event; insert new id same rule
    await ingest(repo, userId, {
      events: [frontierTrivialFixture("same")],
    });
    const recs = await repo.listRecommendations(userId);
    expect(recs.filter((r) => r.ruleId === "frontier_trivial")).toHaveLength(1);
  });

  it("stores content with hasContent", async () => {
    const repo = createMemoryEventsRepo();
    const userId = "user-1";
    await ingest(repo, userId, {
      events: [
        sampleEvent("c1", {
          hasContent: true,
          content: { requestBody: { messages: [] }, responseBody: { ok: 1 } },
        }),
      ],
    });
    const events = await repo.listEvents(userId, {});
    expect(events[0].hasContent).toBe(true);
  });

  it("upserts machine last_seen on ingest", async () => {
    const repo = createMemoryEventsRepo();
    const userId = "user-1";
    await ingest(repo, userId, {
      events: [sampleEvent("e1", { machineId: "mac-a", machineName: "A" })],
    });
    const machines = await repo.listMachines(userId);
    expect(machines).toHaveLength(1);
    expect(machines[0].machineId).toBe("mac-a");
    expect(machines[0].name).toBe("A");
  });

  it("fires context_bloat from session history without injected newContentRatio", async () => {
    // Live capture never sets newContentRatio; API must derive it from prior
    // promptChars and pass chronological session context to the rule.
    const repo = createMemoryEventsRepo();
    const userId = "user-1";
    const sessionId = "sess-bloat";

    const baseFeatures = {
      responseChars: 50,
      messageCount: 4,
      codeFenceCount: 0,
      largePasteScore: 0,
      fileDumpScore: 0,
      modelTier: "small" as const,
      // deliberately omit newContentRatio
    };

    await ingest(repo, userId, {
      events: [
        sampleEvent("b1", {
          sessionId,
          timestamp: "2026-07-01T12:00:00.000Z",
          inputTokens: 1000,
          outputTokens: 50,
          costUsd: 0.002,
          features: { ...baseFeatures, promptChars: 10_000 },
        }),
        sampleEvent("b2", {
          sessionId,
          timestamp: "2026-07-01T12:01:00.000Z",
          inputTokens: 1200,
          outputTokens: 50,
          costUsd: 0.002,
          features: { ...baseFeatures, promptChars: 11_000 },
        }),
        sampleEvent("b3", {
          sessionId,
          timestamp: "2026-07-01T12:02:00.000Z",
          inputTokens: 2000,
          outputTokens: 50,
          costUsd: 0.004,
          features: { ...baseFeatures, promptChars: 12_000 },
        }),
      ],
    });

    const recs = await repo.listRecommendations(userId);
    expect(recs.some((r) => r.ruleId === "context_bloat")).toBe(true);
    const bloat = recs.find((r) => r.ruleId === "context_bloat")!;
    // Waste vs early-session baseline (b1), not the newest prior (b2).
    expect(bloat.estimatedWastedTokens).toBe(1000);
  });

  it("rejects new machine when HOSTED_LIMITS and already at 3", async () => {
    const repo = createMemoryEventsRepo();
    const userId = "user-1";
    for (let i = 1; i <= 3; i++) {
      await ingest(
        repo,
        userId,
        {
          events: [
            sampleEvent(`e${i}`, {
              machineId: `m${i}`,
              machineName: `Machine ${i}`,
            }),
          ],
        },
        { hostedLimits: true },
      );
    }
    await expect(
      ingest(
        repo,
        userId,
        {
          events: [
            sampleEvent("e4", { machineId: "m4", machineName: "Machine 4" }),
          ],
        },
        { hostedLimits: true },
      ),
    ).rejects.toBeInstanceOf(MachineLimitError);

    // Existing machine still allowed
    const r = await ingest(
      repo,
      userId,
      {
        events: [
          sampleEvent("e5", { machineId: "m1", machineName: "Machine 1" }),
        ],
      },
      { hostedLimits: true },
    );
    expect(r.accepted).toBe(1);
  });
});

describe("recordHeartbeat", () => {
  it("upserts machine queue depth", async () => {
    const repo = createMemoryEventsRepo();
    await recordHeartbeat(repo, "u1", {
      machineId: "m1",
      machineName: "desk",
      queueDepth: 3,
    });
    const machines = await repo.listMachines("u1");
    expect(machines[0].lastQueueDepth).toBe(3);
  });

  it("enforces machine limit", async () => {
    const repo = createMemoryEventsRepo();
    for (let i = 1; i <= 3; i++) {
      await recordHeartbeat(
        repo,
        "u1",
        { machineId: `m${i}`, machineName: `n${i}`, queueDepth: 0 },
        { hostedLimits: true },
      );
    }
    await expect(
      recordHeartbeat(
        repo,
        "u1",
        { machineId: "m4", machineName: "n4", queueDepth: 0 },
        { hostedLimits: true },
      ),
    ).rejects.toBeInstanceOf(MachineLimitError);
  });
});
