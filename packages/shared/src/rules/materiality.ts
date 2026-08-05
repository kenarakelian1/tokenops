import type { RuleHit } from "./types.js";

/**
 * Minimum estimated USD waste for a finding to be worth surfacing, once
 * cost is known. Below this, even a "real" finding is too cheap to act on.
 */
export const MIN_WASTED_USD = 0.01;

/**
 * Minimum estimated wasted tokens for a finding to be worth surfacing when
 * cost is unknown (estimatedWastedUsd === null). This is a fallback, not a
 * second vote: it only applies when cost isn't available at all.
 */
export const MIN_WASTED_TOKENS = 5_000;

/**
 * Is this finding worth showing a user?
 *
 * Cost governs when it is known — a cheap-in-tokens-but-expensive call
 * (e.g. $5 for 10 tokens against a frontier model) is material, and an
 * expensive-in-tokens-but-cheap call (e.g. 999,999 tokens for $0.0001) is
 * NOT material, even though the token count alone looks large. Tokens are
 * only consulted as a fallback when cost is unknown (null) — they never
 * override a known cost.
 */
export function isMaterial(hit: RuleHit): boolean {
  if (hit.estimatedWastedUsd != null) {
    return hit.estimatedWastedUsd >= MIN_WASTED_USD;
  }
  return hit.estimatedWastedTokens >= MIN_WASTED_TOKENS;
}
