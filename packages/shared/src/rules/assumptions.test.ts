import { describe, it, expect } from "vitest";
import type { UsageEvent } from "../schema/event.js";
import { cacheEfficiencyRule } from "./aggregate/cache-efficiency.js";
import { frontierShareRule } from "./aggregate/frontier-share.js";
import type { AggregateWindow, ModelWindowTotals } from "./aggregate/index.js";
import { contextBloatRule } from "./context-bloat.js";
import { frontierTrivialRule } from "./frontier-trivial.js";
import { fullDocumentIoRule } from "./full-document-io.js";
import { sessionCacheChurnRule } from "./session/cache-churn.js";
import { sessionContextCeilingRule } from "./session/context-ceiling.js";
import type { SessionRollup } from "./session/rollup.js";

/**
 * The assumption strings, pinned character for character.
 *
 * These sentences are user-visible: the card renders "Assumes: {assumption}"
 * (apps/web/src/pages/Recommendations.tsx), so the rule must supply the
 * CLAUSE and nothing more. Four of the five once began with the word
 * "Assumes" themselves and shipped as "Assumes: Assumes …" for exactly as
 * long as no test looked at a whole string — the existing assertions are
 * `toMatch(/half/i)` and `toMatch(/claude-sonnet-5/)`, which a duplicated
 * prefix sails straight through.
 *
 * Pinning them exactly is the point of this file. If you are changing a
 * string here on purpose, change it here too, and check the rendered
 * sentence reads correctly with "Assumes: " in front of it.
 */
const NOW = new Date("2026-09-15T00:00:00Z");
const CTX = { now: NOW };

function ev(
  partial: Partial<UsageEvent> &
    Pick<
      UsageEvent,
      "eventId" | "model" | "inputTokens" | "outputTokens" | "features"
    >,
): UsageEvent {
  return {
    timestamp: "2026-09-15T00:00:00.000Z",
    machineId: "m",
    machineName: "n",
    app: "openai-proxy",
    provider: "openai",
    costUsd: null,
    hasContent: false,
    ...partial,
  };
}

function totals(over: Partial<ModelWindowTotals> = {}): ModelWindowTotals {
  return {
    model: "claude-opus-5",
    modelTier: "frontier",
    inputTokens: 10_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: null,
    ...over,
  };
}

/** ruleId -> the exact sentence its card shows after "Assumes: ". */
const ASSUMPTIONS: Record<string, string> = {
  frontier_trivial:
    "claude-sonnet-5 handles requests at or under 200 tokens as well as claude-opus-5",
  full_document_io:
    "excerpting removes half the dumped content, leaving the rest of the prompt unchanged",
  context_bloat:
    "context could have stayed at the size of the session's first request",
  cache_efficiency:
    "a 50% cache-read ratio is achievable for this workload",
  frontier_share:
    "routine work moves from claude-opus-5 to claude-sonnet-5. Other vendors' frontier tokens are counted in the share but not repriced.",
  session_context_ceiling:
    "resetting context at this size would not have required re-doing work already in it",
  session_cache_churn:
    "a stable cached prefix would have re-read this content instead of rewriting it",
};

function assumptionOf(ruleId: keyof typeof ASSUMPTIONS): string {
  switch (ruleId) {
    case "frontier_trivial": {
      const finding = frontierTrivialRule.evaluate(
        ev({
          eventId: "a-1",
          model: "claude-opus-5",
          inputTokens: 120,
          outputTokens: 40,
          features: {
            promptChars: 40,
            responseChars: 20,
            messageCount: 1,
            codeFenceCount: 0,
            largePasteScore: 0,
            fileDumpScore: 0,
            modelTier: "frontier",
          },
        }),
        CTX,
      );
      return finding!.assumption!;
    }
    case "full_document_io": {
      const finding = fullDocumentIoRule.evaluate(
        ev({
          eventId: "a-2",
          model: "claude-sonnet-5",
          inputTokens: 10_000,
          outputTokens: 200,
          features: {
            promptChars: 40_000,
            responseChars: 400,
            messageCount: 1,
            codeFenceCount: 3,
            largePasteScore: 0.9,
            fileDumpScore: 0.8,
            modelTier: "mid",
          },
        }),
        CTX,
      );
      return finding!.assumption!;
    }
    case "context_bloat": {
      const base = {
        model: "claude-sonnet-5",
        sessionId: "s1",
        features: {
          promptChars: 1_000,
          responseChars: 100,
          messageCount: 4,
          codeFenceCount: 0,
          largePasteScore: 0,
          fileDumpScore: 0,
          modelTier: "mid" as const,
          newContentRatio: 0.05,
        },
      };
      const finding = contextBloatRule.evaluate(
        ev({ ...base, eventId: "a-3c", inputTokens: 40_000, outputTokens: 100 }),
        {
          ...CTX,
          sessionContext: [
            ev({ ...base, eventId: "a-3a", inputTokens: 5_000, outputTokens: 100 }),
            ev({ ...base, eventId: "a-3b", inputTokens: 9_000, outputTokens: 100 }),
          ],
        },
      );
      return finding!.assumption!;
    }
    case "cache_efficiency": {
      // 10M input, 0 recorded reads, 0 recorded creation -> targetReads is
      // the uncapped 5M, i.e. the stated ratio is the full 50%.
      const finding = cacheEfficiencyRule.evaluate(totals(), CTX);
      return finding!.assumption!;
    }
    case "session_context_ceiling": {
      const rollup: SessionRollup = {
        sessionId: "s1",
        start: "2026-09-01T00:00:00.000Z",
        end: "2026-09-01T06:00:00.000Z",
        turnCount: 100,
        model: "claude-opus-5",
        modelTier: "frontier",
        inputTokens: 60_000_000,
        outputTokens: 200_000,
        cacheReadTokens: 59_000_000,
        cacheCreationTokens: 1_000_000,
        turnsByContextBand: [20, 20, 20, 10, 10, 20],
        cacheReadByContextBand: [
          1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000, 15_000_000,
        ],
      };
      const finding = sessionContextCeilingRule.evaluate(rollup, CTX);
      return finding!.assumption!;
    }
    case "session_cache_churn": {
      const rollup: SessionRollup = {
        sessionId: "s2",
        start: "2026-09-01T00:00:00.000Z",
        end: "2026-09-01T06:00:00.000Z",
        turnCount: 100,
        model: "claude-opus-5",
        modelTier: "frontier",
        inputTokens: 10_000_000,
        outputTokens: 200_000,
        cacheReadTokens: 8_000_000,
        cacheCreationTokens: 2_000_000,
        turnsByContextBand: [20, 20, 20, 10, 10, 20],
        cacheReadByContextBand: [
          1_000_000, 1_000_000, 1_000_000, 1_000_000, 2_000_000, 2_000_000,
        ],
      };
      const finding = sessionCacheChurnRule.evaluate(rollup, CTX);
      return finding!.assumption!;
    }
    case "frontier_share": {
      const w: AggregateWindow = {
        start: "2026-09-01T00:00:00.000Z",
        end: "2026-09-08T00:00:00.000Z",
        byModel: [
          totals({ inputTokens: 10_000_000, outputTokens: 100_000 }),
          totals({
            model: "claude-haiku-4-5",
            modelTier: "small",
            inputTokens: 10_000,
            outputTokens: 500,
          }),
        ],
      };
      const finding = frontierShareRule.evaluate(w, CTX);
      return finding!.assumption!;
    }
    default:
      throw new Error(`no fixture for ${ruleId}`);
  }
}

describe("rule assumption strings", () => {
  for (const [ruleId, expected] of Object.entries(ASSUMPTIONS)) {
    it(`${ruleId} states exactly its pinned assumption`, () => {
      expect(assumptionOf(ruleId)).toBe(expected);
    });
  }

  it("never begins with the word the card already supplies", () => {
    // The card renders "Assumes: {assumption}". A rule that opens with
    // "Assumes" produces "Assumes: Assumes …" — four of five shipped that
    // way, because no test had ever read a whole string.
    for (const ruleId of Object.keys(ASSUMPTIONS)) {
      expect(assumptionOf(ruleId)).not.toMatch(/^assumes\b/i);
    }
  });

  it("reads correctly once the card puts its prefix in front", () => {
    expect(`Assumes: ${assumptionOf("cache_efficiency")}`).toBe(
      "Assumes: a 50% cache-read ratio is achievable for this workload",
    );
  });
});
