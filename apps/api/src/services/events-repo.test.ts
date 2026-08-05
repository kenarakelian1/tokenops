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
});
