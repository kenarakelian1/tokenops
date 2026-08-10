/**
 * OTLP HTTP metrics receiver for Claude Code telemetry.
 *
 * Claude Code exports:
 *   claude_code.token.usage  (counter, attrs: type=input|output|cacheRead|cacheCreation, model)
 *   claude_code.cost.usage   (counter, USD, attrs: model)
 *
 * Point Claude Code at this agent (HTTP, not gRPC):
 *
 *   CLAUDE_CODE_ENABLE_TELEMETRY=1
 *   OTEL_METRICS_EXPORTER=otlp
 *   OTEL_EXPORTER_OTLP_PROTOCOL=http/json
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
 *
 * Then: claude
 */

import http from "node:http";
import { createHash } from "node:crypto";
import {
  buildEventId,
  estimateCostUsd,
  getModelTier,
  type UsageEvent,
} from "@tokenops/shared";

const APP = "claude-code";
const PROVIDER = "anthropic";

export type ClaudeOtelServerOptions = {
  listen: string; // host:port e.g. 127.0.0.1:4318
  machineId: string;
  machineName: string;
  onEvent: (event: UsageEvent) => void;
  /**
   * Drop every `claude_code.*` metric at the receiver. Set when the
   * session-JSONL adapter owns Claude Code capture, so the same turns are
   * never ingested twice — a doubled ledger is the one failure this cutover
   * cannot recover from. The OTLP receiver keeps working for every other
   * emitter (Codex, Gemini, anything else pointed at it via a collector).
   */
  ignoreClaudeCodeMetrics?: boolean;
};

type AttrMap = Record<string, string>;

function attrString(
  attrs: Array<{ key?: string; value?: Record<string, unknown> }> | undefined,
  key: string,
): string | undefined {
  if (!attrs) return undefined;
  for (const a of attrs) {
    if (a.key !== key) continue;
    const v = a.value;
    if (!v) return undefined;
    if (typeof v.stringValue === "string") return v.stringValue;
    if (typeof v.string_value === "string") return v.string_value as string;
  }
  return undefined;
}

function dataPointValue(dp: Record<string, unknown>): number {
  if (typeof dp.asDouble === "number") return dp.asDouble;
  if (typeof dp.asInt === "string") return Number(dp.asInt);
  if (typeof dp.asInt === "number") return dp.asInt;
  if (typeof dp.as_double === "number") return dp.as_double as number;
  if (typeof dp.as_int === "string" || typeof dp.as_int === "number") {
    return Number(dp.as_int);
  }
  return 0;
}

function dataPointAttrs(dp: Record<string, unknown>): AttrMap {
  const raw = (dp.attributes ?? dp.Attributes) as
    | Array<{ key?: string; value?: Record<string, unknown> }>
    | undefined;
  const out: AttrMap = {};
  if (!raw) return out;
  for (const a of raw) {
    if (!a.key) continue;
    const s = attrString([a], a.key);
    if (s != null) out[a.key] = s;
  }
  return out;
}

export type ParsedTokenDelta = {
  model: string;
  type: string;
  delta: number;
};

export type ParsedCostDelta = {
  model: string;
  deltaUsd: number;
};

export type ExtractCountersOptions = {
  /**
   * Drop every `claude_code.*` metric. Set when the session-JSONL adapter
   * owns Claude Code capture.
   *
   * Both sources ingesting the same turns is the one failure this cutover
   * cannot recover from — a gap is re-readable from disk, a doubled ledger is
   * not. Enforcing it here rather than in config resolution means it is not a
   * state a user can configure their way into.
   */
  ignoreClaudeCodeMetrics?: boolean;
};

/**
 * Whether this OTLP metric belongs to the source the session-JSONL adapter
 * owns. Prefix-scoped on purpose: a substring match would also swallow an
 * unrelated emitter whose name merely CONTAINS "claude_code".
 *
 * Exported so the scoping is directly testable — it cannot be observed
 * through extractClaudeCounters, which only ever collects on exact name
 * equality, so a wrongly-dropped foreign metric and a correctly-ignored one
 * are indistinguishable in its output.
 */
export function shouldDropMetric(
  name: string,
  options: ExtractCountersOptions,
): boolean {
  return Boolean(options.ignoreClaudeCodeMetrics) && name.startsWith("claude_code.");
}

/**
 * Parse OTLP ExportMetricsServiceRequest (JSON) and return cumulative counter values.
 * Caller tracks previous values to compute deltas.
 */
export function extractClaudeCounters(
  body: unknown,
  options: ExtractCountersOptions = {},
): {
  tokens: Array<{ key: string; model: string; type: string; value: number }>;
  costs: Array<{ key: string; model: string; value: number }>;
} {
  const tokens: Array<{
    key: string;
    model: string;
    type: string;
    value: number;
  }> = [];
  const costs: Array<{ key: string; model: string; value: number }> = [];

  const root = body as {
    resourceMetrics?: unknown[];
    resource_metrics?: unknown[];
  };
  const resourceMetrics = (root.resourceMetrics ??
    root.resource_metrics ??
    []) as Array<Record<string, unknown>>;

  for (const rm of resourceMetrics) {
    const scopeMetrics = (rm.scopeMetrics ??
      rm.scope_metrics ??
      []) as Array<Record<string, unknown>>;
    for (const sm of scopeMetrics) {
      const metrics = (sm.metrics ?? []) as Array<Record<string, unknown>>;
      for (const m of metrics) {
        const name = String(m.name ?? "");
        if (shouldDropMetric(name, options)) {
          continue;
        }
        const sum = (m.sum ?? m.gauge) as Record<string, unknown> | undefined;
        if (!sum) continue;
        const dps = (sum.dataPoints ??
          sum.data_points ??
          []) as Array<Record<string, unknown>>;
        for (const dp of dps) {
          const attrs = dataPointAttrs(dp);
          const value = dataPointValue(dp);
          const model = attrs.model ?? attrs["gen_ai.request.model"] ?? "unknown";
          if (name === "claude_code.token.usage") {
            const type = attrs.type ?? "unknown";
            tokens.push({
              key: `${model}|${type}`,
              model,
              type,
              value,
            });
          } else if (name === "claude_code.cost.usage") {
            costs.push({
              key: model,
              model,
              value,
            });
          }
        }
      }
    }
  }

  return { tokens, costs };
}

/**
 * Stateful converter: cumulative counters → UsageEvent deltas.
 */
export class ClaudeOtelState {
  private lastTokens = new Map<string, number>();
  private lastCosts = new Map<string, number>();
  /** Buffer token deltas by model until we flush an event. */
  private pending = new Map<
    string,
    { input: number; output: number; cacheRead: number; cacheCreation: number }
  >();

  constructor(
    private readonly machineId: string,
    private readonly machineName: string,
    private readonly extractOptions: ExtractCountersOptions = {},
  ) {}

  /** Ingest one OTLP metrics export; returns zero or more usage events. */
  ingest(body: unknown): UsageEvent[] {
    const { tokens, costs } = extractClaudeCounters(body, this.extractOptions);
    const costDeltas = new Map<string, number>();

    for (const t of tokens) {
      const prev = this.lastTokens.get(t.key) ?? 0;
      const delta = t.value - prev;
      this.lastTokens.set(t.key, t.value);
      if (delta <= 0 || !Number.isFinite(delta)) continue;

      let bucket = this.pending.get(t.model);
      if (!bucket) {
        bucket = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
        this.pending.set(t.model, bucket);
      }
      const typ = t.type.toLowerCase();
      if (typ === "input" || typ === "input_tokens") bucket.input += delta;
      else if (typ === "output" || typ === "output_tokens") bucket.output += delta;
      else if (typ === "cacheread" || typ === "cache_read" || typ === "cache.read") {
        bucket.cacheRead += delta;
      } else if (
        typ === "cachecreation" ||
        typ === "cache_creation" ||
        typ === "cache.creation"
      ) {
        bucket.cacheCreation += delta;
      } else {
        // Unknown type: count as input so tokens are not dropped
        bucket.input += delta;
      }
    }

    for (const c of costs) {
      const prev = this.lastCosts.get(c.key) ?? 0;
      const delta = c.value - prev;
      this.lastCosts.set(c.key, c.value);
      if (delta > 0 && Number.isFinite(delta)) {
        costDeltas.set(c.model, (costDeltas.get(c.model) ?? 0) + delta);
      }
    }

    const events: UsageEvent[] = [];
    const models = new Set([
      ...this.pending.keys(),
      ...costDeltas.keys(),
    ]);

    for (const model of models) {
      const bucket = this.pending.get(model) ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
      };
      // Cache is still folded into input for ledger totals (matches spend
      // reality) — this must never change, or every historical spend/token
      // total shifts silently. cacheReadTokens/cacheCreationTokens below are
      // additional detail, not a redefinition of inputTokens.
      //
      // Round each component first, then sum the rounded components for
      // inputTokens (rather than rounding the raw-float sum independently).
      // Otherwise fractional counters — unreachable today since Claude Code's
      // token.usage deltas are always integers, but reachable in principle
      // via the asDouble decoding branch — could round cacheRead+cacheCreation
      // up past a separately-rounded inputTokens, letting a downstream
      // cacheReadTokens / inputTokens ratio exceed 1.
      const roundedInput = Math.round(bucket.input);
      const cacheReadTokens = Math.round(bucket.cacheRead);
      const cacheCreationTokens = Math.round(bucket.cacheCreation);
      const inputTokens = roundedInput + cacheReadTokens + cacheCreationTokens;
      const outputTokens = Math.round(bucket.output);
      if (inputTokens <= 0 && outputTokens <= 0 && !costDeltas.has(model)) {
        continue;
      }

      this.pending.delete(model);

      const timestamp = new Date().toISOString();
      const timeBucketSec = Math.floor(Date.now() / 1000);
      const fingerprint = createHash("sha256")
        .update(`${model}|${inputTokens}|${outputTokens}|${timestamp}`)
        .digest("hex")
        .slice(0, 32);

      // No requestMessages: OTEL gives token counters, not prompts. Deriving
      // promptChars/messageCount/largePasteScore from a placeholder string is
      // what made frontier_trivial fire on export windows. modelTier is real —
      // it comes from the model name.
      const features = { modelTier: getModelTier(model) };

      let costUsd = costDeltas.get(model) ?? null;
      if (costUsd == null) {
        // cacheReadTokens/cacheCreationTokens are already folded into
        // inputTokens above (ledger totals); pass them again here so
        // estimateCostUsd can price them at their own cache multipliers
        // instead of the full input rate.
        costUsd = estimateCostUsd(model, inputTokens, outputTokens, undefined, undefined, {
          cacheReadTokens,
          cacheCreationTokens,
        });
      }

      const event: UsageEvent = {
        eventId: buildEventId({
          machineId: this.machineId,
          app: APP,
          fingerprint,
          timeBucketSec,
        }),
        timestamp,
        machineId: this.machineId,
        machineName: this.machineName,
        app: APP,
        provider: PROVIDER,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        costUsd,
        grain: "aggregate",
        features,
        hasContent: false,
      };
      events.push(event);
    }

    return events;
  }
}

export function parseListen(listen: string): { host: string; port: number } {
  const idx = listen.lastIndexOf(":");
  if (idx <= 0) throw new Error(`Invalid listen address: ${listen}`);
  const host = listen.slice(0, idx);
  const port = Number(listen.slice(idx + 1));
  if (!Number.isFinite(port) || port < 0) {
    throw new Error(`Invalid port in listen address: ${listen}`);
  }
  return { host, port };
}

/**
 * Start OTLP HTTP metrics receiver (ExportMetricsServiceRequest JSON).
 * Accepts POST /v1/metrics and POST / (common collector paths).
 */
export async function startClaudeOtelServer(
  opts: ClaudeOtelServerOptions,
): Promise<http.Server> {
  const { host, port } = parseListen(opts.listen);
  const state = new ClaudeOtelState(opts.machineId, opts.machineName, {
    ignoreClaudeCodeMetrics: opts.ignoreClaudeCodeMetrics,
  });

  if (opts.ignoreClaudeCodeMetrics) {
    console.info(
      "[tokenops] otel: claude_code.* metrics ignored — session JSONL adapter owns this source",
    );
  }

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "tokenops-otel-metrics" }));
      return;
    }

    if (
      req.method === "POST" &&
      (req.url === "/v1/metrics" ||
        req.url?.startsWith("/v1/metrics") ||
        req.url === "/")
    ) {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (!raw.trim()) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{}");
            return;
          }
          // Prefer JSON (OTEL http/json). Protobuf is not supported yet.
          const ct = (req.headers["content-type"] ?? "").toLowerCase();
          if (ct.includes("protobuf") || ct.includes("x-protobuf")) {
            res.writeHead(415, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error:
                  "protobuf OTLP not supported; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json",
              }),
            );
            return;
          }
          const body = JSON.parse(raw) as unknown;
          const events = state.ingest(body);
          for (const e of events) {
            try {
              opts.onEvent(e);
            } catch (err) {
              console.error(
                "[tokenops] otel onEvent failed:",
                err instanceof Error ? err.message : err,
              );
            }
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ partialSuccess: {} }));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : "bad_request",
            }),
          );
        }
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.on("error", reject);
  });

  return server;
}
