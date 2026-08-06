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
});
