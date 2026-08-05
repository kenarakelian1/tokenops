import { describe, it, expect } from "vitest";
import type { UsageEvent } from "@tokenops/shared";
import {
  createMemoryEventsRepo,
  type EventsRepo,
} from "../services/events-repo.js";
import {
  aggregateWindowBounds,
  runAggregateRulesForUser,
} from "./aggregate-rules.js";

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
    const now1 = new Date("2026-08-05T12:00:00Z");
    await runAggregateRulesForUser(repo, "user-a", now1);
    await runAggregateRulesForUser(
      repo,
      "user-a",
      new Date("2026-08-05T13:00:00Z"),
    );
    const recs = await repo.listRecommendations("user-a", "open");
    const frontierRecs = recs.filter((r) => r.ruleId === "frontier_share");
    expect(frontierRecs).toHaveLength(1);
    // Assert the stored dedupeKey literal, not just the count — a key
    // derived from eventIds would also produce exactly one row here (both
    // runs share seedSkewedUsage's fixed event ids), for the wrong reason.
    // Aggregate hits carry eventIds: [], so only a window-derived key proves
    // the real mechanism.
    const { startIso } = aggregateWindowBounds(now1);
    expect(frontierRecs[0]!.dedupeKey).toBe(`frontier_share|${startIso}`);
  });

  it("supersedes an older window's card with the newer one instead of accumulating", async () => {
    // Regression for the "one card per day, forever" bug: superseding must
    // delete the prior day's still-open card when a new window's card is
    // upserted, so at most one live card per aggregate rule exists.
    const repo = createMemoryEventsRepo();
    await seedSkewedUsage(repo, "user-a");

    const day1 = new Date("2026-08-05T12:00:00Z");
    const day2 = new Date("2026-08-06T12:00:00Z");

    await runAggregateRulesForUser(repo, "user-a", day1);
    await runAggregateRulesForUser(repo, "user-a", day2);

    const recs = await repo.listRecommendations("user-a", "open");
    const frontierRecs = recs.filter((r) => r.ruleId === "frontier_share");

    // Without superseding, day1 and day2 each mint their own row — the
    // same pile-of-near-identical-cards problem this task exists to
    // eliminate, just at one per day instead of one per run.
    expect(frontierRecs).toHaveLength(1);

    const { startIso: day2Start } = aggregateWindowBounds(day2);
    expect(frontierRecs[0]!.dedupeKey).toBe(`frontier_share|${day2Start}`);
  });

  it("includes events from earlier today, not just full days before it", async () => {
    // Regression: a window that truncates its END to the start of today
    // excludes every event timestamped today, so an OTEL-only user (whose
    // recommendations come exclusively from these aggregate rules) sees an
    // empty panel for up to 24 hours after their first usage.
    const repo = createMemoryEventsRepo();
    const now = new Date("2026-08-05T12:00:00Z");
    await repo.insertEventIfNew(
      "user-d",
      usageEvent(
        "evt-opus-today",
        "claude-opus-5[1m]",
        120_000_000,
        2_000_000,
        "2026-08-05T09:00:00.000Z",
      ),
    );
    await repo.insertEventIfNew(
      "user-d",
      usageEvent(
        "evt-haiku-today",
        "claude-haiku-4-5",
        28_000,
        800,
        "2026-08-05T09:30:00.000Z",
      ),
    );

    const hitCount = await runAggregateRulesForUser(repo, "user-d", now);
    expect(hitCount).toBeGreaterThan(0);

    const recs = await repo.listRecommendations("user-d", "open");
    expect(recs.some((r) => r.ruleId === "frontier_share")).toBe(true);
  });

  it("retires an aggregate card once its rule stops firing", async () => {
    // Regression: supersedeOpenRecommendations was only ever called inside
    // `for (const hit of hits)`, so a run with zero hits for a rule never
    // called it for that rule — a card written while the rule fired stayed
    // open forever, even after the user's behavior changed and the rule
    // genuinely stopped firing.
    const repo = createMemoryEventsRepo();
    await seedSkewedUsage(repo, "user-a");

    const day1 = new Date("2026-08-05T12:00:00Z");
    await runAggregateRulesForUser(repo, "user-a", day1);

    let recs = await repo.listRecommendations("user-a", "open");
    expect(recs.some((r) => r.ruleId === "frontier_share")).toBe(true);

    // 8 days later: seedSkewedUsage's events (timestamped 2026-08-01) have
    // rolled out of the trailing 7-day window entirely, and no new events
    // were recorded, so the window is empty and frontier_share can no
    // longer fire.
    const day2 = new Date("2026-08-13T12:00:00Z");
    const hitCount = await runAggregateRulesForUser(repo, "user-a", day2);
    expect(hitCount).toBe(0);

    recs = await repo.listRecommendations("user-a", "open");
    expect(recs.some((r) => r.ruleId === "frontier_share")).toBe(false);
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
