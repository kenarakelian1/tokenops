import { describe, expect, it } from "vitest";
import type { UsageEvent } from "@tokenops/shared";
import { defaultConfig } from "./config.js";
import { applyEventPrivacy, prepareEventForShip } from "./privacy-apply.js";

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

describe("privacy-apply", () => {
  it("strips content for local mode", () => {
    const e = applyEventPrivacy(base, "local");
    expect(e.content).toBeUndefined();
    expect(e.hasContent).toBe(false);
    expect(e.features.promptChars).toBe(10);
  });

  it("keeps content for cloud_ttl", () => {
    const e = applyEventPrivacy(base, "cloud_ttl");
    expect(e.content?.requestBody).toEqual({ hi: 1 });
    expect(e.hasContent).toBe(true);
  });

  it("prepareEventForShip uses config privacy mode", () => {
    const cfg = defaultConfig();
    expect(cfg.privacy.contentMode).toBe("local");
    const e = prepareEventForShip(base, cfg);
    expect(e.content).toBeUndefined();
    expect(e.hasContent).toBe(false);
  });
});
