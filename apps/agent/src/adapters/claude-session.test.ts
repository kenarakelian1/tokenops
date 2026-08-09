import { describe, it, expect } from "vitest";
import { createSessionParser } from "./claude-session.js";

const parser = () =>
  createSessionParser({ machineId: "m1", machineName: "laptop" });

const userLine = (text: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "user",
    uuid: "u-1",
    sessionId: "s-1",
    timestamp: "2026-08-09T12:00:00.000Z",
    message: { role: "user", content: text },
    ...over,
  });

const assistantLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    uuid: "a-1",
    requestId: "req_1",
    sessionId: "s-1",
    timestamp: "2026-08-09T12:00:01.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-5[1m]",
      content: "ok",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 28_890,
        cache_read_input_tokens: 26_048,
        output_tokens: 229,
      },
    },
    ...over,
  });

describe("createSessionParser", () => {
  it("folds cache tokens into inputTokens and keeps the raw subsets", () => {
    // The real measured sample from ~/.claude/projects.
    const p = parser();
    p.parseLine(userLine("hello"));
    const ev = p.parseLine(assistantLine())!;
    expect(ev.inputTokens).toBe(54_940); // 2 + 28890 + 26048
    expect(ev.cacheReadTokens).toBe(26_048);
    expect(ev.cacheCreationTokens).toBe(28_890);
    expect(ev.outputTokens).toBe(229);
    // The invariant cache_efficiency and trimCacheTokens both assume.
    expect(
      (ev.cacheReadTokens ?? 0) + (ev.cacheCreationTokens ?? 0),
    ).toBeLessThanOrEqual(ev.inputTokens);
  });

  it("emits request grain with no content and no cost", () => {
    const p = parser();
    p.parseLine(userLine("hello"));
    const ev = p.parseLine(assistantLine())!;
    expect(ev.grain).toBe("request");
    expect(ev.hasContent).toBe(false);
    expect(ev.content).toBeUndefined();
    expect(ev.costUsd).toBeNull();
    expect(ev.app).toBe("claude-code");
    expect(ev.provider).toBe("anthropic");
  });

  it("derives promptChars from the preceding user turn, not the reply", () => {
    const p = parser();
    const prompt = "x".repeat(25_000);
    p.parseLine(userLine(prompt));
    const ev = p.parseLine(assistantLine())!;
    // 25000, not 2 (the length of the assistant's "ok")
    expect(ev.features.promptChars).toBe(25_000);
    expect(ev.features.modelTier).toBe("frontier");
  });

  it("leaves a cache field undefined when the usage object omits it", () => {
    const p = parser();
    p.parseLine(userLine("hi"));
    const ev = p.parseLine(
      assistantLine({
        message: {
          role: "assistant",
          model: "claude-opus-5[1m]",
          content: "ok",
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      }),
    )!;
    expect(ev.inputTokens).toBe(100);
    expect(ev.cacheReadTokens).toBeUndefined(); // absent != recorded zero
    expect(ev.cacheCreationTokens).toBeUndefined();
  });

  it("records a genuine zero as zero", () => {
    const p = parser();
    p.parseLine(userLine("hi"));
    const ev = p.parseLine(
      assistantLine({
        message: {
          role: "assistant",
          model: "claude-opus-5[1m]",
          content: "ok",
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }),
    )!;
    expect(ev.cacheReadTokens).toBe(0);
    expect(ev.cacheCreationTokens).toBe(0);
  });

  it("omits sessionId on a sidechain turn so context_bloat skips it", () => {
    const p = parser();
    p.parseLine(userLine("hi"));
    const ev = p.parseLine(assistantLine({ isSidechain: true }))!;
    expect(ev.sessionId).toBeUndefined();
    expect(ev.inputTokens).toBe(54_940); // tokens still count as real spend
  });

  it("is idempotent: the same line yields the same eventId", () => {
    const a = parser();
    a.parseLine(userLine("hi"));
    const first = a.parseLine(assistantLine())!;
    const b = parser();
    b.parseLine(userLine("hi"));
    const second = b.parseLine(assistantLine())!;
    expect(first.eventId).toBe(second.eventId);
  });

  it("returns null for every non-assistant line type", () => {
    const p = parser();
    for (const type of [
      "user",
      "attachment",
      "system",
      "file-history-snapshot",
      "file-history-delta",
      "mode",
      "last-prompt",
      "ai-title",
      "queue-operation",
      "pr-link",
    ]) {
      expect(p.parseLine(JSON.stringify({ type, uuid: "x" }))).toBeNull();
    }
  });

  it("returns null rather than throwing on malformed input", () => {
    const p = parser();
    expect(p.parseLine("not json at all")).toBeNull();
    expect(p.parseLine("")).toBeNull();
    expect(p.parseLine(JSON.stringify({ type: "assistant" }))).toBeNull(); // no usage
    expect(
      p.parseLine(JSON.stringify({ type: "assistant", message: {} })),
    ).toBeNull();
  });

  it("sets newContentRatio from the previous turn's prompt size", () => {
    const p = parser();
    p.parseLine(userLine("y".repeat(10_000)));
    p.parseLine(assistantLine());
    p.parseLine(userLine("y".repeat(10_500), { uuid: "u-2" }));
    const ev = p.parseLine(assistantLine({ uuid: "a-2" }))!;
    expect(ev.features.newContentRatio).toBeDefined();
    // ~5% new content between 10000 and 10500 chars
    expect(ev.features.newContentRatio!).toBeLessThan(0.25);
  });
});
