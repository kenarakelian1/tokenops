import type { PriceRow } from "../pricing.js";
import type { UsageEvent } from "../schema/event.js";
import { runAggregateRules, type AggregateWindow } from "./aggregate/index.js";
import { runRules } from "./index.js";
import type { RuleId } from "./types.js";

/**
 * Which instant this row's dollars were priced at — the caveat that travels
 * with the number, so a consumer never has to infer it.
 *
 * - `"event-timestamp"` — every hit priced at its own event's timestamp. A
 *   date-gated rate applies exactly as it did when the traffic happened.
 * - `"window-end"` — the whole window priced at a single instant, its end.
 *   Rates that changed mid-window are NOT honoured: a 90-day window is
 *   priced entirely off the rate card in force at `end`. Slicing the window
 *   into rate-stable segments is future work; until then this is the
 *   limitation, stated rather than papered over.
 */
export type PricingBasis = "event-timestamp" | "window-end";

export type BacktestRow = {
  ruleId: RuleId;
  hits: number;
  wouldHaveSavedUsd: number;
  /** The assumption behind the savings, taken from the first hit for the rule. */
  assumption: string | null;
  /**
   * How `wouldHaveSavedUsd` was priced. Fixed per rule, because it follows
   * the rule's grain: request-grain rules are replayed event by event,
   * aggregate-grain rules once per window. See PricingBasis.
   */
  pricingBasis: PricingBasis;
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
 * Nothing here is priced at wall-clock now, so the same stored history
 * reports the same figures whatever day the back-test runs. That matters
 * because the Claude Sonnet 5 introductory rate expires 2026-08-31: a
 * back-test reading the current clock would reprice August traffic at
 * September rates.
 *
 * The two grains reach that guarantee with different resolution, and the
 * difference is a real limitation, not a detail:
 *
 *  - **Request grain** — each event is priced at its OWN timestamp, so a
 *    rate change part-way through the window is honoured event by event.
 *    Reported as `pricingBasis: "event-timestamp"`.
 *  - **Aggregate grain** — each window is priced at a single instant, its
 *    `end`. The caller supplies the windows, and the one the API builds
 *    (apps/api/src/routes/recommendations.ts) spans the whole back-test
 *    period, so a 90-day run prices all 90 days off the rate card in force
 *    on the last day. Run on 2026-09-05, every day of Claude Sonnet 5
 *    traffic in that window is priced at the post-expiry $3/$15 even though
 *    the introductory $2/$10 applied for most of it. Reported as
 *    `pricingBasis: "window-end"`.
 *
 * Slicing an aggregate window into rate-stable segments would close that
 * gap and is deliberately out of scope here; `pricingBasis` on every row
 * exists so a consumer of these numbers is told which of the two they have.
 */
export function backtest(input: BacktestInput): BacktestResult {
  const byRule = new Map<RuleId, BacktestRow>();

  const record = (
    ruleId: RuleId,
    usd: number | null,
    assumption: string | null,
    pricingBasis: PricingBasis,
  ) => {
    const existing = byRule.get(ruleId);
    if (existing) {
      existing.hits += 1;
      existing.wouldHaveSavedUsd += usd ?? 0;
      existing.assumption ??= assumption;
      // pricingBasis follows the rule's grain, so every hit for a given
      // ruleId carries the same one — nothing to merge.
      return;
    }
    byRule.set(ruleId, {
      ruleId,
      hits: 1,
      wouldHaveSavedUsd: usd ?? 0,
      assumption,
      pricingBasis,
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
      record(hit.ruleId, hit.estimatedWastedUsd, hit.assumption, "event-timestamp");
    }
    if (event.sessionId) {
      bySession.set(event.sessionId, [...priorSameSession, event]);
    }
  }

  // Aggregate-grain rules. One pricing instant for the whole window — its
  // end — with the consequence spelled out on PricingBasis and reported on
  // every row these produce.
  for (const window of input.windows) {
    const hits = runAggregateRules(
      window,
      new Date(window.end),
      input.priceOverrides,
    );
    for (const hit of hits) {
      record(hit.ruleId, hit.estimatedWastedUsd, hit.assumption, "window-end");
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
