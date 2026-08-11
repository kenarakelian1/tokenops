import type { PriceRow } from "../../pricing.js";
import type { Rule, RuleContext } from "../contract.js";
import { priceFinding } from "../index.js";
import { isMaterial } from "../materiality.js";
import type { RuleHit } from "../types.js";
import { sessionCacheChurnRule } from "./cache-churn.js";
import { sessionContextCeilingRule } from "./context-ceiling.js";
import type { SessionRollup } from "./rollup.js";

export {
  CONTEXT_BAND_EDGES,
  contextBandIndex,
  sumBandsFrom,
  assertBandArrays,
  type SessionRollup,
} from "./rollup.js";
export {
  SESSION_CONTEXT_TARGET_TOKENS,
  SESSION_MIN_TURNS,
  sessionContextCeilingRule,
} from "./context-ceiling.js";
export {
  SESSION_CHURN_MIN_COST_SHARE,
  SESSION_CHURN_BASELINE_TOKEN_SHARE,
  churnCostShare,
  sessionCacheChurnRule,
} from "./cache-churn.js";

/**
 * Every ruleId `runSessionRules` can emit.
 *
 * The session-rules job walks this list to retire cards for rules that
 * produced no hit in a run — a rule that stops firing never enters the hit
 * loop, so without an explicit list its last card stays open forever. Same
 * reasoning as AGGREGATE_RULE_IDS.
 */
export const SESSION_RULE_IDS = [
  "session_context_ceiling",
  "session_cache_churn",
] as const;

/** Both session rules, in the order their cards are emitted. */
const SESSION_RULES: Rule<SessionRollup>[] = [
  sessionContextCeilingRule,
  sessionCacheChurnRule,
];

/**
 * Run every session-grain rule against one session's rollup.
 *
 * A sibling of runAggregateRules rather than an extension of it: that
 * runner's input is per-MODEL totals over a time window, this one's is per
 * -SESSION totals with a context histogram. Both funnel through
 * priceFinding and isMaterial so savings assembly and the materiality floor
 * live in exactly one place each.
 *
 * @param now Pricing instant. Replays MUST pass the session's own end
 *   timestamp, not wall-clock now — otherwise a date-gated rate (the Claude
 *   Sonnet 5 introductory price, expiring 2026-08-31) reprices past traffic
 *   as the clock moves, and the same history reports different savings on
 *   different days.
 */
export function runSessionRules(
  rollup: SessionRollup,
  now: Date = new Date(),
  priceOverrides?: Record<string, PriceRow>,
): RuleHit[] {
  const ctx: RuleContext = { now, priceOverrides };
  const hits: RuleHit[] = [];

  for (const rule of SESSION_RULES) {
    const finding = rule.evaluate(rollup, ctx);
    if (!finding) continue;
    const actual = rule.resolveActual!(rollup, finding);
    if (!actual) continue;
    hits.push(priceFinding(rule, finding, actual, ctx));
  }

  return hits.filter(isMaterial);
}
