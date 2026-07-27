export type ModelTier = "frontier" | "mid" | "small" | "unknown";

/** Frontier / flagship model name patterns (checked first). */
const FRONTIER = [
  /opus/i,
  /o1(?!\-mini)/i,
  /o3(?!\-mini)/i,
  /gpt-4(?!o-mini)/i,
  /claude-3-opus/i,
];

/** Small / cheap model name patterns. */
const SMALL = [/mini/i, /haiku/i, /nano/i, /8b/i];

/**
 * Heuristic model tier from model string.
 * Priority: frontier > small > mid (non-empty unmatched) > unknown (empty).
 */
export function getModelTier(model: string): ModelTier {
  const m = model.trim();
  if (!m) return "unknown";
  if (FRONTIER.some((re) => re.test(m))) return "frontier";
  if (SMALL.some((re) => re.test(m))) return "small";
  return "mid";
}
