import type { Counterfactual } from "./counterfactual.js";

export type RuleId =
  | "frontier_trivial"
  | "full_document_io"
  | "context_bloat"
  | "frontier_share"
  | "cache_efficiency";

/**
 * Named so the published contract has no anonymous field types. Declared per
 * rule and NOT derived from savings: a cheap finding can still be urgent, and
 * mapping dollars onto severity would just be a fresh set of magic numbers.
 * Ordering by savings, not severity, is what keeps low-value cards down.
 */
export type Severity = "info" | "warn" | "high";

/** Runner OUTPUT. Rules return RuleFinding (see contract.ts); the runner prices it into this. */
export interface RuleHit {
  ruleId: RuleId;
  severity: Severity;
  title: string;
  detail: string;
  estimatedWastedTokens: number;
  estimatedWastedUsd: number | null;
  eventIds: string[];
  /** What the runner priced against. Null only for legacy rows read back from the DB. */
  counterfactual: Counterfactual | null;
  /** The assumption the counterfactual rests on, surfaced to the user. */
  assumption: string | null;
}
