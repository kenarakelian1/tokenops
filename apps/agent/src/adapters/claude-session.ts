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
     * `requestId`, and byte-identical `usage`. This is the id we coalesce
     * and fingerprint on.
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
  /** Returns an event for an assistant turn with usage; null for everything else. */
  parseLine(raw: string): UsageEvent | null;
};

/** Bounds recursion in contentToText against pathological/malformed nesting. */
const MAX_CONTENT_DEPTH = 8;

/**
 * Flatten Claude's content union (string | array of blocks) to plain text.
 *
 * `tool_result` blocks routinely carry their own `content` as an array of
 * blocks rather than a string (e.g. a file read's output) — that shape must
 * be recursed into, not dropped, or promptChars silently loses a third of
 * real prompt text (measured against real session files), which makes
 * full_document_io and context_bloat under-fire on exactly the file dumps
 * they exist to catch. Depth is bounded so a malformed or adversarially deep
 * line still returns partial text rather than hanging or blowing the stack.
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
      } else if (typeof b.content === "string") {
        parts.push(b.content);
      } else if (Array.isArray(b.content)) {
        parts.push(contentToText(b.content, depth + 1));
      }
    }
  }
  return parts.join("");
}

/**
 * Turn a session file's lines into usage events.
 *
 * Stateful by necessity: an `assistant` line carries the model's REPLY, while
 * `extractFeatures` needs the PROMPT. The prompt for a turn is the preceding
 * `user` line, so the parser carries it forward — along with the previous
 * turn's promptChars, which is what produces `newContentRatio`, the signal
 * `context_bloat` gates on.
 *
 * Feed lines in file order. A parser instance belongs to one file.
 */
export function createSessionParser(
  opts: SessionParserOptions,
): SessionParser {
  // Mainline and sidechain (subagent/Task-tool) turns are tracked with
  // separate prompt state. A subagent turn has its own independent context;
  // in real session files it's either isolated to its own subagents/*.jsonl
  // file, or (defensively, since the format isn't a published contract)
  // could be interleaved inline. Either way it must never overwrite the
  // mainline's pendingPrompt/priorPromptChars — that would corrupt the next
  // mainline turn's newContentRatio, which context_bloat gates on, with an
  // unrelated subagent prompt size. Each chain still gets its own prompt
  // correctly paired with its own reply.
  let pendingPrompt = "";
  let priorPromptChars: number | undefined;
  let pendingSidechainPrompt = "";
  let priorSidechainPromptChars: number | undefined;

  // Last-seen message.id per chain, for coalescing multi-block responses
  // into a single event (see the `message.id` doc comment above). Kept
  // separate per chain for the same reason pendingPrompt is: a sidechain
  // message.id must never suppress the next mainline line, or vice versa.
  let lastMessageId: string | undefined;
  let lastSidechainMessageId: string | undefined;

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

      const messageId = line.message?.id;

      // Coalesce: keep only the first line of each response. Lines 2..n of
      // the same message.id carry byte-identical usage, so nothing is lost
      // from the token counts by dropping them — and dropping them here,
      // before pendingPrompt is touched below, is what makes pendingPrompt
      // get consumed exactly once per response instead of once per line.
      const priorMessageId = isSidechain ? lastSidechainMessageId : lastMessageId;
      if (messageId !== undefined && messageId === priorMessageId) {
        return null;
      }
      if (isSidechain) {
        lastSidechainMessageId = messageId;
      } else {
        lastMessageId = messageId;
      }

      // Absent means "not recorded" and stays undefined on the event; a
      // recorded 0 stays 0. Folding uses ?? 0 for the TOTAL only — no cache
      // fields simply means no cache tokens contributed to it.
      const cacheReadTokens = usage.cache_read_input_tokens;
      const cacheCreationTokens = usage.cache_creation_input_tokens;
      const inputTokens =
        (usage.input_tokens ?? 0) +
        (cacheReadTokens ?? 0) +
        (cacheCreationTokens ?? 0);
      const outputTokens = usage.output_tokens ?? 0;

      // Deliberate trade-off: since only the first line of a multi-block
      // response is processed, responseText/features.responseChars reflects
      // only that first block, not the full reply. The alternative —
      // buffering blocks until the message boundary — needs a flush at
      // chunk end and at EOF, and a message split across a poll boundary
      // then has to survive in state the offset store doesn't carry. No
      // rule gates on responseChars; every rule gates on prompt-side
      // features and token counts, both of which this approach gets right.
      const responseText = contentToText(line.message?.content);
      const prompt = isSidechain ? pendingSidechainPrompt : pendingPrompt;
      const priorChars = isSidechain
        ? priorSidechainPromptChars
        : priorPromptChars;
      const features = extractFeatures({
        model,
        requestMessages: [{ role: "user", content: prompt }],
        responseText,
        sessionPriorPromptChars: priorChars,
      });
      features.modelTier = getModelTier(model);

      if (isSidechain) {
        priorSidechainPromptChars = prompt.length;
        pendingSidechainPrompt = "";
      } else {
        priorPromptChars = prompt.length;
        pendingPrompt = "";
      }

      // message.id identifies the real API response and is stable across
      // re-reads, unlike uuid (one per line). Fall back to uuid when
      // message.id is absent — the format isn't a published contract.
      const eventId = buildEventId({
        machineId: opts.machineId,
        app: APP,
        providerRequestId: line.requestId,
        fingerprint: messageId ?? uuid,
        timeBucketSec: Math.floor(Date.parse(timestamp) / 1000),
      });

      const event: UsageEvent = {
        eventId,
        timestamp,
        machineId: opts.machineId,
        machineName: opts.machineName,
        app: APP,
        provider: PROVIDER,
        model,
        inputTokens,
        outputTokens,
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
      if (line.sessionId && !isSidechain) {
        event.sessionId = line.sessionId;
      }
      if (cacheReadTokens !== undefined) {
        event.cacheReadTokens = cacheReadTokens;
      }
      if (cacheCreationTokens !== undefined) {
        event.cacheCreationTokens = cacheCreationTokens;
      }

      return event;
    },
  };
}
