import type { UsageEvent } from "../schema/event.js";
import { checkContextBloat } from "./context-bloat.js";
import { checkFrontierTrivial } from "./frontier-trivial.js";
import { checkFullDocumentIo } from "./full-document-io.js";
import type { RuleHit } from "./types.js";

export type { RuleHit, RuleId } from "./types.js";
export {
  FRONTIER_TRIVIAL_MAX_TOTAL_TOKENS,
  checkFrontierTrivial,
} from "./frontier-trivial.js";
export {
  FULL_DOC_MIN_PROMPT_CHARS,
  FULL_DOC_MIN_DUMP_SCORE,
  checkFullDocumentIo,
} from "./full-document-io.js";
export {
  BLOAT_MIN_EVENTS,
  BLOAT_INPUT_GROWTH_RATIO,
  BLOAT_MAX_NEW_CONTENT_RATIO,
  checkContextBloat,
} from "./context-bloat.js";

/** Aggregate events are time-bucketed sums, not requests. */
export function isAggregate(event: UsageEvent): boolean {
  return event.grain === "aggregate";
}

/**
 * Run all efficiency rules against an event (and optional same-session history).
 * Returns concatenated hits from frontier_trivial, full_document_io, and context_bloat.
 */
export function runRules(
  event: UsageEvent,
  sessionContext?: UsageEvent[],
): RuleHit[] {
  // Enforced HERE, not in each rule: a new per-request rule must opt in to
  // aggregates deliberately rather than remember to opt out. Every existing
  // rule reads features that an aggregate cannot have.
  if (isAggregate(event)) return [];

  const hits: RuleHit[] = [];

  const frontier = checkFrontierTrivial(event);
  if (frontier) hits.push(frontier);

  const fullDoc = checkFullDocumentIo(event);
  if (fullDoc) hits.push(fullDoc);

  const bloat = checkContextBloat(event, sessionContext);
  if (bloat) hits.push(bloat);

  return hits;
}
