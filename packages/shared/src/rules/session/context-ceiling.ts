import type { Actual } from "../counterfactual.js";
import type { Rule, RuleFinding } from "../contract.js";
import {
  assertBandArrays,
  contextBandIndex,
  sumBandsFrom,
  type SessionRollup,
} from "./rollup.js";

/**
 * The context size a long session is compared against.
 *
 * MUST be a member of CONTEXT_BAND_EDGES — see the doc comment there. 300k
 * is chosen from measurement, not taste: across a real week, 21.1% of turns
 * ran above 600k and carried 46.9% of all cache reads, and holding context
 * at 300k would have cut cache-read tokens by 39.3%.
 */
export const SESSION_CONTEXT_TARGET_TOKENS = 300_000;

/** Below this, a session has no reset decision worth surfacing. */
export const SESSION_MIN_TURNS = 20;

const TARGET_BAND = contextBandIndex(SESSION_CONTEXT_TARGET_TOKENS);

/**
 * Reads and turns at or above the target. Split out because both evaluate()
 * and resolveActual() need exactly the same slice, and deriving it twice by
 * hand is how the two sides of a subtraction drift apart.
 */
function aboveTarget(rollup: SessionRollup): {
  turns: number;
  reads: number;
} {
  assertBandArrays(rollup);
  return {
    turns: sumBandsFrom(rollup.turnsByContextBand, TARGET_BAND),
    reads: sumBandsFrom(rollup.cacheReadByContextBand, TARGET_BAND),
  };
}

/**
 * A long-running session re-reads its whole context every turn at the cache
 * -read rate. This rule states what the turns above the target cost, and
 * what they would have cost held at the target.
 *
 * It reports a BOUND, not a promise. Resetting a session is not free — you
 * lose context and may pay for rework — so the `assumption` string carries
 * the claim a user may reasonably dispute, and the detail text says what
 * the turns cost rather than what resetting would save.
 *
 * Known conservatism: a turn in the 300-400k band has context >= 300k but
 * cache READS slightly below it, since part of its input is cache creation.
 * `target * turns` can therefore marginally exceed that band's actual
 * reads. The effect pushes savings DOWN, which is the correct direction for
 * a bound. Do not "fix" it by inflating the counterfactual.
 */
export const sessionContextCeilingRule: Rule<SessionRollup> = {
  id: "session_context_ceiling",
  grain: "aggregate",
  defaultSeverity: "warn",

  evaluate(rollup: SessionRollup): RuleFinding | null {
    if (rollup.turnCount < SESSION_MIN_TURNS) return null;
    // null means no breakdown was recorded; inventing 0 here would mint a
    // finding out of absent data.
    if (rollup.cacheReadTokens === null) return null;
    if (rollup.cacheCreationTokens === null) return null;

    const { turns, reads } = aboveTarget(rollup);
    if (turns === 0) return null;

    const counterfactualReads = SESSION_CONTEXT_TARGET_TOKENS * turns;
    // Emit only a positive claim. Leaving this to the pricer's
    // Math.max(0, ...) clamp would surface a $0 card asserting a saving
    // that the arithmetic does not support.
    if (reads <= counterfactualReads) return null;

    const targetK = SESSION_CONTEXT_TARGET_TOKENS / 1_000;
    return {
      title: "Long session re-reading a very large context",
      detail:
        `${turns} of this session's ${rollup.turnCount} turns ran with a context at or above ` +
        `${targetK}k tokens, re-reading ${reads.toLocaleString("en-US")} cached tokens between them. ` +
        `Held at ${targetK}k, those turns would have re-read ` +
        `${counterfactualReads.toLocaleString("en-US")}.`,
      eventIds: [],
      implicatedTokens: reads,
      counterfactual: {
        model: rollup.model,
        inputTokens: counterfactualReads,
        outputTokens: 0,
        cacheReadTokens: counterfactualReads,
        cacheCreationTokens: 0,
      },
      assumption:
        "resetting context at this size would not have required re-doing work already in it",
    };
  },

  /**
   * Only the above-target turns are being compared, not the whole session —
   * so the runner cannot build the Actual from the input, and this rule
   * must say which slice it chose.
   */
  resolveActual(rollup: SessionRollup): Actual | null {
    const { reads } = aboveTarget(rollup);
    return {
      model: rollup.model,
      inputTokens: reads,
      outputTokens: 0,
      cacheReadTokens: reads,
      cacheCreationTokens: 0,
    };
  },
};
