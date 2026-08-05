/**
 * Approximate public list prices (USD per 1M tokens). Estimates only —
 * not a billing guarantee. Prefer user overrides when available.
 *
 * Sources: approximate OpenAI / Anthropic public rates as of 2025–2026.
 */
export type PriceRow = { inputPerMTok: number; outputPerMTok: number };

export const DEFAULT_PRICES: Record<string, PriceRow> = {
  // OpenAI
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 },
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  o1: { inputPerMTok: 15, outputPerMTok: 60 },
  "o3-mini": { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  // Anthropic (approximate; model strings vary by API)
  "claude-sonnet-4": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-4": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-haiku": { inputPerMTok: 0.8, outputPerMTok: 4 },
  // Claude 5 family (published Anthropic list prices as of 2026-08).
  // Prefix-matches "claude-opus-5[1m]" (bracketed context-window suffix)
  // and "claude-haiku-4-5-20251001" (dated snapshot suffix) via resolvePrice().
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  // Standard/durable rate. Anthropic also offers an introductory rate that
  // expires 2026-08-31 — see SONNET_5_INTRO_PRICE / isSonnet5IntroActive()
  // below, which override this row in estimateCostUsd() while the intro is
  // active. This entry is what applies once the intro expires (and is what
  // any direct reader of DEFAULT_PRICES sees).
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  // xAI Grok (approximate public list prices — estimates only)
  "grok-4": { inputPerMTok: 3, outputPerMTok: 15 },
  "grok-3": { inputPerMTok: 3, outputPerMTok: 15 },
  "grok-3-mini": { inputPerMTok: 0.3, outputPerMTok: 0.5 },
  "grok-2": { inputPerMTok: 2, outputPerMTok: 10 },
  grok: { inputPerMTok: 3, outputPerMTok: 15 },
};

function resolvePrice(
  model: string,
  table: Record<string, PriceRow>,
): { key: string; row: PriceRow } | null {
  if (table[model]) return { key: model, row: table[model] };

  // Longest prefix match for versioned / dated model ids
  let best: { key: string; row: PriceRow } | null = null;
  for (const [key, row] of Object.entries(table)) {
    if (model.startsWith(key) || key.startsWith(model)) {
      // Prefer keys that are prefixes of the model (or equal length via exact handled above)
      if (model.startsWith(key) && (!best || key.length > best.key.length)) {
        best = { key, row };
      }
    }
  }
  return best;
}

// Claude Sonnet 5 introductory pricing. Anthropic priced Sonnet 5 at $2/$10
// per 1M tokens (in/out) through 2026-08-31, reverting to the standard
// $3/$15 list price ("claude-sonnet-5" in DEFAULT_PRICES, above) after that.
// isSonnet5IntroActive() takes `now` as a parameter so tests can pin both
// sides of the cutoff without depending on the real clock. Once the current
// date is past 2026-08-31 everywhere this runs, this branch is permanently
// dead — safe to delete SONNET_5_INTRO_PRICE and this function, and rely on
// the DEFAULT_PRICES "claude-sonnet-5" row alone.
const SONNET_5_INTRO_PRICE: PriceRow = { inputPerMTok: 2, outputPerMTok: 10 };
const SONNET_5_INTRO_EXPIRY_UTC = new Date("2026-08-31T00:00:00Z");

function isSonnet5IntroActive(now: Date): boolean {
  return now.getTime() < SONNET_5_INTRO_EXPIRY_UTC.getTime();
}

/**
 * Anthropic bills cache reads and cache-creation writes at different
 * multiples of a model's base input rate, not at the base rate itself.
 * cacheReadTokens/cacheCreationTokens are subsets of inputTokens (Task 2
 * deliberately keeps them folded into inputTokens for ledger totals — see
 * claude-otel.ts), so pricing must carve them back out of the full-rate
 * portion rather than charging for them twice.
 */
const CACHE_READ_PRICE_MULTIPLIER = 0.1;
const CACHE_CREATION_PRICE_MULTIPLIER = 1.25;

/**
 * Optional cache-token breakdown for `estimateCostUsd`. Both fields are
 * subsets of the `inputTokens` passed alongside them, `number | null`
 * matching `ModelWindowTotals` — omit the whole object (or pass `null`
 * fields) when no breakdown is available and the full input rate applies to
 * every token, same as before this option existed.
 */
export type CacheTokenBreakdown = {
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
};

/**
 * Estimate USD cost from token counts and a price table.
 * Returns null when the model cannot be priced.
 *
 * @param now Comparison instant for date-gated prices (e.g. the Claude
 *   Sonnet 5 introductory rate). Defaults to the real current time; tests
 *   pass a fixed Date to pin behavior on either side of a cutoff.
 * @param cacheTokens Optional breakdown of `inputTokens` into cache-read and
 *   cache-creation subsets, priced at 0.1x and 1.25x the model's base input
 *   rate respectively instead of the full rate. Appended as a trailing
 *   options object (rather than more positional args) so every existing
 *   call site — which passes 2-5 positional args today — keeps working
 *   unchanged.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  priceOverrides?: Record<string, PriceRow>,
  now: Date = new Date(),
  cacheTokens?: CacheTokenBreakdown,
): number | null {
  const table = priceOverrides
    ? { ...DEFAULT_PRICES, ...priceOverrides }
    : DEFAULT_PRICES;

  let row: PriceRow | null = null;
  if (priceOverrides && priceOverrides[model]) {
    // An explicit user override always wins, even over date-gated pricing.
    row = priceOverrides[model];
  } else {
    const resolved = resolvePrice(model, table);
    if (resolved) {
      const sonnet5Overridden = Boolean(
        priceOverrides && priceOverrides["claude-sonnet-5"],
      );
      row =
        resolved.key === "claude-sonnet-5" &&
        !sonnet5Overridden &&
        isSonnet5IntroActive(now)
          ? SONNET_5_INTRO_PRICE
          : resolved.row;
    }
  }
  if (!row) return null;

  // Cache reads/creates default to 0 (not just when omitted, but also when
  // recorded as null — "no breakdown known" means "assume no discount",
  // the same full-price behavior every caller had before this option
  // existed) and are carved out of the full-rate portion so they're priced
  // once, at their own multiplier, rather than twice.
  const cacheReadTokens = cacheTokens?.cacheReadTokens ?? 0;
  const cacheCreationTokens = cacheTokens?.cacheCreationTokens ?? 0;
  const fullRateInputTokens = Math.max(
    0,
    inputTokens - cacheReadTokens - cacheCreationTokens,
  );

  return (
    (fullRateInputTokens / 1_000_000) * row.inputPerMTok +
    (cacheReadTokens / 1_000_000) *
      row.inputPerMTok *
      CACHE_READ_PRICE_MULTIPLIER +
    (cacheCreationTokens / 1_000_000) *
      row.inputPerMTok *
      CACHE_CREATION_PRICE_MULTIPLIER +
    (outputTokens / 1_000_000) * row.outputPerMTok
  );
}

/**
 * Suggest a cheaper model in the SAME vendor family as `model`, so the
 * suggestion is something a user could actually switch a call to.
 *
 * Returns null when:
 *  - the vendor/family is unrecognized, or
 *  - `model` is already the cheapest tier in its family (no advice to give).
 *
 * Tier ordering (cheapest to most expensive):
 *  - Anthropic: haiku < sonnet < opus
 *  - OpenAI:    gpt-4o-mini < {gpt-4o, gpt-4, gpt-4-turbo, gpt-4.x, ...}
 */
export function cheaperSiblingModel(model: string): string | null {
  const m = model.toLowerCase();

  // OpenAI GPT-4 family. Matches the same surface getModelTier() (in
  // model-tier.ts) considers frontier via /gpt-4(?!o-mini)/i — i.e. any
  // "gpt-4*" variant (gpt-4o, gpt-4, gpt-4-turbo, ...) except gpt-4o-mini,
  // which is already the cheapest tier and has no advice to give.
  if (m.includes("gpt-4o-mini")) return null;
  if (m.includes("gpt-4")) return "gpt-4o-mini";

  // Anthropic Claude family: opus > sonnet > haiku.
  if (m.includes("opus")) return "claude-sonnet-5";
  if (m.includes("sonnet")) return "claude-haiku-4-5";
  if (m.includes("haiku")) return null;

  return null;
}
