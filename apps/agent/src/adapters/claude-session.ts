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

/** Flatten Claude's content union (string | array of blocks) to plain text. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string") parts.push(b.text);
      else if (typeof b.content === "string") parts.push(b.content);
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
  let pendingPrompt = "";
  let priorPromptChars: number | undefined;

  return {
    parseLine(raw: string): UsageEvent | null {
      let line: ClaudeSessionLine;
      try {
        if (!raw.trim()) return null;
        line = JSON.parse(raw) as ClaudeSessionLine;
      } catch {
        return null;
      }

      if (line.type === "user") {
        pendingPrompt = contentToText(line.message?.content);
        return null;
      }

      if (line.type !== "assistant") return null;

      const usage = line.message?.usage;
      if (!usage) return null;

      const model = line.message?.model;
      const timestamp = line.timestamp;
      const uuid = line.uuid;
      if (!model || !timestamp || !uuid) return null;

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

      const responseText = contentToText(line.message?.content);
      const features = extractFeatures({
        model,
        requestMessages: [{ role: "user", content: pendingPrompt }],
        responseText,
        sessionPriorPromptChars: priorPromptChars,
      });
      features.modelTier = getModelTier(model);

      priorPromptChars = pendingPrompt.length;
      pendingPrompt = "";

      const eventId = buildEventId({
        machineId: opts.machineId,
        app: APP,
        providerRequestId: line.requestId,
        fingerprint: uuid,
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
      if (line.sessionId && line.isSidechain !== true) {
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
