import { createHash } from "node:crypto";
import {
  buildEventId,
  estimateCostUsd,
  extractFeatures,
  type UsageEvent,
} from "@tokenops/shared";

/** Default app label when upstream is not recognized. */
export const APP_OPENAI_PROXY = "openai-proxy";
/** App label for xAI / Grok traffic through the local proxy. */
export const APP_GROK_PROXY = "grok-proxy";

export type ChatCompletionRequest = {
  model?: string;
  messages?: Array<{ role: string; content: unknown }>;
  stream?: boolean;
  [key: string]: unknown;
};

export type UpstreamUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type ChatCompletionResponse = {
  id?: string;
  choices?: Array<{
    message?: { role?: string; content?: unknown };
    delta?: { content?: unknown };
  }>;
  usage?: UpstreamUsage;
  [key: string]: unknown;
};

/** True when upstream points at xAI (Grok API). */
export function isXaiUpstream(upstream: string): boolean {
  try {
    const host = new URL(upstream).hostname.toLowerCase();
    return host === "api.x.ai" || host.endsWith(".x.ai");
  } catch {
    return /x\.ai/i.test(upstream);
  }
}

/** Provider label from upstream base URL host. */
export function providerFromUpstream(upstream: string): string {
  try {
    const host = new URL(upstream).hostname.toLowerCase();
    if (host === "api.openai.com" || host.endsWith(".openai.com")) {
      return "openai";
    }
    if (isXaiUpstream(upstream)) return "xai";
    if (host.includes("anthropic")) return "anthropic";
    if (host.includes("azure")) return "azure-openai";
    return host || "unknown";
  } catch {
    return "unknown";
  }
}

/** Ledger `app` field for a proxy hop. */
export function appFromUpstream(upstream: string): string {
  return isXaiUpstream(upstream) ? APP_GROK_PROXY : APP_OPENAI_PROXY;
}

/**
 * Resolve upstream API key from env for the configured host.
 * xAI: XAI_API_KEY, then OPENAI_API_KEY (compat).
 * Others: OPENAI_API_KEY, then XAI_API_KEY (compat).
 */
export function resolveUpstreamApiKey(
  upstream: string,
  env: NodeJS.ProcessEnv = process.env,
): { apiKey: string; source: "XAI_API_KEY" | "OPENAI_API_KEY" | "none" } {
  const xai = (env.XAI_API_KEY ?? "").trim();
  const openai = (env.OPENAI_API_KEY ?? "").trim();
  if (isXaiUpstream(upstream)) {
    if (xai) return { apiKey: xai, source: "XAI_API_KEY" };
    if (openai) return { apiKey: openai, source: "OPENAI_API_KEY" };
    return { apiKey: "", source: "none" };
  }
  if (openai) return { apiKey: openai, source: "OPENAI_API_KEY" };
  if (xai) return { apiKey: xai, source: "XAI_API_KEY" };
  return { apiKey: "", source: "none" };
}

/** Normalize common upstream bases (ensure /v1 for xAI when missing). */
export function normalizeUpstreamBase(upstream: string): string {
  const base = upstream.replace(/\/$/, "");
  if (isXaiUpstream(base) && !/\/v1$/i.test(base)) {
    return `${base}/v1`;
  }
  return base;
}

/** Rough token estimate when usage is missing: chars / 4. */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(0, Math.ceil(text.length / 4));
}

function flattenMessageContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const t = (part as { text: unknown }).text;
          return typeof t === "string" ? t : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

export function promptTextFromMessages(
  messages: Array<{ role: string; content: unknown }> | undefined,
): string {
  if (!messages?.length) return "";
  return messages.map((m) => flattenMessageContent(m.content)).join("");
}

export function responseTextFromBody(body: ChatCompletionResponse): string {
  const choices = body.choices ?? [];
  const parts: string[] = [];
  for (const c of choices) {
    if (c.message?.content != null) {
      parts.push(flattenMessageContent(c.message.content));
    } else if (c.delta?.content != null) {
      parts.push(flattenMessageContent(c.delta.content));
    }
  }
  return parts.join("");
}

export function fingerprintRequest(
  model: string,
  messages: unknown,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ model, messages }), "utf8")
    .digest("hex")
    .slice(0, 32);
}

/**
 * Optional session correlation from common client fields.
 * Supports session_id / sessionId, metadata.session_id, and OpenAI `user`.
 */
export function sessionIdFromRequest(
  body: ChatCompletionRequest,
): string | undefined {
  if (typeof body.session_id === "string" && body.session_id) {
    return body.session_id;
  }
  if (typeof body.sessionId === "string" && body.sessionId) {
    return body.sessionId;
  }
  const meta = body.metadata;
  if (meta && typeof meta === "object") {
    const m = meta as Record<string, unknown>;
    if (typeof m.session_id === "string" && m.session_id) return m.session_id;
    if (typeof m.sessionId === "string" && m.sessionId) return m.sessionId;
  }
  if (typeof body.user === "string" && body.user) {
    return body.user;
  }
  return undefined;
}

export type BuildUsageEventInput = {
  machineId: string;
  machineName: string;
  upstream: string;
  requestBody: ChatCompletionRequest;
  responseBody: ChatCompletionResponse | null;
  /** When streaming, accumulated assistant text and optional usage. */
  streamAccum?: {
    text: string;
    usage?: UpstreamUsage;
    id?: string;
  };
  latencyMs: number;
  timestamp?: string;
};

/**
 * Build a UsageEvent from a proxied chat completion.
 * Attaches content bodies for the caller to privacy-gate before outbox.
 * Never includes upstream API keys.
 */
export function buildUsageEvent(input: BuildUsageEventInput): UsageEvent {
  const model =
    typeof input.requestBody.model === "string" && input.requestBody.model
      ? input.requestBody.model
      : "unknown";
  const messages = Array.isArray(input.requestBody.messages)
    ? input.requestBody.messages
    : [];

  const promptText = promptTextFromMessages(messages);

  let responseText = "";
  let usage: UpstreamUsage | undefined;
  let providerRequestId: string | undefined;

  if (input.responseBody) {
    responseText = responseTextFromBody(input.responseBody);
    usage = input.responseBody.usage;
    providerRequestId =
      typeof input.responseBody.id === "string"
        ? input.responseBody.id
        : undefined;
  } else if (input.streamAccum) {
    responseText = input.streamAccum.text;
    usage = input.streamAccum.usage;
    providerRequestId = input.streamAccum.id;
  }

  const inputTokens =
    typeof usage?.prompt_tokens === "number"
      ? usage.prompt_tokens
      : estimateTokensFromText(promptText);
  const outputTokens =
    typeof usage?.completion_tokens === "number"
      ? usage.completion_tokens
      : estimateTokensFromText(responseText);

  const features = extractFeatures({
    model,
    requestMessages: messages,
    responseText,
  });

  const timestamp = input.timestamp ?? new Date().toISOString();
  const timeBucketSec = Math.floor(Date.parse(timestamp) / 1000);
  const fingerprint = fingerprintRequest(model, messages);

  const app = appFromUpstream(input.upstream);
  const eventId = buildEventId({
    machineId: input.machineId,
    app,
    providerRequestId,
    fingerprint,
    timeBucketSec,
  });

  const costUsd = estimateCostUsd(model, inputTokens, outputTokens);
  const sessionId = sessionIdFromRequest(input.requestBody);

  // Content retained on event for local privacy gate; ship path strips as needed.
  const content = {
    requestBody: input.requestBody as unknown,
    responseBody: (input.responseBody ?? {
      id: providerRequestId,
      choices: [{ message: { role: "assistant", content: responseText } }],
      usage,
    }) as unknown,
  };

  const event: UsageEvent = {
    eventId,
    timestamp,
    machineId: input.machineId,
    machineName: input.machineName,
    app,
    provider: providerFromUpstream(input.upstream),
    model,
    inputTokens,
    outputTokens,
    costUsd,
    latencyMs: input.latencyMs,
    features,
    hasContent: true,
    content,
  };
  if (sessionId) {
    event.sessionId = sessionId;
  }

  return event;
}

/**
 * Best-effort parse of OpenAI SSE stream for assistant text + final usage.
 */
export function parseSseUsage(sseText: string): {
  text: string;
  usage?: UpstreamUsage;
  id?: string;
} {
  let text = "";
  let usage: UpstreamUsage | undefined;
  let id: string | undefined;

  const lines = sseText.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const chunk = JSON.parse(data) as ChatCompletionResponse;
      if (typeof chunk.id === "string" && !id) id = chunk.id;
      if (chunk.usage) usage = chunk.usage;
      const piece = responseTextFromBody(chunk);
      if (piece) text += piece;
    } catch {
      // ignore malformed SSE lines
    }
  }

  return { text, usage, id };
}
