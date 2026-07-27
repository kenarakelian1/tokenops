import { describe, it, expect } from "vitest";
import { deriveNewContentRatio, extractFeatures } from "./features.js";

describe("extractFeatures", () => {
  it("counts messages and chars", () => {
    const f = extractFeatures({
      model: "gpt-4o",
      requestMessages: [
        { role: "user", content: "a".repeat(100) },
        { role: "user", content: "```\ncode\n```" },
      ],
      responseText: "ok",
    });
    expect(f.messageCount).toBe(2);
    expect(f.promptChars).toBeGreaterThan(100);
    expect(f.codeFenceCount).toBeGreaterThanOrEqual(1);
    expect(f.modelTier).toBe("frontier");
  });

  it("scores large paste when one message is huge", () => {
    const f = extractFeatures({
      model: "gpt-4o-mini",
      requestMessages: [{ role: "user", content: "x".repeat(50_000) }],
      responseText: "y",
    });
    expect(f.largePasteScore).toBeGreaterThan(0.5);
    expect(f.fileDumpScore).toBeGreaterThan(0.3);
  });

  it("sets newContentRatio from sessionPriorPromptChars", () => {
    const f = extractFeatures({
      model: "gpt-4o-mini",
      requestMessages: [{ role: "user", content: "x".repeat(1000) }],
      sessionPriorPromptChars: 900,
    });
    expect(f.newContentRatio).toBeCloseTo(0.1, 5);
  });
});

describe("deriveNewContentRatio", () => {
  it("is low when almost all prior chars are still present", () => {
    expect(deriveNewContentRatio(12_000, 11_000)).toBeCloseTo(1 / 12, 5);
  });

  it("is 1 when prior was empty", () => {
    expect(deriveNewContentRatio(500, 0)).toBe(1);
  });

  it("clamps to 0 when prior exceeds current", () => {
    expect(deriveNewContentRatio(100, 200)).toBe(0);
  });
});
