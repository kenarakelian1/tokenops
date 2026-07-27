import { describe, it, expect } from "vitest";
import { applyPrivacy } from "./privacy.js";
import type { UsageEvent } from "./schema/event.js";

const base: UsageEvent = {
  eventId: "e1",
  timestamp: new Date().toISOString(),
  machineId: "m",
  machineName: "n",
  app: "openai-proxy",
  provider: "openai",
  model: "gpt-4o-mini",
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.001,
  features: {
    promptChars: 10,
    responseChars: 5,
    messageCount: 1,
    codeFenceCount: 0,
    largePasteScore: 0,
    fileDumpScore: 0,
    modelTier: "small",
  },
  hasContent: true,
  content: { requestBody: { hi: 1 }, responseBody: { bye: 2 } },
};

describe("applyPrivacy", () => {
  it("strips content for off", () => {
    const e = applyPrivacy(base, "off");
    expect(e.content).toBeUndefined();
    expect(e.hasContent).toBe(false);
    expect(e.features.promptChars).toBe(10);
  });

  it("keeps content for cloud_ttl", () => {
    const e = applyPrivacy(base, "cloud_ttl");
    expect(e.content?.requestBody).toEqual({ hi: 1 });
    expect(e.hasContent).toBe(true);
  });

  it("strips content for local (cloud ship shape)", () => {
    // applyPrivacy prepares the *ship* payload: local mode does not send content upstream
    const e = applyPrivacy(base, "local");
    expect(e.content).toBeUndefined();
    expect(e.hasContent).toBe(false);
  });
});
