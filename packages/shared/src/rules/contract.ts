import type { PriceRow } from "../pricing.js";
import type { UsageEvent } from "../schema/event.js";
import type { Actual, Counterfactual } from "./counterfactual.js";
import type { RuleId, Severity } from "./types.js";

/**
 * What a rule returns when it fires. It states WHAT is wrong and WHAT would
 * have happened instead; it never computes money. The runner turns the
 * counterfactual into dollars via priceCounterfactual.
 */
export type RuleFinding = {
  title: string;
  detail: string;
  eventIds: string[];
  counterfactual: Counterfactual;
  /**
   * Tokens implicated by this finding — for display and for the materiality
   * fallback when USD is unknown. Not the token delta: a model-swap finding
   * implicates every token in the call while changing none of them.
   */
  implicatedTokens: number;
  /**
   * The assumption the counterfactual rests on, in plain language, rendered
   * on the card. Required whenever the counterfactual embeds a judgement the
   * user might reasonably dispute (e.g. "excerpting removes half the dumped
   * content"). Omit only when the counterfactual is self-evident.
   *
   * Write the CLAUSE only, with no leading "Assumes" — the card supplies the
   * prefix ("Assumes: {assumption}", see
   * apps/web/src/pages/Recommendations.tsx), so a rule that includes the word
   * itself renders "Assumes: Assumes …". A rule states the belief; the UI
   * frames it. `assumptions.test.ts` pins all five strings exactly.
   */
  assumption?: string;
};

export type RuleContext = {
  /** Pricing instant. Replays pass the event's own timestamp — see PricingContext. */
  now: Date;
  priceOverrides?: Record<string, PriceRow>;
  /** Request-grain rules only: prior events in the same session, oldest first. */
  sessionContext?: UsageEvent[];
};

/**
 * The published rule contract. `grain` declares which shape of input a rule
 * consumes, so a new rule STATES what it can be handed rather than
 * remembering to opt out of the wrong thing.
 *
 * The declaration is enforced, not documentation: `runRules` skips any rule
 * in REQUEST_RULES whose grain is not "request". It does NOT replace the
 * separate isAggregate() check in that runner — that one gates on the
 * EVENT's grain (is this datum a time-bucketed sum?), which is a different
 * question from what the RULE declares it consumes. Both gates are live.
 *
 * The aggregate runner (rules/aggregate/index.ts) is hand-wired rather than a
 * loop over a registry, because its two rules take different input types, so
 * there is no symmetric filter on that side.
 *
 * See docs/rules/authoring.md.
 */
export interface Rule<TInput> {
  readonly id: RuleId;
  readonly grain: "request" | "aggregate";
  readonly defaultSeverity: Severity;
  evaluate(input: TInput, ctx: RuleContext): RuleFinding | null;
  /**
   * Which slice of the input the counterfactual should be priced against.
   *
   * Most rules compare against the whole input and omit this — the runner
   * then builds the Actual from the input itself. A rule that reasons over a
   * COLLECTION and singles out one member (frontier_share picks the dominant
   * model out of a window) must implement this, because only the rule knows
   * which member it chose. Without it the runner would have to infer the
   * choice by matching token counts back against the collection, which is
   * ambiguous whenever two members share the same totals.
   *
   * Return null to withdraw the finding — if a rule cannot say what its
   * counterfactual is measured against, there is nothing to price.
   */
  resolveActual?(input: TInput, finding: RuleFinding): Actual | null;
}
