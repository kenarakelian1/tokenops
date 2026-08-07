import type { UsageEvent } from "../schema/event.js";
import { contextBloatRule } from "./context-bloat.js";
import type { Rule, RuleContext, RuleFinding } from "./contract.js";
import { priceCounterfactual, type Actual } from "./counterfactual.js";
import { frontierTrivialRule } from "./frontier-trivial.js";
import { fullDocumentIoRule } from "./full-document-io.js";
import { isMaterial } from "./materiality.js";
import type { RuleHit } from "./types.js";

export type { RuleHit, RuleId, Severity } from "./types.js";
export type { Rule, RuleContext, RuleFinding } from "./contract.js";
export type {
  Counterfactual,
  Actual,
  PricedSavings,
  PricingContext,
} from "./counterfactual.js";
export { priceCounterfactual } from "./counterfactual.js";
export {
  FRONTIER_TRIVIAL_MAX_TOTAL_TOKENS,
  frontierTrivialRule,
} from "./frontier-trivial.js";
export {
  FULL_DOC_MIN_PROMPT_CHARS,
  FULL_DOC_MIN_DUMP_SCORE,
  FULL_DOC_EXCERPT_FRACTION,
  fullDocumentIoRule,
} from "./full-document-io.js";
export {
  BLOAT_MIN_EVENTS,
  BLOAT_INPUT_GROWTH_RATIO,
  BLOAT_MAX_NEW_CONTENT_RATIO,
  contextBloatRule,
} from "./context-bloat.js";
export { MIN_WASTED_USD, MIN_WASTED_TOKENS, isMaterial } from "./materiality.js";

/**
 * Is this EVENT a time-bucketed sum rather than a single request?
 *
 * This is a question about the DATA, and is separate from `Rule.grain`, which
 * is a question about the RULE. Both gates live in runRules below: an
 * aggregate event is discarded before any rule runs (per-request rules read
 * features an aggregate cannot have), and an aggregate-grain rule is skipped
 * even if it is sitting in REQUEST_RULES.
 */
export function isAggregate(event: UsageEvent): boolean {
  return event.grain === "aggregate";
}

/** Every request-grain rule, in the order their cards were historically emitted. */
export const REQUEST_RULES: Rule<UsageEvent>[] = [
  frontierTrivialRule,
  fullDocumentIoRule,
  contextBloatRule,
];

/**
 * Turn a rule's finding into a priced hit — the single place savings are
 * assembled, for request-grain and aggregate-grain rules alike.
 *
 * `actual` is what the counterfactual is compared against. The caller passes
 * it explicitly rather than deriving it here, because only a rule that
 * singles out one member of a collection knows which member it chose (see
 * Rule.resolveActual).
 */
export function priceFinding<TInput>(
  rule: Rule<TInput>,
  finding: RuleFinding,
  actual: Actual,
  ctx: RuleContext,
): RuleHit {
  const priced = priceCounterfactual(actual, finding.counterfactual, {
    now: ctx.now,
    priceOverrides: ctx.priceOverrides,
    implicatedTokens: finding.implicatedTokens,
  });

  return {
    ruleId: rule.id,
    severity: rule.defaultSeverity,
    title: finding.title,
    detail: finding.detail,
    estimatedWastedTokens: priced.estimatedWastedTokens,
    estimatedWastedUsd: priced.estimatedWastedUsd,
    eventIds: finding.eventIds,
    counterfactual: finding.counterfactual,
    assumption: finding.assumption ?? null,
  };
}

/** The whole event, as the default thing a request-grain counterfactual is measured against. */
function eventAsActual(event: UsageEvent): Actual {
  return {
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens ?? null,
    cacheCreationTokens: event.cacheCreationTokens ?? null,
  };
}

/**
 * Run all efficiency rules against an event (and optional same-session history).
 *
 * Two independent gates, both here rather than in each rule:
 *
 *  - **The event's grain.** An aggregate event is a time-bucketed sum with no
 *    request inside it, and every request-grain rule reads features it cannot
 *    have — so aggregates are discarded outright (isAggregate, above).
 *  - **The rule's declared grain.** `REQUEST_RULES` is a hand-maintained
 *    array, so nothing stops an aggregate-grain rule being appended to it.
 *    Skipping any rule that does not declare `grain: "request"` is what makes
 *    `Rule.grain` load-bearing instead of decorative: a misfiled rule stays
 *    silent instead of being handed a shape it never asked for.
 */
export function runRules(
  event: UsageEvent,
  sessionContext?: UsageEvent[],
  ctx?: Partial<RuleContext>,
): RuleHit[] {
  if (isAggregate(event)) return [];

  const fullCtx: RuleContext = {
    now: ctx?.now ?? new Date(event.timestamp),
    priceOverrides: ctx?.priceOverrides,
    sessionContext,
  };

  const hits: RuleHit[] = [];

  for (const rule of REQUEST_RULES) {
    // The declared-grain gate. See the doc comment above.
    if (rule.grain !== "request") continue;
    const finding = rule.evaluate(event, fullCtx);
    if (!finding) continue;
    const actual = rule.resolveActual
      ? rule.resolveActual(event, finding)
      : eventAsActual(event);
    if (!actual) continue;
    hits.push(priceFinding(rule, finding, actual, fullCtx));
  }

  return hits.filter(isMaterial);
}
