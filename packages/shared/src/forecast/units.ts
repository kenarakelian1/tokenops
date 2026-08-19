import {
  CACHE_CREATION_PRICE_MULTIPLIER,
  CACHE_READ_PRICE_MULTIPLIER,
} from "../pricing.js";
import type { UsageEvent } from "../schema/event.js";

/** Uncached input is the reference weight all others are expressed against. */
export const RAW_INPUT_UNIT_WEIGHT = 1.0;

/**
 * Output relative to uncached input. Frontier models price output at roughly
 * five times input across the table in ../pricing.ts, so this is that ratio
 * rather than a free parameter. It is NOT imported from pricing.ts because no
 * single constant there expresses it — the ratio varies slightly per model,
 * and pinning one number keeps the proxy comparable across models.
 */
export const OUTPUT_UNIT_WEIGHT = 5.0;

/**
 * Was a cache breakdown recorded for this event?
 *
 * Both fields must be present. A recorded `0` counts as recorded — the
 * absent-vs-zero distinction the rest of the ledger depends on.
 */
export function hasCacheBreakdown(event: UsageEvent): boolean {
  return (
    event.cacheReadTokens !== undefined && event.cacheCreationTokens !== undefined
  );
}

/**
 * A cache-aware PROXY for how much of an allowance an event consumed.
 *
 * Deliberately not called "usage": Anthropic does not publish what a
 * subscription meters, so this cannot be the real quantity. It only has to be
 * MONOTONICALLY related to it, because the forecast's headline output is
 * self-relative ("2.1x your own median"). That is a far weaker assumption
 * than knowing the metering formula, and it is why the no-configuration path
 * is honest.
 *
 * When no cache breakdown was recorded, all input is charged at the raw
 * weight. That over-counts relative to a cached-heavy event, which is why
 * `hasCacheBreakdown` is tracked separately and surfaced rather than hidden.
 */
export function consumptionUnits(event: UsageEvent): number {
  const read = event.cacheReadTokens ?? 0;
  const creation = event.cacheCreationTokens ?? 0;
  // Cache fields are documented subsets of inputTokens. Clamp rather than
  // trust: one malformed producer must not drive a whole window negative.
  const raw = Math.max(0, event.inputTokens - read - creation);

  return (
    raw * RAW_INPUT_UNIT_WEIGHT +
    creation * CACHE_CREATION_PRICE_MULTIPLIER +
    read * CACHE_READ_PRICE_MULTIPLIER +
    event.outputTokens * OUTPUT_UNIT_WEIGHT
  );
}
