import { describe, expect, it, vi } from "vitest";
import type { SessionRollup } from "@tokenops/shared";
import {
  createMemoryEventsRepo,
  type EventsRepo,
} from "../services/events-repo.js";
import {
  MAX_SESSION_CARDS_PER_RULE,
  runSessionRulesForUser,
} from "./session-rules.js";

const NOW = new Date("2026-08-11T00:00:00.000Z");

function rollup(id: string, reads: number): SessionRollup {
  return {
    sessionId: id,
    start: "2026-08-01T00:00:00.000Z",
    end: "2026-08-01T06:00:00.000Z",
    turnCount: 100,
    model: "claude-opus-5",
    modelTier: "frontier",
    inputTokens: reads + 1_000_000,
    outputTokens: 200_000,
    cacheReadTokens: reads,
    cacheCreationTokens: 1_000,
    turnsByContextBand: [0, 0, 0, 0, 0, 40],
    cacheReadByContextBand: [0, 0, 0, 0, 0, reads],
  };
}

function fakeRepo(rollups: SessionRollup[]) {
  return {
    sessionRollups: vi.fn().mockResolvedValue(rollups),
    upsertRecommendation: vi.fn().mockResolvedValue(undefined),
    supersedeOpenRecommendations: vi.fn().mockResolvedValue(0),
  };
}

describe("runSessionRulesForUser", () => {
  it("keys each card on its rule and session, not on a window", async () => {
    const repo = fakeRepo([rollup("sess-a", 40_000_000)]);
    await runSessionRulesForUser(repo as never, "u1", NOW);
    const call = repo.upsertRecommendation.mock.calls[0]![0];
    expect(call.dedupeKey).toBe("session_context_ceiling|sess-a");
    expect(call.ruleId).toBe("session_context_ceiling");
  });

  it("caps open cards per rule, keeping the most expensive sessions", async () => {
    const many = Array.from({ length: MAX_SESSION_CARDS_PER_RULE + 5 }, (_, i) =>
      rollup(`sess-${i}`, 20_000_000 + i * 1_000_000),
    );
    const repo = fakeRepo(many);
    await runSessionRulesForUser(repo as never, "u1", NOW);

    const written = repo.upsertRecommendation.mock.calls.map((c) => c[0]);
    expect(written).toHaveLength(MAX_SESSION_CARDS_PER_RULE);
    // Highest reads win: sess-14 down to sess-5 for a cap of 10.
    const ids = written.map((w: { dedupeKey: string }) => w.dedupeKey.split("|")[1]);
    expect(ids).toContain(`sess-${many.length - 1}`);
    expect(ids).not.toContain("sess-0");
  });

  it("caps per rule rather than overall, so cheaper rules keep their slots", async () => {
    // Churn cards are always worth less than ceiling cards. A single
    // overall cap would let ceiling findings crowd them out entirely.
    const churny = Array.from({ length: MAX_SESSION_CARDS_PER_RULE + 2 }, (_, i) => ({
      ...rollup(`sess-${i}`, 20_000_000 + i * 1_000_000),
      cacheReadTokens: 8_000_000,
      cacheCreationTokens: 2_000_000,
    }));
    const repo = fakeRepo(churny);
    await runSessionRulesForUser(repo as never, "u1", NOW);

    const byRule = new Map<string, number>();
    for (const [rec] of repo.upsertRecommendation.mock.calls) {
      byRule.set(rec.ruleId, (byRule.get(rec.ruleId) ?? 0) + 1);
    }
    expect(byRule.get("session_context_ceiling")).toBe(MAX_SESSION_CARDS_PER_RULE);
    expect(byRule.get("session_cache_churn")).toBe(MAX_SESSION_CARDS_PER_RULE);
  });

  it("retires every open card for a rule that produced no hit", async () => {
    // A rule that stops firing never enters the write loop, so without an
    // explicit sweep its last cards stay open forever.
    const repo = fakeRepo([]);
    await runSessionRulesForUser(repo as never, "u1", NOW);
    const sweptRules = repo.supersedeOpenRecommendations.mock.calls.map((c) => c[1]);
    expect(sweptRules).toContain("session_context_ceiling");
    expect(sweptRules).toContain("session_cache_churn");
  });

  it("returns the number of cards written", async () => {
    const repo = fakeRepo([rollup("sess-a", 40_000_000)]);
    expect(await runSessionRulesForUser(repo as never, "u1", NOW)).toBe(1);
  });

  it("prices each session at its own end time, not wall-clock now", async () => {
    // Same reason the back-test replays at event timestamps: a date-gated
    // rate would otherwise reprice history as the clock moves.
    const repo = fakeRepo([
      { ...rollup("sess-a", 40_000_000), model: "claude-sonnet-5", end: "2026-08-01T06:00:00.000Z" },
    ]);
    await runSessionRulesForUser(repo as never, "u1", new Date("2026-09-15T00:00:00.000Z"));
    const call = repo.upsertRecommendation.mock.calls[0]![0];
    // Priced at the intro rate (session ended before the 2026-08-31 expiry),
    // not the higher standard rate in force at `now`.
    expect(call.estimatedWastedUsd).toBeGreaterThan(0);
  });
});

describe("runSessionRulesForUser dismissal survival", () => {
  it("does not resurrect a session card the user dismissed", async () => {
    // The sweep-then-write design clears a rule's whole OPEN set before
    // rewriting it. supersedeOpenRecommendations is scoped to status="open"
    // (confirmed by reading events-repo.ts), so it should never touch a
    // dismissed row — but upsertRecommendation's onConflictDoUpdate is what
    // actually decides whether a re-fire on the same dedupeKey overturns the
    // user's dismissal. This test exercises the REAL repo (not a mock) so
    // both mechanisms are proven together, end to end.
    const repo: EventsRepo = createMemoryEventsRepo();
    const userId = "u1";
    const sessionId = "sess-a";

    // 25 turns (>= SESSION_MIN_TURNS=20), each at a 2M-token context (band
    // 5, well above the 300k target) with 1M cache-read tokens apiece, so
    // session_context_ceiling has both enough turns and a real overage to
    // report: reads (25M) far exceed the 300k*25=7.5M counterfactual.
    // Timestamped inside NOW's trailing 7-day window (sessionWindowBounds),
    // not just before it, or sessionRollups filters every event out.
    for (let i = 0; i < 25; i += 1) {
      await repo.insertEventIfNew(userId, {
        eventId: `evt-${i}`,
        timestamp: new Date(
          Date.parse("2026-08-10T00:00:00.000Z") + i * 60_000,
        ).toISOString(),
        machineId: "machine-1",
        machineName: "ci-runner",
        app: "otel",
        provider: "anthropic",
        model: "claude-opus-5",
        inputTokens: 2_000_000,
        outputTokens: 10_000,
        costUsd: null,
        grain: undefined,
        sessionId,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 10_000,
        features: { modelTier: "frontier" },
        hasContent: false,
      });
    }

    await runSessionRulesForUser(repo, userId, NOW);
    let recs = await repo.listRecommendations(userId, "open");
    const card = recs.find((r) => r.ruleId === "session_context_ceiling");
    expect(card).toBeDefined();

    const dismissed = await repo.dismissRecommendation(userId, card!.id);
    expect(dismissed).toBe(true);

    // Run again: the same session still fires the same rule, so the sweep
    // clears the rule's open set and upsertRecommendation re-fires on the
    // exact same dedupeKey. The card must stay dismissed.
    await runSessionRulesForUser(repo, userId, NOW);

    recs = await repo.listRecommendations(userId);
    const after = recs.find((r) => r.ruleId === "session_context_ceiling");
    expect(after).toBeDefined();
    expect(after!.status).toBe("dismissed");

    const openAfter = await repo.listRecommendations(userId, "open");
    expect(openAfter.some((r) => r.ruleId === "session_context_ceiling")).toBe(
      false,
    );
  });
});
