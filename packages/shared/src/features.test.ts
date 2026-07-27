import { describe, it, expect } from "vitest";
import { extractFeatures } from "./features.js";

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
});
