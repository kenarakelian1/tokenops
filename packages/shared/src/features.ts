import { getModelTier } from "./model-tier.js";
import type { UsageFeatures } from "./schema/event.js";

export type ExtractFeaturesInput = {
  model: string;
  requestMessages?: Array<{ role: string; content: unknown }>;
  responseText?: string;
  sessionPriorPromptChars?: number;
};

/** Flatten OpenAI-style message content (string or array of parts) to text. */
function flattenContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const t = (part as { text: unknown }).text;
          return typeof t === "string" ? t : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Path-like line density: fraction of non-empty lines that look like file paths
 * (drive letters, Unix roots, or common relative path patterns with a slash).
 * Bonus contribution capped at 0.3 for fileDumpScore.
 */
function pathLikeDensityBonus(text: string): number {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return 0;

  const pathLike =
    /^(?:[a-zA-Z]:\\|\/|\.\/|\.\.\/|~\/)|(?:[/\\][\w.-]+){2,}/;
  let hits = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (pathLike.test(trimmed)) hits += 1;
  }
  const density = hits / lines.length;
  return 0.3 * density;
}

/**
 * Local feature extraction for usage events (no cloud required).
 */
export function extractFeatures(input: ExtractFeaturesInput): UsageFeatures {
  const messages = input.requestMessages ?? [];
  const promptParts = messages.map((m) => flattenContent(m.content));
  const promptText = promptParts.join("");
  const responseText = input.responseText ?? "";

  const promptChars = promptText.length;
  const responseChars = responseText.length;
  const messageCount = messages.length;

  const fenceMatches = promptText.match(/```/g);
  const codeFenceCount = Math.max(
    0,
    Math.floor((fenceMatches?.length ?? 0) / 2),
  );

  const largePasteScore = Math.min(1, promptChars / 40_000);
  const fenceComponent = Math.min(1, codeFenceCount / 5);
  const pathBonus = pathLikeDensityBonus(promptText);
  const fileDumpScore = Math.min(
    1,
    0.4 * largePasteScore + 0.3 * fenceComponent + pathBonus,
  );

  const features: UsageFeatures = {
    promptChars,
    responseChars,
    messageCount,
    codeFenceCount,
    largePasteScore,
    fileDumpScore,
    modelTier: getModelTier(input.model),
  };

  if (input.sessionPriorPromptChars !== undefined) {
    features.newContentRatio = clamp01(
      1 - input.sessionPriorPromptChars / Math.max(promptChars, 1),
    );
  }

  return features;
}
