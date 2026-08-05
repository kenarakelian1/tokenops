import { describe, it, expect } from "vitest";
import type { UsageEvent } from "@tokenops/shared";
import { createMemoryEventsRepo } from "./events-repo.js";

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
});
