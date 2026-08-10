import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createSessionParser } from "./claude-session.js";

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
);

function loadFixtureLines(name: string): string[] {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

function parseFixture(name: string) {
  const p = createSessionParser({ machineId: "m1", machineName: "laptop" });
  const events = [];
  for (const line of loadFixtureLines(name)) {
    const ev = p.parseLine(line);
    if (ev) events.push(ev);
  }
  return events;
}

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

  it("recurses into tool_result content arrays instead of dropping them", () => {
    // Real Claude Code transcripts routinely carry tool_result.content as an
    // array of blocks (e.g. file reads), not a string. Losing those chars
    // makes full_document_io's 20k-char threshold under-fire.
    const p = parser();
    const dump = "d".repeat(20_000);
    p.parseLine(
      userLine("", {
        message: {
          role: "user",
          content: [
            { type: "tool_result", content: [{ type: "text", text: dump }] },
          ],
        },
      }),
    );
    const ev = p.parseLine(assistantLine())!;
    expect(ev.features.promptChars).toBeGreaterThanOrEqual(20_000);
  });

  it("does not let a sidechain turn pollute the mainline's newContentRatio state", () => {
    const p = parser();
    const mainPrompt1 = "m".repeat(10_000);
    p.parseLine(userLine(mainPrompt1));
    p.parseLine(assistantLine()); // mainline turn 1

    // Sidechain (subagent) turn: unrelated, much smaller prompt. If this
    // were allowed to overwrite priorPromptChars, the next mainline turn's
    // newContentRatio would spike toward 1 (reads as "all new content").
    p.parseLine(userLine("s", { uuid: "side-u", isSidechain: true }));
    p.parseLine(assistantLine({ uuid: "side-a", isSidechain: true }));

    const mainPrompt2 = "m".repeat(10_500);
    p.parseLine(userLine(mainPrompt2, { uuid: "u-2" }));
    const ev = p.parseLine(assistantLine({ uuid: "a-2" }))!;

    // newContentRatio must be computed against mainPrompt1 (10000 chars),
    // not the subagent's 1-char prompt.
    expect(ev.features.newContentRatio).toBeDefined();
    expect(ev.features.newContentRatio!).toBeLessThan(0.25);
  });

  // Real fixtures, cut from actual Claude Code session files with content
  // scrubbed. Claude Code writes one JSONL line per assistant content
  // block, not per API response — these fixtures reproduce that shape
  // (multiple assistant lines sharing one message.id, one requestId, and
  // byte-identical usage) so the coalescing fix is exercised against real
  // structure, not a hand-written idealization of it.

  it("mainline: coalesces 22 assistant lines across 8 message ids into 8 events", () => {
    const events = parseFixture("claude-session-mainline.jsonl");
    expect(events).toHaveLength(8);
  });

  it("sidechain: coalesces 8 assistant lines across 3 message ids into 3 events", () => {
    const events = parseFixture("claude-session-real.jsonl");
    expect(events).toHaveLength(3);
  });

  it("mainline: does not multiply tokens across coalesced blocks", () => {
    const events = parseFixture("claude-session-mainline.jsonl");
    const totalInput = events.reduce((sum, ev) => sum + ev.inputTokens, 0);
    // Sum of (input_tokens + cache_read_input_tokens +
    // cache_creation_input_tokens) over the fixture's 8 distinct message
    // ids, computed by hand from the raw fixture (not via the parser):
    //   msg_0012: 2 + 25480 + 27276 = 52758
    //   msg_0022: 2 + 52756 +   925 = 53683
    //   msg_0032: 2 + 53681 +  1428 = 55111
    //   msg_0038: 2 + 55109 +   257 = 55368
    //   msg_0044: 2 + 55366 +  6837 = 62205
    //   msg_0052: 1 + 62203 +  4113 = 66317
    //   msg_0059: 2 + 66316 +   786 = 67104
    //   msg_0065: 2 + 67102 +   557 = 67661
    // total                        = 480207
    expect(totalInput).toBe(480_207);
  });

  it("mainline: no event has a zero prompt when a user line preceded its message", () => {
    // Every message in the fixture is preceded by a non-empty user/
    // tool_result line, so under correct once-per-message consumption none
    // of the 8 events should see an empty prompt. Before the fix, 3 of the
    // 4 lines per message (blocks 2..n) read pendingPrompt after it had
    // already been cleared by block 1.
    const events = parseFixture("claude-session-mainline.jsonl");
    for (const ev of events) {
      expect(ev.features.promptChars).toBeGreaterThan(0);
    }
  });

  it("is idempotent: two independent parser instances agree on the eventId set", () => {
    const idsA = parseFixture("claude-session-mainline.jsonl").map(
      (ev) => ev.eventId,
    );
    const idsB = parseFixture("claude-session-mainline.jsonl").map(
      (ev) => ev.eventId,
    );
    expect(new Set(idsA)).toEqual(new Set(idsB));
    expect(idsA).toHaveLength(8);
    // All distinct: message.id is a real fingerprint, not a constant.
    expect(new Set(idsA).size).toBe(8);
  });

  it("produces an event fingerprinted on uuid when message.id is absent", () => {
    // assistantLine()'s default message object carries no `id` field, i.e.
    // exactly the "format isn't a published contract" case the fallback
    // exists for.
    const p = parser();
    p.parseLine(userLine("hello"));
    const withoutId = p.parseLine(assistantLine())!;

    expect(withoutId).not.toBeNull();
    expect(withoutId.inputTokens).toBe(54_940);

    // Fingerprinting on uuid (not a constant) means two different lines
    // with no message.id still get two different eventIds.
    const q = parser();
    q.parseLine(userLine("hello"));
    const other = q.parseLine(assistantLine({ uuid: "a-2" }))!;
    expect(other.eventId).not.toBe(withoutId.eventId);

    // And fingerprinting is still uuid-stable: replaying the identical line
    // yields the identical eventId (the general idempotence property).
    const r = parser();
    r.parseLine(userLine("hello"));
    const replay = r.parseLine(assistantLine())!;
    expect(replay.eventId).toBe(withoutId.eventId);
  });
});
