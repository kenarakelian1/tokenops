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
): PriceRow | null {
  if (table[model]) return table[model];

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
  return best?.row ?? null;
}

/**
 * Estimate USD cost from token counts and a price table.
 * Returns null when the model cannot be priced.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  priceOverrides?: Record<string, PriceRow>,
): number | null {
  const table = priceOverrides
    ? { ...DEFAULT_PRICES, ...priceOverrides }
    : DEFAULT_PRICES;
  // Overrides-only custom models: also search overrides alone for exact match
  // (already merged). Prefix match runs over merged table.
  const row =
    (priceOverrides && priceOverrides[model]) ||
    resolvePrice(model, table);
  if (!row) return null;
  return (
    (inputTokens / 1_000_000) * row.inputPerMTok +
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
 *  - OpenAI:    gpt-4o-mini < gpt-4o
 */
export function cheaperSiblingModel(model: string): string | null {
  const m = model.toLowerCase();

  // OpenAI GPT-4o family. Check "-mini" first: it's a substring of neither
  // direction, but "gpt-4o-mini" also matches a naive "gpt-4o" check.
  if (m.includes("gpt-4o-mini")) return null;
  if (m.includes("gpt-4o")) return "gpt-4o-mini";

  // Anthropic Claude family: opus > sonnet > haiku.
  if (m.includes("opus")) return "claude-sonnet-5";
  if (m.includes("sonnet")) return "claude-haiku-4-5";
  if (m.includes("haiku")) return null;

  return null;
}
