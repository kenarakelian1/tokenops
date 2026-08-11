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
  // The fixture's last message is never superseded by a following
  // message.id within the file, so under "hold until the next boundary"
  // it would otherwise sit buffered forever. flushPending() is exactly the
  // test/one-shot-parse escape hatch documented on SessionParser for this —
  // production (the watcher) never calls it, since its parser instance
  // survives across polls and the in-flight message just waits.
  const trailing = p.flushPending();
  if (trailing) events.push(trailing);
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

const assistantLineWithId = (
  messageId: string,
  over: Record<string, unknown> = {},
) =>
  JSON.stringify({
    type: "assistant",
    uuid: `u-${messageId}`,
    requestId: `req-${messageId}`,
    sessionId: "s-1",
    timestamp: "2026-08-09T12:00:01.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-5[1m]",
      id: messageId,
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
        output_tokens: 10,
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

  it("emits request grain with no content, but with an estimated cost", () => {
    const p = parser();
    p.parseLine(userLine("hello"));
    const ev = p.parseLine(assistantLine())!;
    expect(ev.grain).toBe("request");
    expect(ev.hasContent).toBe(false);
    expect(ev.content).toBeUndefined();
    // Deliberate change: this previously asserted `costUsd` was null, on the
    // reasoning that a Claude Code subscription has no per-request charge.
    // That made every Claude Code dollar read as $0, because ingest does
    // `event.costUsd ?? 0` before rolling daily aggregates — and it was a
    // regression against the OTEL receiver this adapter supersedes, which
    // did price its events. See the "cost estimation" block below for the
    // hand-derived figure.
    expect(ev.costUsd).not.toBeNull();
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

  // --- Round 2: output_tokens is NOT identical across a message's blocks
  // (round 1's premise, disproved). Keeping the first block undercounted
  // output by ~27% in aggregate; the fix buffers a message's blocks and
  // takes the max of output_tokens seen, flushing only once a DIFFERENT
  // message.id proves the message is complete.

  it("sidechain: outputTokens sums to 172 across the fixture's 3 messages, not 12", () => {
    // Regression test for the round-1 defect: keeping only the first block
    // of each message summed FIRST-block output_tokens (5 + 5 + 2 = 12).
    // The true total is each message's MAX output_tokens, derived by hand
    // from the raw fixture (not via the parser):
    //   msg_0006: blocks report 5, 165                    -> max 165
    //   msg_0012: blocks report 5, 5, 5                    -> max   5
    //   msg_0021: blocks report 2, 2, 2                    -> max   2
    //   total                                              =    172
    // msg_0006 block 2's usage.output_tokens is 165 with
    // iterations[0].output_tokens also 165 — the real counterexample cited
    // in review: block 1 alone (round-1 behavior) reports only 5.
    const events = parseFixture("claude-session-real.jsonl");
    const totalOutput = events.reduce((sum, ev) => sum + ev.outputTokens, 0);
    expect(totalOutput).toBe(172);
  });

  it("mainline: outputTokens sums to the max-per-message total, not the first-block total", () => {
    // Derived by hand from the raw fixture's 8 distinct message ids, each
    // message's max output_tokens across its blocks (this fixture's
    // messages happen to report the same output_tokens on every block, so
    // max here also equals "first block" and "last block" — the point of
    // this test is the derivation method, exercised for real divergence by
    // the sidechain fixture above):
    //   msg_0012: 342, msg_0022: 411, msg_0032: 129, msg_0038: 142,
    //   msg_0044: 1346, msg_0052: 388, msg_0059: 192, msg_0065: 1203
    //   total = 342+411+129+142+1346+388+192+1203 = 4153
    const events = parseFixture("claude-session-mainline.jsonl");
    const totalOutput = events.reduce((sum, ev) => sum + ev.outputTokens, 0);
    expect(totalOutput).toBe(4_153);
  });

  it("mainline: responseChars is nonzero for a multi-block message whose later blocks carry text", () => {
    // msg_0012 (the fixture's first message) is thinking + text + tool_use
    // + tool_use. Its first block (thinking) is an empty string in this
    // scrubbed fixture — exactly the shape that made round 1's
    // first-block-only responseText read as "" (84.6% of emitted events,
    // measured against real files). Accumulating every block's text across
    // the whole buffered message must recover the text block's content.
    const events = parseFixture("claude-session-mainline.jsonl");
    const first = events[0]!;
    expect(first.features.responseChars).toBeGreaterThan(0);
  });

  it("sidechain: zero-prompt events are limited to the known tool_reference gap, not systemic", () => {
    // Unlike the mainline fixture, the sidechain fixture's msg_0012 is
    // preceded by a tool_result whose nested content is bare
    // {"type":"tool_reference"} blocks with no text field — contentToText
    // has nothing to extract there, and nothing to reasonably substitute.
    // That is a genuine data gap, not a bug, so this property is scoped
    // (not asserted as "> 0 for every event", which would be false here)
    // rather than silently extended to imply a universal guarantee the
    // mainline-only test doesn't actually establish.
    const events = parseFixture("claude-session-real.jsonl");
    const zeroPrompt = events.filter((ev) => ev.features.promptChars === 0);
    expect(zeroPrompt).toHaveLength(1);
    // The other 2 of 3 messages still have their prompt correctly paired.
    expect(events.length - zeroPrompt.length).toBe(2);
  });

  it("keeps mainline and sidechain buffers independent across an interleaved sequence", () => {
    // Pins the property no prior test distinguishes: a single-slot buffer
    // is safe because a chain switch (mainline <-> sidechain) is always
    // also a message.id change, so the id check alone already forces a
    // flush at the right point — mainline-a1, then sidechain-b1 (which
    // flushes a1), then mainline-a2 (which flushes b1).
    const p = parser();

    p.parseLine(userLine("mainline prompt one"));
    const r1 = p.parseLine(assistantLineWithId("A1"));
    expect(r1).toBeNull(); // buffered; nothing to flush yet

    p.parseLine(
      userLine("side prompt", { uuid: "su-1", isSidechain: true }),
    );
    const r2 = p.parseLine(
      assistantLineWithId("B1", { isSidechain: true }),
    );
    // A1's boundary: B1's different message.id proves A1 is complete.
    expect(r2).not.toBeNull();

    p.parseLine(userLine("mainline prompt two", { uuid: "u-2" }));
    const r3 = p.parseLine(assistantLineWithId("A2"));
    // B1's boundary: A2's different message.id proves B1 is complete —
    // even though A2 is back on the OTHER chain from B1.
    expect(r3).not.toBeNull();

    const emitted = [r1, r2, r3].filter(
      (e): e is NonNullable<typeof e> => e !== null,
    );
    expect(emitted).toHaveLength(2);
    expect(new Set(emitted.map((e) => e.eventId)).size).toBe(2);

    // A2 is still buffered (nothing followed it in this sequence) — drain
    // it explicitly, the same escape hatch parseFixture() uses.
    const r4 = p.flushPending();
    expect(r4).not.toBeNull();
    expect(r4!.eventId).not.toBe(r2!.eventId);
    expect(r4!.eventId).not.toBe(r3!.eventId);
  });
});

describe("cost estimation", () => {
  // Every figure below is derived by hand from packages/shared/src/pricing.ts,
  // never read back from the implementation. claude-opus-5 is $5/$25 per MTok;
  // cache reads bill at 0.1x the input rate, cache creations at 1.25x.
  //
  // The default fixture is the real measured turn: 2 raw input, 26,048 cache
  // read, 28,890 cache creation, 229 output — folded inputTokens 54,940.
  //
  //   raw      2      / 1e6 * 5          = 0.0000100
  //   read     26,048 / 1e6 * 5 * 0.10   = 0.0130240
  //   create   28,890 / 1e6 * 5 * 1.25   = 0.1805625
  //   output   229    / 1e6 * 25         = 0.0057250
  //                                        ---------
  //                                        0.1993215
  const EXPECTED_USD = 0.1993215;

  it("prices the event instead of leaving cost null", () => {
    const p = parser();
    p.parseLine(userLine("hello"));
    const ev = p.parseLine(assistantLine())!;
    // Ingest does `event.costUsd ?? 0`, so a null here reads as $0 spend
    // across the whole dashboard — the regression this test exists to pin.
    expect(ev.costUsd).not.toBeNull();
    expect(ev.costUsd!).toBeCloseTo(EXPECTED_USD, 6);
  });

  it("carves cache tokens out at their own multipliers, not the full input rate", () => {
    const p = parser();
    p.parseLine(userLine("hello"));
    const ev = p.parseLine(assistantLine())!;
    // Charging all 54,940 input tokens at the full $5 rate would give
    // 54_940/1e6*5 + 229/1e6*25 = 0.2804250 — 1.41x the correct figure on
    // this turn, and ~7x corpus-wide where cache is 96.7% of input.
    const fullRate = (54_940 / 1e6) * 5 + (229 / 1e6) * 25;
    expect(ev.costUsd!).toBeLessThan(fullRate);
    expect(ev.costUsd!).toBeCloseTo(EXPECTED_USD, 6);
  });

  it("prices a backfilled turn at ITS OWN date, not today's rate card", () => {
    // claude-sonnet-5 carries an introductory $2/$10 rate that expires
    // 2026-08-31. A 7-day backfill straddles that cutoff, so the same
    // history must not cost a different amount depending on when the agent
    // read it. 1M input at the intro rate = $2.00; at the standard $3 rate
    // = $3.00.
    const sonnet = (ts: string) =>
      JSON.stringify({
        type: "assistant",
        uuid: `a-${ts}`,
        requestId: "req_s",
        sessionId: "s-1",
        timestamp: ts,
        message: {
          role: "assistant",
          model: "claude-sonnet-5",
          content: "ok",
          usage: { input_tokens: 1_000_000, output_tokens: 0 },
        },
      });

    // These lines carry no `message.id`, so the parser treats each as a
    // complete standalone turn and emits it immediately rather than
    // buffering — hence reading the return of parseLine, not flushPending.
    const before = parser();
    before.parseLine(userLine("hi"));
    const intro = before.parseLine(sonnet("2026-08-15T00:00:00.000Z"))!;

    const after = parser();
    after.parseLine(userLine("hi"));
    const standard = after.parseLine(sonnet("2026-09-15T00:00:00.000Z"))!;

    expect(intro.costUsd!).toBeCloseTo(2, 6);
    expect(standard.costUsd!).toBeCloseTo(3, 6);
  });

  it("leaves cost null for a model the price table cannot price", () => {
    const p = parser();
    p.parseLine(userLine("hi"));
    const ev = p.parseLine(
      assistantLine({
        message: {
          role: "assistant",
          model: "some-unreleased-model-xyz",
          content: "ok",
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      }),
    )!;
    // Null means "unknown", which materiality treats differently from zero.
    // Guessing a price would be worse than admitting we don't have one.
    expect(ev.costUsd).toBeNull();
  });
});
