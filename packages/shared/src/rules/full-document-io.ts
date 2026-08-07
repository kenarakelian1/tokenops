import type { UsageEvent } from "../schema/event.js";
import type { Rule, RuleContext, RuleFinding } from "./contract.js";
import { trimCacheTokens } from "./counterfactual.js";

/** Minimum prompt size (chars) to consider full-document I/O. */
export const FULL_DOC_MIN_PROMPT_CHARS = 20_000;

/** Minimum file-dump score to flag bulk document paste. */
export const FULL_DOC_MIN_DUMP_SCORE = 0.55;

/**
 * Share of the dumped content excerpting is assumed to remove.
 *
 * This used to be a bare `* 0.5` inside the savings arithmetic, where nothing
 * stated what it represented and the dollar figure it produced could not be
 * checked. It is now a named constant feeding a counterfactual, and the
 * finding carries the assumption in words so a user can disagree with it.
 */
export const FULL_DOC_EXCERPT_FRACTION = 0.5;

/**
 * Large prompt with a high file-dump signal — whole documents pasted instead
 * of excerpts. Counterfactual: the same model with the excerptable share of
 * input removed.
 */
export const fullDocumentIoRule: Rule<UsageEvent> = {
  id: "full_document_io",
  grain: "request",
  defaultSeverity: "warn",

  evaluate(event: UsageEvent, _ctx: RuleContext): RuleFinding | null {
    const { features, inputTokens, outputTokens } = event;

    if (features.promptChars == null) return null;
    if (features.fileDumpScore == null) return null;
    if (features.promptChars < FULL_DOC_MIN_PROMPT_CHARS) return null;
    if (features.fileDumpScore < FULL_DOC_MIN_DUMP_SCORE) return null;

    const removedTokens = Math.floor(
      inputTokens * features.fileDumpScore * FULL_DOC_EXCERPT_FRACTION,
    );
    if (removedTokens <= 0) return null;

    const counterfactualInputTokens = Math.max(0, inputTokens - removedTokens);
    // Excerpting trims uncached content first — a cached system prompt
    // stays cached when you send less of the rest of the prompt. See
    // trimCacheTokens for why cache tokens only shrink once the removal
    // exceeds the uncached portion.
    const trimmedCache = trimCacheTokens(
      {
        inputTokens,
        cacheReadTokens: event.cacheReadTokens ?? null,
        cacheCreationTokens: event.cacheCreationTokens ?? null,
      },
      counterfactualInputTokens,
    );

    return {
      title: "Full-document I/O",
      detail:
        "Prompt looks like a large file dump. Send diffs, excerpts, or retrieved " +
        "chunks instead of whole documents every turn.",
      eventIds: [event.eventId],
      implicatedTokens: removedTokens,
      counterfactual: {
        model: event.model,
        inputTokens: counterfactualInputTokens,
        outputTokens,
        cacheReadTokens: trimmedCache.cacheReadTokens,
        cacheCreationTokens: trimmedCache.cacheCreationTokens,
      },
      // No leading "Assumes" — the card renders the prefix (see
      // apps/web/src/pages/Recommendations.tsx). A rule states the belief;
      // the UI frames it.
      assumption:
        "excerpting removes half the dumped content, leaving the rest of the prompt unchanged",
    };
  },
};
