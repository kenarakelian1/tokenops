import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  watch as fsWatch,
  type FSWatcher,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  buildEventId,
  estimateCostUsd,
  extractFeatures,
  type UsageEvent,
} from "@tokenops/shared";

const APP = "claude-code";
const PROVIDER = "anthropic";

/** Raw JSONL line shape (Phase 1 locked fields + optional snake_case aliases). */
export type ClaudeCodeLogLine = {
  timestamp?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  sessionId?: string;
  requestPreview?: string;
  responsePreview?: string;
  input_tokens?: number;
  output_tokens?: number;
  session_id?: string;
  request_preview?: string;
  response_preview?: string;
};

export type ClaudeCodeParseOptions = {
  machineId?: string;
  machineName?: string;
};

function nonNegNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parse one Claude Code usage JSONL line into a UsageEvent.
 * Returns null for blank lines, comments, malformed JSON, or missing required fields.
 */
export function parseClaudeCodeLine(
  line: string,
  opts: ClaudeCodeParseOptions = {},
): UsageEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const o = raw as ClaudeCodeLogLine;
  const model = asOptionalString(o.model);
  const inputTokens = nonNegNumber(o.inputTokens ?? o.input_tokens);
  const outputTokens = nonNegNumber(o.outputTokens ?? o.output_tokens);
  if (!model || inputTokens == null || outputTokens == null) return null;

  const timestamp =
    asOptionalString(o.timestamp) ?? new Date().toISOString();
  const sessionId =
    asOptionalString(o.sessionId) ?? asOptionalString(o.session_id);
  const requestPreview =
    asOptionalString(o.requestPreview) ??
    asOptionalString(o.request_preview);
  const responsePreview =
    asOptionalString(o.responsePreview) ??
    asOptionalString(o.response_preview);

  const machineId = opts.machineId ?? "local";
  const machineName = opts.machineName ?? "local";

  const requestMessages =
    requestPreview != null
      ? [{ role: "user", content: requestPreview }]
      : [];
  const features = extractFeatures({
    model,
    requestMessages,
    responseText: responsePreview ?? "",
  });

  const parsedMs = Date.parse(timestamp);
  const timeBucketSec = Math.floor(
    (Number.isFinite(parsedMs) ? parsedMs : Date.now()) / 1000,
  );

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        model,
        inputTokens,
        outputTokens,
        sessionId: sessionId ?? "",
        timestamp,
        requestPreview: requestPreview ?? "",
        responsePreview: responsePreview ?? "",
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);

  const eventId = buildEventId({
    machineId,
    app: APP,
    fingerprint,
    timeBucketSec,
  });

  const costUsd = estimateCostUsd(model, inputTokens, outputTokens);
  const hasContent = Boolean(requestPreview || responsePreview);

  const event: UsageEvent = {
    eventId,
    timestamp,
    machineId,
    machineName,
    app: APP,
    provider: PROVIDER,
    model,
    inputTokens,
    outputTokens,
    costUsd,
    features,
    hasContent,
  };

  if (sessionId) event.sessionId = sessionId;
  if (hasContent) {
    event.content = {
      ...(requestPreview != null
        ? { requestBody: { preview: requestPreview } }
        : {}),
      ...(responsePreview != null
        ? { responseBody: { preview: responsePreview } }
        : {}),
    };
  }

  return event;
}

/** Parse a multi-line JSONL blob into UsageEvents (skips invalid lines). */
export function parseClaudeCodeLog(
  text: string,
  opts: ClaudeCodeParseOptions = {},
): UsageEvent[] {
  const events: UsageEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const event = parseClaudeCodeLine(line, opts);
    if (event) events.push(event);
  }
  return events;
}

export type WatchClaudeCodeLogOptions = ClaudeCodeParseOptions & {
  /**
   * When true, emit events for existing file content then continue tailing.
   * Default false: start at EOF (live append-only).
   */
  fromStart?: boolean;
  /** Poll interval for append detection (ms). Default 250. */
  pollIntervalMs?: number;
};

/**
 * Resolve watch path: a `.jsonl` file, or a directory → `claude-code-usage.jsonl` inside it.
 */
export function resolveClaudeCodeLogPath(path: string): string {
  try {
    if (existsSync(path) && statSync(path).isDirectory()) {
      return join(path, "claude-code-usage.jsonl");
    }
  } catch {
    // fall through
  }
  return path;
}

/**
 * Append-only JSONL tailer. Calls `onEvent` for each valid new line.
 * Safe if the file does not exist yet (waits / polls until created).
 */
export function watchClaudeCodeLog(
  path: string,
  onEvent: (event: UsageEvent) => void,
  opts: WatchClaudeCodeLogOptions = {},
): { close: () => void } {
  const logPath = resolveClaudeCodeLogPath(path);
  const machineOpts: ClaudeCodeParseOptions = {
    machineId: opts.machineId ?? "local",
    machineName: opts.machineName ?? "local",
  };
  const pollIntervalMs = opts.pollIntervalMs ?? 250;
  const fromStart = opts.fromStart ?? false;

  let closed = false;
  let offset = 0;
  let buffer = "";
  let initialized = false;
  let watcher: FSWatcher | null = null;
  let watchingDir: string | null = null;

  const processChunk = (chunk: string): void => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      const event = parseClaudeCodeLine(line, machineOpts);
      if (event) onEvent(event);
    }
  };

  const ensureWatcher = (): void => {
    if (closed || watcher) return;
    const parent = dirname(logPath);
    const target = existsSync(logPath)
      ? logPath
      : existsSync(parent)
        ? parent
        : null;
    if (!target) return;
    try {
      watcher = fsWatch(target, () => {
        readNew();
      });
      watchingDir = target;
    } catch {
      // polling-only fallback
    }
  };

  const readNew = (): void => {
    if (closed) return;
    if (!existsSync(logPath)) return;

    try {
      const st = statSync(logPath);
      if (!st.isFile()) return;

      if (!initialized) {
        offset = fromStart ? 0 : st.size;
        initialized = true;
        ensureWatcher();
        if (!fromStart || st.size === 0) {
          // Tail mode: wait for appends. fromStart with empty file: same.
          if (!fromStart) return;
          if (st.size === 0) return;
        }
      }

      if (st.size < offset) {
        // File truncated / rotated
        offset = 0;
        buffer = "";
      }
      if (st.size === offset) return;

      const fd = openSync(logPath, "r");
      try {
        const len = st.size - offset;
        const buf = Buffer.alloc(len);
        const bytesRead = readSync(fd, buf, 0, len, offset);
        offset += bytesRead;
        processChunk(buf.subarray(0, bytesRead).toString("utf8"));
      } finally {
        closeSync(fd);
      }
    } catch {
      // Race: file removed mid-read
    }
  };

  // First attempt + parent watcher if file not present yet
  ensureWatcher();
  readNew();

  const timer = setInterval(() => {
    if (!initialized) ensureWatcher();
    // Re-bind watcher if we were only watching parent and file appeared
    if (
      initialized &&
      watcher &&
      watchingDir &&
      watchingDir !== logPath &&
      existsSync(logPath)
    ) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
      watcher = null;
      watchingDir = null;
      ensureWatcher();
    }
    readNew();
  }, pollIntervalMs);
  timer.unref?.();

  return {
    close: () => {
      closed = true;
      clearInterval(timer);
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
        watcher = null;
      }
    },
  };
}
