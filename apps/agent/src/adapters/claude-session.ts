import {
  buildEventId,
  extractFeatures,
  getModelTier,
  type UsageEvent,
} from "@tokenops/shared";

const APP = "claude-code";
const PROVIDER = "anthropic";

/**
 * One line of a Claude Code session file. Every field is optional: the format
 * is not a published contract, so an unexpected shape must produce `null`
 * rather than a throw.
 */
export type ClaudeSessionLine = {
  type?: string;
  uuid?: string;
  requestId?: string;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    model?: string;
    /**
     * Identifies the real API response. Claude Code writes one JSONL line
     * per assistant *content block*, not per response — a text block plus
     * three tool_use blocks is four lines sharing one `message.id`, one
     * `requestId`, and identical *input*-side usage. This is the id we
     * coalesce and fingerprint on. `output_tokens` is NOT identical across
     * those lines — see the comment on `PendingMessage` below.
     */
    id?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
};

export type SessionParserOptions = {
  machineId: string;
  machineName: string;
};

export type SessionParser = {
  /** Returns an event for a completed assistant turn; null otherwise. */
  parseLine(raw: string): UsageEvent | null;
  /**
   * Drain the one message still buffered awaiting its next `message.id`
   * boundary, if any. Production (the watcher) never calls this — see the
   * "do not flush at EOF" trade-off documented on `createSessionParser`.
   * It exists so a one-shot parse of a finite fixture or file can still
   * observe its last message, which would otherwise sit unflushed forever.
   */
  flushPending(): UsageEvent | null;
};

/** Bounds recursion in contentToText against pathological/malformed nesting. */
const MAX_CONTENT_DEPTH = 8;

/**
 * Flatten Claude's content union (string | array of blocks) to plain text.
 *
 * Handles three block shapes seen in real transcripts:
 * - `{ text: string }` — a text block.
 * - `{ thinking: string }` — a thinking block. Thinking is routinely the
 *   FIRST block of a multi-block response; without this handler,
 *   responseChars measured only the first block (see PendingMessage) and
 *   came out 0 for the common case where that first block is thinking —
 *   84.6% of emitted events, measured against real session files.
 * - `{ content: string | array }` — a `tool_result` carrying its own
 *   nested content, string or array, which must be recursed into or
 *   promptChars silently loses a third of real prompt text, making
 *   full_document_io and context_bloat under-fire on exactly the file
 *   dumps they exist to catch.
 *
 * Not every block shape carries recoverable text. A `tool_result` whose
 * nested content is a bare `{ type: "tool_reference" }` — seen in real
 * subagent transcripts — has no text field and nothing to substitute; that
 * is a genuine data gap, not a bug, and is one known contributor to the
 * residual (~3.7%) of events with `promptChars === 0`.
 *
 * Depth is bounded so a malformed or adversarially deep line still returns
 * partial text rather than hanging or blowing the stack.
 */
function contentToText(content: unknown, depth = 0): string {
  if (depth > MAX_CONTENT_DEPTH) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string") {
        parts.push(b.text);
      } else if (typeof b.thinking === "string") {
        parts.push(b.thinking);
      } else if (typeof b.content === "string") {
        parts.push(b.content);
      } else if (Array.isArray(b.content)) {
        parts.push(contentToText(b.content, depth + 1));
      }
    }
  }
  return parts.join("");
}

type UsageFields = NonNullable<
  NonNullable<ClaudeSessionLine["message"]>["usage"]
>;

/**
 * A turn's data, captured once at its first block and (for output/response
 * text) accumulated as later blocks of the same message arrive. Shared
 * shape for both the buffered (`message.id` present) and the standalone
 * (`message.id` absent) path — see `captureTurn`/`buildEvent` below.
 */
type CapturedTurn = {
  isSidechain: boolean;
  model: string;
  timestamp: string;
  requestId?: string;
  sessionId?: string;
  responseText: string;
  /**
   * Corrected premise from round 1: input-side usage IS identical across a
   * message's blocks (0 divergence measured over 12,660 real multi-block
   * responses), but output_tokens is NOT — it climbs block-to-block as the
   * response is generated, and the LAST block's value equals the true
   * total in 8,449 of 8,449 measured cases. We track a running max instead
   * of "last" specifically so this is correct even if block ordering in a
   * file ever turned out not to be monotonic — max and last coincide
   * whenever it is.
   */
  maxOutputTokens: number;
  inputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  prompt: string;
  priorChars?: number;
};

/** A turn with a real `message.id`, sitting in the single-slot buffer. */
type PendingMessage = CapturedTurn & { messageId: string };

/**
 * Turn a session file's lines into usage events.
 *
 * Stateful by necessity, in two independent ways:
 *
 * 1. An `assistant` line carries the model's REPLY, while `extractFeatures`
 *    needs the PROMPT. The prompt for a turn is the preceding `user` line,
 *    so the parser carries it forward — along with the previous turn's
 *    promptChars, which is what produces `newContentRatio`, the signal
 *    `context_bloat` gates on. Mainline and sidechain (subagent/Task-tool)
 *    turns are tracked with separate prompt state: a subagent turn has its
 *    own independent context, and in real session files it's either
 *    isolated to its own subagents/*.jsonl file, or (defensively, since the
 *    format isn't a published contract) could be interleaved inline.
 *    Either way it must never overwrite the mainline's
 *    pendingPrompt/priorPromptChars with an unrelated subagent prompt size.
 *
 * 2. Claude Code writes one JSONL line per assistant *content block*, not
 *    per API response — a text block plus three tool_use blocks is four
 *    lines sharing one `message.id`. Round 1 of this fix kept only the
 *    first such line, on the premise that all of a message's lines carry
 *    byte-identical `usage`. That premise was verified for the input side
 *    (true) but never checked for output, and was false there:
 *    `output_tokens` differs across 35.2% of real multi-block messages,
 *    always increasing toward the final block's value. Keeping the first
 *    line therefore undercounted output tokens by ~27% in aggregate — the
 *    same class of silent ledger error round 1 fixed, pointed the other
 *    way. The fix here is to BUFFER a message's blocks — under one
 *    `messageId`-keyed slot, since chain-crossing (mainline vs sidechain)
 *    is itself always an id change too, so one slot suffices — and flush
 *    it (build its event) only once a DIFFERENT `message.id` proves the
 *    message is over. `responseText` accumulates every block seen so
 *    `responseChars` reflects the full reply, not just its first block.
 *
 *    Trade-off, deliberately accepted, with the cost MEASURED rather than
 *    assumed: a message is held until the NEXT message's first block
 *    arrives, never at end-of-file or end-of-poll. The parser instance
 *    (and so the buffered message) survives across polls in the real
 *    watcher, so an in-flight message just waits — seconds, in a live
 *    session — for its own boundary.
 *
 *    The cost is that the LAST message of a file is never emitted, because
 *    no later message ever arrives to close it. Measured over 120 real
 *    session files: 6,393 of 6,513 messages emitted (98.2%), 99.2% of
 *    input tokens and 93.6% of output tokens. Output suffers more because
 *    a session's final message tends to be a large one.
 *
 *    An earlier attempt closed that gap by flushing when the watcher found
 *    a file unchanged since the previous scan ("idle ⇒ complete"). It was
 *    reverted: idleness means "nothing arrived in the last poll", NOT
 *    "the message is finished", and a message's blocks are separated by
 *    TOOL EXECUTION, which routinely outlasts the 5s poll. 6,199 of 38,763
 *    real messages have an internal gap >5s. The flush therefore split
 *    ~34% of messages in two, and since input usage is byte-identical
 *    across a message's blocks — the very property that makes coalescing
 *    safe — both halves carried the FULL input, double-counting it 2.00x.
 *    Static replay of finished files reports 100% correct for that broken
 *    variant, because the failure needs a partial message on disk.
 *
 *    So: a known, bounded, one-directional under-count is preferred over
 *    an unbounded over-count that verification cannot see. Closing the gap
 *    properly needs a delta-emit on a reappearing message.id (so a split
 *    is harmless rather than prevented) plus a replay harness that stages
 *    writes in recorded timestamp order. Neither exists yet.
 *
 *    `flushPending` exists solely so a one-shot parse (tests, an offline
 *    audit) can still observe that last message — production never calls
 *    it, and must not without the delta-emit above.
 *
 *    A line whose `message.id` is absent (rare; the format isn't a
 *    contract) can't be matched against anything, so it is treated as a
 *    complete, standalone turn and emitted immediately — and, since it can
 *    never be the continuation OR the boundary of a real buffered message,
 *    it does not touch whatever is currently buffered.
 *
 * Feed lines in file order. A parser instance belongs to one file.
 */
export function createSessionParser(
  opts: SessionParserOptions,
): SessionParser {
  let pendingPrompt = "";
  let priorPromptChars: number | undefined;
  let pendingSidechainPrompt = "";
  let priorSidechainPromptChars: number | undefined;

  // At most one message is ever "in flight": mainline and sidechain turns
  // share this one slot because a chain switch is always also a
  // message.id change, so it already forces a flush on its own — a second,
  // chain-keyed slot would never hold anything the id check didn't already
  // catch.
  let pending: PendingMessage | undefined;

  /** Capture a turn's data from its first block, consuming this chain's
   *  pending prompt exactly once in the process. */
  function captureTurn(
    line: ClaudeSessionLine,
    isSidechain: boolean,
    usage: UsageFields,
    model: string,
    timestamp: string,
  ): CapturedTurn {
    const prompt = isSidechain ? pendingSidechainPrompt : pendingPrompt;
    const priorChars = isSidechain
      ? priorSidechainPromptChars
      : priorPromptChars;
    if (isSidechain) {
      priorSidechainPromptChars = prompt.length;
      pendingSidechainPrompt = "";
    } else {
      priorPromptChars = prompt.length;
      pendingPrompt = "";
    }

    // Absent means "not recorded" and stays undefined on the event; a
    // recorded 0 stays 0. Folding uses ?? 0 for the TOTAL only — no cache
    // fields simply means no cache tokens contributed to it. Identical
    // across a message's blocks (measured), so capturing once at the first
    // block is correct for the life of the message.
    const cacheReadTokens = usage.cache_read_input_tokens;
    const cacheCreationTokens = usage.cache_creation_input_tokens;
    const inputTokens =
      (usage.input_tokens ?? 0) +
      (cacheReadTokens ?? 0) +
      (cacheCreationTokens ?? 0);

    return {
      isSidechain,
      model,
      timestamp,
      requestId: line.requestId,
      sessionId: line.sessionId,
      responseText: contentToText(line.message?.content),
      maxOutputTokens: usage.output_tokens ?? 0,
      inputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      prompt,
      priorChars,
    };
  }

  function buildEvent(turn: CapturedTurn, fingerprint: string): UsageEvent {
    const features = extractFeatures({
      model: turn.model,
      requestMessages: [{ role: "user", content: turn.prompt }],
      responseText: turn.responseText,
      sessionPriorPromptChars: turn.priorChars,
    });
    features.modelTier = getModelTier(turn.model);

    // message.id identifies the real API response and is stable across
    // re-reads, unlike uuid (one per line). Fall back to uuid when
    // message.id is absent — the format isn't a published contract.
    const eventId = buildEventId({
      machineId: opts.machineId,
      app: APP,
      providerRequestId: turn.requestId,
      fingerprint,
      timeBucketSec: Math.floor(Date.parse(turn.timestamp) / 1000),
    });

    const event: UsageEvent = {
      eventId,
      timestamp: turn.timestamp,
      machineId: opts.machineId,
      machineName: opts.machineName,
      app: APP,
      provider: PROVIDER,
      model: turn.model,
      inputTokens: turn.inputTokens,
      outputTokens: turn.maxOutputTokens,
      costUsd: null,
      grain: "request",
      features,
      hasContent: false,
    };

    // A subagent turn shares the parent's sessionId but has its own
    // independent context. Interleaving it would corrupt context_bloat,
    // whose measurement is "input grew relative to the session's FIRST
    // request". Omitting sessionId lets contextBloatRule's existing guard
    // exclude it, while the tokens still reach the ledger as real spend.
    if (turn.sessionId && !turn.isSidechain) {
      event.sessionId = turn.sessionId;
    }
    if (turn.cacheReadTokens !== undefined) {
      event.cacheReadTokens = turn.cacheReadTokens;
    }
    if (turn.cacheCreationTokens !== undefined) {
      event.cacheCreationTokens = turn.cacheCreationTokens;
    }

    return event;
  }

  return {
    parseLine(raw: string): UsageEvent | null {
      let line: ClaudeSessionLine;
      try {
        if (!raw.trim()) return null;
        line = JSON.parse(raw) as ClaudeSessionLine;
      } catch {
        return null;
      }

      // Verified against real session files: every line belonging to a
      // subagent turn — including `user` lines — reliably carries
      // `isSidechain: true`, so this is a safe, non-guessed signal.
      const isSidechain = line.isSidechain === true;

      if (line.type === "user") {
        if (isSidechain) {
          pendingSidechainPrompt = contentToText(line.message?.content);
        } else {
          pendingPrompt = contentToText(line.message?.content);
        }
        return null;
      }

      if (line.type !== "assistant") return null;

      const usage = line.message?.usage;
      if (!usage) return null;

      const model = line.message?.model;
      const timestamp = line.timestamp;
      const uuid = line.uuid;
      if (!model || !timestamp || !uuid) return null;

      // `!= null` (not `!== undefined`) so a `message.id: null` line is
      // treated identically to an absent one everywhere it's checked —
      // fingerprinting, the continuation check, and the buffer-start
      // below all agree on what "absent" means.
      const messageId = line.message?.id != null ? line.message.id : undefined;

      if (messageId === undefined) {
        // Can't be matched against anything (no id to compare), so it's a
        // complete, standalone turn on its own — and, since nothing can
        // ever confirm it as that message's continuation either, it must
        // not disturb whatever real message is currently buffered.
        const turn = captureTurn(line, isSidechain, usage, model, timestamp);
        return buildEvent(turn, uuid);
      }

      if (
        pending &&
        pending.messageId === messageId &&
        pending.isSidechain === isSidechain
      ) {
        // Another block of the message already buffered: merge, don't emit.
        pending.responseText += contentToText(line.message?.content);
        const out = usage.output_tokens ?? 0;
        if (out > pending.maxOutputTokens) pending.maxOutputTokens = out;
        return null;
      }

      // A different message.id (or nothing buffered yet) proves the
      // previously-buffered message, if any, is complete — flush it now,
      // then start buffering this one.
      const flushed = pending
        ? buildEvent(pending, pending.messageId)
        : null;
      const turn = captureTurn(line, isSidechain, usage, model, timestamp);
      pending = { ...turn, messageId };
      return flushed;
    },

    flushPending(): UsageEvent | null {
      if (!pending) return null;
      const event = buildEvent(pending, pending.messageId);
      pending = undefined;
      return event;
    },
  };
}
