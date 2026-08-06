import type { UsageEvent } from "../schema/event.js";
import type { Rule, RuleContext, RuleFinding } from "./contract.js";
import { trimCacheTokens } from "./counterfactual.js";

/** Minimum events in session (including current) before bloat is evaluated. */
export const BLOAT_MIN_EVENTS = 3;

/** Current inputTokens / first inputTokens must be at least this ratio. */
export const BLOAT_INPUT_GROWTH_RATIO = 1.8;

/** Max new-content ratio — low values mean mostly repeated context. */
export const BLOAT_MAX_NEW_CONTENT_RATIO = 0.25;

/**
 * Session context growing with little new content. Counterfactual: input held
 * flat at the session's first request.
 *
 * That counterfactual assumes the first request was not itself already
 * bloated. When it was, savings are understated — surfaced through
 * `assumption` rather than silently absorbed.
 */
export const contextBloatRule: Rule<UsageEvent> = {
  id: "context_bloat",
  grain: "request",
  defaultSeverity: "warn",

  evaluate(event: UsageEvent, ctx: RuleContext): RuleFinding | null {
    const sessionContext = ctx.sessionContext;
    if (!event.sessionId) return null;
    if (!sessionContext || sessionContext.length < 2) return null;
    if (sessionContext.length + 1 < BLOAT_MIN_EVENTS) return null;

    const first = sessionContext[0]!;
    if (first.inputTokens <= 0) return null;

    const growth = event.inputTokens / first.inputTokens;
    if (growth < BLOAT_INPUT_GROWTH_RATIO) return null;

    const newContentRatio = event.features.newContentRatio;
    if (newContentRatio === undefined) return null;
    if (newContentRatio > BLOAT_MAX_NEW_CONTENT_RATIO) return null;

    const excessTokens = Math.max(0, event.inputTokens - first.inputTokens);
    if (excessTokens === 0) return null;

    // Holding context flat trims uncached content first — a cached system
    // prompt stays cached whether or not history grew around it. See
    // trimCacheTokens for why cache tokens only shrink once the removal
    // exceeds the uncached portion.
    const trimmedCache = trimCacheTokens(
      {
        inputTokens: event.inputTokens,
        cacheReadTokens: event.cacheReadTokens ?? null,
        cacheCreationTokens: event.cacheCreationTokens ?? null,
      },
      first.inputTokens,
    );

    return {
      title: "Context bloat",
      detail:
        "Input tokens grew substantially across this session while little new content " +
        "was added. Trim history, summarize, or drop stale files from context.",
      eventIds: [...sessionContext.map((e) => e.eventId), event.eventId],
      implicatedTokens: excessTokens,
      counterfactual: {
        model: event.model,
        inputTokens: first.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: trimmedCache.cacheReadTokens,
        cacheCreationTokens: trimmedCache.cacheCreationTokens,
      },
      assumption:
        "Assumes context could have stayed at the size of the session's first request",
    };
  },
};
