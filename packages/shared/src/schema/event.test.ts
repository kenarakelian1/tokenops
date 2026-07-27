import { describe, it, expect } from "vitest";
import {
  UsageEventSchema,
  IngestBatchSchema,
  parseUsageEvent,
} from "./event.js";

const validEvent = {
  eventId: "a".repeat(64),
  timestamp: "2026-07-27T12:00:00.000Z",
  machineId: "m1",
  machineName: "dev-box",
  app: "openai-proxy",
  provider: "openai",
  model: "gpt-4o-mini",
  inputTokens: 100,
  outputTokens: 50,
  costUsd: 0.001,
  features: {
    promptChars: 400,
    responseChars: 200,
    messageCount: 2,
    codeFenceCount: 0,
    largePasteScore: 0,
    fileDumpScore: 0,
    modelTier: "small" as const,
  },
  hasContent: false,
};

describe("UsageEventSchema", () => {
  it("accepts a valid usage event", () => {
    const result = UsageEventSchema.safeParse(validEvent);
    expect(result.success).toBe(true);
  });

  it("rejects missing eventId", () => {
    const { eventId: _, ...rest } = validEvent;
    const result = UsageEventSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

describe("parseUsageEvent", () => {
  it("returns parsed event for valid input", () => {
    const event = parseUsageEvent(validEvent);
    expect(event.eventId).toBe(validEvent.eventId);
    expect(event.inputTokens).toBe(100);
  });

  it("throws on invalid input", () => {
    expect(() => parseUsageEvent({})).toThrow();
  });
});

describe("IngestBatchSchema", () => {
  it("accepts a batch of events", () => {
    const result = IngestBatchSchema.safeParse({ events: [validEvent] });
    expect(result.success).toBe(true);
  });
});
