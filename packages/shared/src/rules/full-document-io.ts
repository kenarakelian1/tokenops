import { estimateCostUsd } from "../pricing.js";
import type { UsageEvent } from "../schema/event.js";
import type { RuleHit } from "./types.js";

/** Minimum prompt size (chars) to consider full-document I/O. */
export const FULL_DOC_MIN_PROMPT_CHARS = 20_000;

/** Minimum file-dump score to flag bulk document paste. */
export const FULL_DOC_MIN_DUMP_SCORE = 0.55;

/**
 * Large prompt with high file-dump signal — whole documents pasted instead of excerpts.
 * Wasted tokens ≈ floor(inputTokens * fileDumpScore * 0.5); USD proportional to cost.
 */
export function checkFullDocumentIo(event: UsageEvent): RuleHit | null {
  const { features, inputTokens, outputTokens } = event;

  if (features.promptChars < FULL_DOC_MIN_PROMPT_CHARS) return null;
  if (features.fileDumpScore < FULL_DOC_MIN_DUMP_SCORE) return null;

  const estimatedWastedTokens = Math.floor(
    inputTokens * features.fileDumpScore * 0.5,
  );

  const totalCost =
    event.costUsd ??
    estimateCostUsd(event.model, inputTokens, outputTokens);
  const totalTokens = inputTokens + outputTokens;
  let estimatedWastedUsd: number | null = null;
  if (totalCost != null && totalTokens > 0) {
    estimatedWastedUsd = totalCost * (estimatedWastedTokens / totalTokens);
  }

  return {
    ruleId: "full_document_io",
    severity: "warn",
    title: "Full-document I/O",
    detail:
      "Prompt looks like a large file dump. Send diffs, excerpts, or retrieved " +
      "chunks instead of whole documents every turn.",
    estimatedWastedTokens,
    estimatedWastedUsd,
    eventIds: [event.eventId],
  };
}
