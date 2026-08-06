import { describe, it, expect } from "vitest";
import { backtest } from "./backtest.js";
import type { UsageEvent } from "../schema/event.js";
import type { AggregateWindow } from "./aggregate/index.js";

// claude-opus-4 ($15/$75 per MTok) at 20 in / 180 out — total 200 tokens,
// right at frontier_trivial's cap. claude-opus-5 ($5/$25) can't clear
// MIN_WASTED_USD ($0.01) within that cap even swapped to claude-sonnet-5's
// intro rate ($2/$10): 180in/20out costs $0.0014 actual vs $0.00056
// counterfactual, an $0.00084 saving. claude-opus-4 at 20in/180out costs
// $0.0138 actual vs $0.00184 counterfactual (intro rate) — an $0.01196
// saving, which clears the floor with margin.
const ev = (over: Partial<UsageEvent> & Pick<UsageEvent, "eventId">): UsageEvent => ({
  timestamp: "2026-08-15T00:00:00.000Z",
  machineId: "m",
  machineName: "n",
  app: "openai-proxy",
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
});

const emptyWindow: AggregateWindow[] = [];

describe("backtest", () => {
  it("rolls hits up per rule", () => {
    const res = backtest({
      events: [ev({ eventId: "a" }), ev({ eventId: "b" })],
      windows: emptyWindow,
      windowStart: "2026-08-01T00:00:00.000Z",
      windowEnd: "2026-08-31T00:00:00.000Z",
    });
    const row = res.rows.find((r) => r.ruleId === "frontier_trivial");
    expect(row).toBeDefined();
    expect(row!.hits).toBe(2);
    expect(row!.wouldHaveSavedUsd).toBeGreaterThan(0);
    expect(row!.assumption).toMatch(/claude-sonnet-5/);
  });

  it("orders rows by savings, highest first", () => {
    const res = backtest({
      events: [ev({ eventId: "a" })],
      windows: [
        {
          start: "2026-08-01T00:00:00.000Z",
          end: "2026-08-08T00:00:00.000Z",
          byModel: [
            {
              model: "claude-opus-5",
              modelTier: "frontier",
              inputTokens: 10_000_000,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              costUsd: null,
            },
          ],
        },
      ],
      windowStart: "2026-08-01T00:00:00.000Z",
      windowEnd: "2026-08-31T00:00:00.000Z",
    });
    const saved = res.rows.map((r) => r.wouldHaveSavedUsd);
    expect(saved).toEqual([...saved].sort((a, b) => b - a));
  });

  it("prices each event at its own timestamp, not wall-clock now", () => {
    // Sonnet 5's intro rate ($2/MTok) expires 2026-08-31. An August event
    // must price at the intro rate no matter when the back-test runs, or the
    // same historical window would report different savings on different days.
    const august = ev({ eventId: "aug", timestamp: "2026-08-15T00:00:00.000Z" });
    const september = ev({ eventId: "sep", timestamp: "2026-09-15T00:00:00.000Z" });
    const run = (events: UsageEvent[]) =>
      backtest({
        events,
        windows: emptyWindow,
        windowStart: "2026-08-01T00:00:00.000Z",
        windowEnd: "2026-09-30T00:00:00.000Z",
      }).rows.find((r) => r.ruleId === "frontier_trivial")!.wouldHaveSavedUsd;

    // opus-4 in $15/$75 vs sonnet-5: intro $2/$10 (saves more) / standard
    // $3/$15 (saves less)
    expect(run([august])).toBeGreaterThan(run([september]));
  });

  it("is deterministic — same input, same output", () => {
    const input = {
      events: [ev({ eventId: "a" }), ev({ eventId: "b" })],
      windows: emptyWindow,
      windowStart: "2026-08-01T00:00:00.000Z",
      windowEnd: "2026-08-31T00:00:00.000Z",
    };
    expect(backtest(input)).toEqual(backtest(input));
  });

  it("never evaluates request rules against aggregate events", () => {
    const res = backtest({
      events: [ev({ eventId: "agg", grain: "aggregate" })],
      windows: emptyWindow,
      windowStart: "2026-08-01T00:00:00.000Z",
      windowEnd: "2026-08-31T00:00:00.000Z",
    });
    expect(res.rows).toEqual([]);
  });

  // Both tests below share this window: a single frontier model (100% of
  // window tokens, clearing FRONTIER_SHARE_THRESHOLD) whose dominant
  // contributor is claude-opus-5, so frontier_share's counterfactual prices
  // claude-sonnet-5. Priced at the window's own end (2026-08-08, Sonnet 5
  // intro rate $2/$10 active): actual (opus-5 $5/MTok, 10M in / 0 out) =
  // $50; counterfactual (sonnet-5 intro) = $20; saving = $30. Overriding
  // claude-sonnet-5 to $0.5/$2.5 per MTok drops the counterfactual to $5,
  // raising the saving to $45 — an explicit override beats the date-gated
  // intro rate, per estimateCostUsd's documented precedence.
  const frontierShareWindow: AggregateWindow = {
    start: "2026-08-01T00:00:00.000Z",
    end: "2026-08-08T00:00:00.000Z",
    byModel: [
      {
        model: "claude-opus-5",
        modelTier: "frontier",
        inputTokens: 10_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: null,
      },
    ],
  };
  const cheapOverride = {
    "claude-sonnet-5": { inputPerMTok: 0.5, outputPerMTok: 2.5 },
  };

  it("honours priceOverrides for an aggregate-grain rule (frontier_share)", () => {
    const base = {
      events: [] as UsageEvent[],
      windows: [frontierShareWindow],
      windowStart: "2026-08-01T00:00:00.000Z",
      windowEnd: "2026-08-31T00:00:00.000Z",
    };

    const defaultRow = backtest(base).rows.find(
      (r) => r.ruleId === "frontier_share",
    );
    const overriddenRow = backtest({
      ...base,
      priceOverrides: cheapOverride,
    }).rows.find((r) => r.ruleId === "frontier_share");

    expect(defaultRow).toBeDefined();
    expect(overriddenRow).toBeDefined();
    expect(defaultRow!.wouldHaveSavedUsd).toBeCloseTo(30, 5);
    expect(overriddenRow!.wouldHaveSavedUsd).toBeCloseTo(45, 5);
  });

  it("honours priceOverrides for a request-grain rule in the same run as an aggregate-grain rule", () => {
    // Default fixture (claude-opus-4, 20 in / 180 out, priced at its own
    // 2026-08-15 timestamp — intro rate active): actual $0.0138,
    // counterfactual (sonnet-5 intro) $0.00184, saving $0.01196. With
    // cheapOverride the counterfactual drops to $0.00046, raising the
    // saving to $0.01334.
    const base = {
      events: [ev({ eventId: "a" })],
      windows: [frontierShareWindow],
      windowStart: "2026-08-01T00:00:00.000Z",
      windowEnd: "2026-08-31T00:00:00.000Z",
    };

    const defaultRun = backtest(base);
    const overriddenRun = backtest({ ...base, priceOverrides: cheapOverride });

    const defaultTrivial = defaultRun.rows.find(
      (r) => r.ruleId === "frontier_trivial",
    );
    const overriddenTrivial = overriddenRun.rows.find(
      (r) => r.ruleId === "frontier_trivial",
    );
    expect(defaultTrivial!.wouldHaveSavedUsd).toBeCloseTo(0.01196, 5);
    expect(overriddenTrivial!.wouldHaveSavedUsd).toBeCloseTo(0.01334, 5);

    // Same run also carries the aggregate-grain rule — pins that both grains
    // honour the same override table in a single backtest() call.
    const defaultShare = defaultRun.rows.find(
      (r) => r.ruleId === "frontier_share",
    );
    const overriddenShare = overriddenRun.rows.find(
      (r) => r.ruleId === "frontier_share",
    );
    expect(defaultShare!.wouldHaveSavedUsd).toBeCloseTo(30, 5);
    expect(overriddenShare!.wouldHaveSavedUsd).toBeCloseTo(45, 5);
  });
});
