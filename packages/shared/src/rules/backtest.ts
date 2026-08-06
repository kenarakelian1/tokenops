import type { PriceRow } from "../pricing.js";
import type { UsageEvent } from "../schema/event.js";
import { runAggregateRules, type AggregateWindow } from "./aggregate/index.js";
import { runRules } from "./index.js";
import type { RuleId } from "./types.js";

export type BacktestRow = {
  ruleId: RuleId;
  hits: number;
  wouldHaveSavedUsd: number;
  /** The assumption behind the savings, taken from the first hit for the rule. */
  assumption: string | null;
};

export type BacktestResult = {
  windowStart: string;
  windowEnd: string;
  rows: BacktestRow[];
};

export type BacktestInput = {
  /** Stored events, chronological (oldest first). Aggregates are skipped by runRules. */
  events: UsageEvent[];
  /** Pre-built per-model windows for the aggregate rules. */
  windows: AggregateWindow[];
  windowStart: string;
  windowEnd: string;
  priceOverrides?: Record<string, PriceRow>;
};

/**
 * Replay the CURRENT rules over historical data and report, per rule, what
 * following them would have saved.
 *
 * It re-evaluates rules rather than summing the recommendations table. That
 * is what makes it a back-test rather than a rollup, and it means changing a
 * threshold shows its dollar impact on real history immediately.
 *
 * Every event is priced at its OWN timestamp, and every window at its own
 * end — never wall-clock now. The Claude Sonnet 5 introductory rate expires
 * 2026-08-31, so a back-test that used the current time would reprice August
 * traffic at September rates and report different savings for the same
 * historical window depending on the day it ran.
 */
export function backtest(input: BacktestInput): BacktestResult {
  const byRule = new Map<RuleId, BacktestRow>();

  const record = (
    ruleId: RuleId,
    usd: number | null,
    assumption: string | null,
  ) => {
    const existing = byRule.get(ruleId);
    if (existing) {
      existing.hits += 1;
      existing.wouldHaveSavedUsd += usd ?? 0;
      existing.assumption ??= assumption;
      return;
    }
    byRule.set(ruleId, {
      ruleId,
      hits: 1,
      wouldHaveSavedUsd: usd ?? 0,
      assumption,
    });
  };

  // Request-grain rules. Session context is the prior events of the same
  // session, oldest first — the same shape applyRulesForEvent passes live.
  const bySession = new Map<string, UsageEvent[]>();
  for (const event of input.events) {
    const priorSameSession = event.sessionId
      ? (bySession.get(event.sessionId) ?? [])
      : [];
    const hits = runRules(event, priorSameSession, {
      now: new Date(event.timestamp),
      priceOverrides: input.priceOverrides,
    });
    for (const hit of hits) {
      record(hit.ruleId, hit.estimatedWastedUsd, hit.assumption);
    }
    if (event.sessionId) {
      bySession.set(event.sessionId, [...priorSameSession, event]);
    }
  }

  // Aggregate-grain rules, each window priced at its own end instant.
  for (const window of input.windows) {
    const hits = runAggregateRules(
      window,
      new Date(window.end),
      input.priceOverrides,
    );
    for (const hit of hits) {
      record(hit.ruleId, hit.estimatedWastedUsd, hit.assumption);
    }
  }

  const rows = [...byRule.values()].sort(
    (a, b) => b.wouldHaveSavedUsd - a.wouldHaveSavedUsd,
  );

  return {
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    rows,
  };
}
