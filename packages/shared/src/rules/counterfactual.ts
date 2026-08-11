import { estimateCostUsd, type PriceRow } from "../pricing.js";

/**
 * What a request or window would have looked like had a rule's advice been
 * followed. `model` equals the actual model when the advice concerns tokens
 * rather than routing.
 *
 * cacheReadTokens/cacheCreationTokens keep the `number | null` semantics
 * established on ModelWindowTotals: `null` means no breakdown was recorded,
 * `0` means recorded and genuinely zero. Both are subsets of inputTokens.
 */
export type Counterfactual = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
};

/** The observed side of the comparison. Deliberately carries no costUsd — see below. */
export type Actual = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
};

export type PricingContext = {
  /**
   * Pricing instant. Callers replaying history pass the EVENT's timestamp,
   * not wall-clock now — otherwise a date-gated rate (the Claude Sonnet 5
   * introductory price, expiring 2026-08-31) would reprice past traffic as
   * the clock moves, and the same historical window would report different
   * savings on different days.
   */
  now: Date;
  priceOverrides?: Record<string, PriceRow>;
  /**
   * Tokens this finding implicates, for display and for the materiality
   * fallback when USD is unknown. This is NOT the token delta between the
   * two sides: a model-swap finding implicates every token in the call while
   * changing none of them.
   */
  implicatedTokens?: number;
};

export type PricedSavings = {
  estimatedWastedTokens: number;
  estimatedWastedUsd: number | null;
};

/**
 * Trims a cache-token breakdown to fit a shrunken counterfactual
 * `inputTokens`, for rules (full_document_io, context_bloat) whose advice is
 * "send less input" rather than "switch model".
 *
 * Trimming removes UNCACHED content first — that is what the advice those
 * rules give actually means: a cached system prompt stays cached when you
 * send an excerpt instead of a whole document, or hold context flat instead
 * of letting it grow. Only when the removal exceeds the uncached (full-rate)
 * portion does cached content shrink too, and then cacheCreationTokens
 * (billed at 1.25x the base input rate) is shed before cacheReadTokens
 * (billed at 0.1x) — the expensive part goes first.
 *
 * A component that was `null` on the actual side (no breakdown recorded)
 * stays `null` and contributes 0 to the trim — this never materializes a
 * number where the event recorded none, preserving the null-vs-zero
 * distinction documented on Counterfactual.
 *
 * Post-condition: (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0) on the
 * returned breakdown is always <= counterfactualInputTokens.
 */
export function trimCacheTokens(
  actual: Pick<
    Actual,
    "inputTokens" | "cacheReadTokens" | "cacheCreationTokens"
  >,
  counterfactualInputTokens: number,
): { cacheReadTokens: number | null; cacheCreationTokens: number | null } {
  const read = actual.cacheReadTokens ?? 0;
  const creation = actual.cacheCreationTokens ?? 0;
  const cached = read + creation;
  const fullRate = Math.max(0, actual.inputTokens - cached);
  const removed = actual.inputTokens - counterfactualInputTokens;
  const fromCached = Math.max(0, removed - fullRate);

  if (fromCached === 0) {
    return {
      cacheReadTokens: actual.cacheReadTokens,
      cacheCreationTokens: actual.cacheCreationTokens,
    };
  }

  const creationTrim = Math.min(creation, fromCached);
  const readTrim = Math.min(read, fromCached - creationTrim);

  return {
    cacheCreationTokens:
      actual.cacheCreationTokens === null ? null : creation - creationTrim,
    cacheReadTokens: actual.cacheReadTokens === null ? null : read - readTrim,
  };
}

/**
 * Savings = cost(actual) − cost(counterfactual), with BOTH sides estimated
 * through the same price table at the same instant.
 *
 * It is deliberately impossible to pass a provider-reported cost here.
 * Preferring a real, cache-discounted costUsd on the actual side while
 * estimating the counterfactual at full price inflates the counterfactual,
 * clamps the difference to 0 through the Math.max below, and silently drops
 * the card. frontier-share.ts hit exactly that and fixed it inline in
 * 6e90aab; keeping costUsd out of this signature means no future rule can
 * reintroduce it.
 *
 * Returns null USD when either side is unpriceable — a more honest answer
 * than charging the whole call as waste, which is what frontier-trivial did
 * before this existed.
 */
export function priceCounterfactual(
  actual: Actual,
  counterfactual: Counterfactual,
  ctx: PricingContext,
): PricedSavings {
  const actualCost = estimateCostUsd(
    actual.model,
    actual.inputTokens,
    actual.outputTokens,
    ctx.priceOverrides,
    ctx.now,
    {
      cacheReadTokens: actual.cacheReadTokens,
      cacheCreationTokens: actual.cacheCreationTokens,
    },
  );
  const counterfactualCost = estimateCostUsd(
    counterfactual.model,
    counterfactual.inputTokens,
    counterfactual.outputTokens,
    ctx.priceOverrides,
    ctx.now,
    {
      cacheReadTokens: counterfactual.cacheReadTokens,
      cacheCreationTokens: counterfactual.cacheCreationTokens,
    },
  );

  const estimatedWastedUsd =
    actualCost == null || counterfactualCost == null
      ? null
      : Math.max(0, actualCost - counterfactualCost);

  return {
    estimatedWastedTokens: ctx.implicatedTokens ?? 0,
    estimatedWastedUsd,
  };
}
