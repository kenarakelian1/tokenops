import { describe, it, expect } from "vitest";
import type { UsageEvent } from "@tokenops/shared";
import {
  createMemoryEventsRepo,
  type EventsRepo,
} from "../services/events-repo.js";
import { runAggregateRulesForUser } from "./aggregate-rules.js";

function usageEvent(
  eventId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  timestamp: string,
): UsageEvent {
  return {
    eventId,
    timestamp,
    machineId: "machine-1",
    machineName: "ci-runner",
    app: "otel",
    provider: "anthropic",
    model,
    inputTokens,
    outputTokens,
    costUsd: null,
    grain: "aggregate",
    features: { modelTier: "unknown" },
    hasContent: false,
  };
}

/**
 * A window dominated by a frontier-tier model: one huge claude-opus-5[1m]
 * bucket plus a token-comparable haiku bucket, well over the 80% frontier
 * share threshold and well past the materiality floor.
 */
async function seedSkewedUsage(
  repo: EventsRepo,
  userId: string,
): Promise<void> {
  await repo.insertEventIfNew(
    userId,
    usageEvent(
      "evt-opus-1",
      "claude-opus-5[1m]",
      120_000_000,
      2_000_000,
      "2026-08-01T00:00:00.000Z",
    ),
  );
  await repo.insertEventIfNew(
    userId,
    usageEvent(
      "evt-haiku-1",
      "claude-haiku-4-5",
      28_000,
      800,
      "2026-08-01T00:00:00.000Z",
    ),
  );
}

describe("runAggregateRulesForUser", () => {
  it("emits one card per rule per window, not one per run", async () => {
    const repo = createMemoryEventsRepo();
    await seedSkewedUsage(repo, "user-a");
    await runAggregateRulesForUser(
      repo,
      "user-a",
      new Date("2026-08-05T12:00:00Z"),
    );
    await runAggregateRulesForUser(
      repo,
      "user-a",
      new Date("2026-08-05T13:00:00Z"),
    );
    const recs = await repo.listRecommendations("user-a", "open");
    expect(recs.filter((r) => r.ruleId === "frontier_share")).toHaveLength(1);
  });

  it("scopes the window to each user's own events", async () => {
    const repo = createMemoryEventsRepo();
    await seedSkewedUsage(repo, "user-a");
    // user-b has no events at all in the window.
    await runAggregateRulesForUser(
      repo,
      "user-b",
      new Date("2026-08-05T12:00:00Z"),
    );
    const recsB = await repo.listRecommendations("user-b", "open");
    expect(recsB).toHaveLength(0);
  });

  it("stays silent when nothing in the window clears the frontier or cache thresholds", async () => {
    const repo = createMemoryEventsRepo();
    await repo.insertEventIfNew(
      "user-c",
      usageEvent(
        "evt-small-1",
        "claude-haiku-4-5",
        1_000,
        100,
        "2026-08-01T00:00:00.000Z",
      ),
    );
    await runAggregateRulesForUser(
      repo,
      "user-c",
      new Date("2026-08-05T12:00:00Z"),
    );
    const recs = await repo.listRecommendations("user-c", "open");
    expect(recs).toHaveLength(0);
  });
});
