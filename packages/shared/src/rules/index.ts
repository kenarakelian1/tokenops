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

/** Aggregate events are time-bucketed sums, not requests. */
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
 * Aggregates are gated here, not in each rule: a new per-request rule must opt
 * in to aggregates deliberately rather than remember to opt out. Every
 * request-grain rule reads features an aggregate cannot have.
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
