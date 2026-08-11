import { existsSync } from "node:fs";
import { join } from "node:path";
import type { UsageEvent } from "@tokenops/shared";
import {
  defaultConfigPath,
  defaultTokenopsDir,
  loadConfig,
  type TokenOpsConfig,
} from "./config.js";
import { ensureIdentity } from "./identity.js";
import { Outbox, defaultOutboxPath } from "./outbox.js";
import { prepareEventForShip } from "./privacy-apply.js";
import { flushOutbox, sendHeartbeat } from "./flush.js";
import { startProxy } from "./proxy/server.js";

/** Default flush / heartbeat interval. */
export const FLUSH_INTERVAL_MS = 5_000;

export type RunAgentOptions = {
  /** Override config path (default ~/.tokenops/config.toml). */
  configPath?: string;
  /** Override data dir for identity + outbox. */
  tokenopsDir?: string;
  /** Override flush interval (ms). */
  flushIntervalMs?: number;
  /** Inject fetch for tests. */
  fetchImpl?: typeof fetch;
  /**
   * When true, do not register process signal handlers (tests).
   * Caller must call `stop()`.
   */
  detach?: boolean;
};

export type AgentHandle = {
  outbox: Outbox;
  config: TokenOpsConfig;
  machineId: string;
  machineName: string;
  stop: () => Promise<void>;
  /** Run one flush + heartbeat cycle (for tests). */
  tick: () => Promise<void>;
};

/**
 * Start the local agent: OpenAI proxy (optional), outbox flush + heartbeats.
 * Upstream API key is read from `OPENAI_API_KEY` only — never from cloud config.
 */
export async function runAgent(
  options: RunAgentOptions = {},
): Promise<AgentHandle> {
  const tokenopsDir = options.tokenopsDir ?? defaultTokenopsDir();
  const configPath =
    options.configPath ??
    (existsSync(join(tokenopsDir, "config.toml"))
      ? join(tokenopsDir, "config.toml")
      : defaultConfigPath());

  const config = loadConfig(configPath);

  const identity = ensureIdentity({
    dir: tokenopsDir,
    machineName: config.machine.name,
  });

  const outboxPath = join(tokenopsDir, "outbox.db");
  const outbox = new Outbox(outboxPath);

  const onEvent = (event: UsageEvent): void => {
    try {
      const shipped = prepareEventForShip(event, config);
      outbox.enqueue(shipped);
    } catch (err) {
      console.error(
        "[tokenops] failed to enqueue event:",
        err instanceof Error ? err.message : err,
      );
    }
  };

  let proxyServer: Awaited<ReturnType<typeof startProxy>> | null = null;
  let sessionWatcher: { rescan(): void; stop(): void } | null = null;
  let sessionOffsets: import("./adapters/session-offsets.js").SessionOffsets | null =
    null;
  let otelServer: import("node:http").Server | null = null;

  if (config.sources.openaiProxy) {
    const { resolveUpstreamApiKey, isXaiUpstream, appFromUpstream } =
      await import("./proxy/handler.js");
    const { apiKey, source } = resolveUpstreamApiKey(config.proxy.upstream);
    if (!apiKey) {
      const hint = isXaiUpstream(config.proxy.upstream)
        ? "set XAI_API_KEY (or OPENAI_API_KEY) for xAI/Grok"
        : "set OPENAI_API_KEY (or XAI_API_KEY) for upstream auth";
      console.warn(
        `[tokenops] no upstream API key; proxy will start but upstream calls will fail auth (${hint})`,
      );
    } else {
      console.log(`[tokenops] proxy upstream key from ${source}`);
    }
    proxyServer = await startProxy({
      listen: config.proxy.listen,
      upstream: config.proxy.upstream,
      apiKey,
      onEvent,
      machineId: identity.machineId,
      machineName: identity.machineName,
    });
    const appLabel = appFromUpstream(config.proxy.upstream);
    console.log(
      `[tokenops] proxy listening on ${config.proxy.listen} → ${config.proxy.upstream} (app=${appLabel})`,
    );
  }

  if (config.sources.claudeCode) {
    const { SessionOffsets } = await import("./adapters/session-offsets.js");
    const { watchClaudeSessions } = await import(
      "./adapters/claude-session-watcher.js"
    );
    sessionOffsets = new SessionOffsets(
      join(tokenopsDir, "session-offsets.db"),
    );
    sessionWatcher = watchClaudeSessions({
      rootDir: config.sources.claudeCodePath,
      offsets: sessionOffsets,
      machineId: identity.machineId,
      machineName: identity.machineName,
      onEvent,
      backfillDays: config.sources.claudeCodeBackfillDays,
    });
    if (existsSync(config.sources.claudeCodePath)) {
      console.log(
        `[tokenops] claude-code session watcher watching ${config.sources.claudeCodePath}`,
      );
    } else {
      // Not fatal: a machine that has never run Claude Code has no
      // ~/.claude/projects yet, and the directory may appear later (the
      // watcher keeps polling). But an unconditional "watching <path>" log
      // here would read as success while silently capturing nothing --
      // exactly the failure mode a misconfigured or blanked
      // claude_code_path produces. Naming the config key, not just the
      // path, is what makes this actionable.
      console.warn(
        `[tokenops] claude-code session watcher: directory not found at ` +
          `${config.sources.claudeCodePath} -- no Claude Code usage will be ` +
          `captured until it exists. If your sessions live elsewhere, set ` +
          `sources.claude_code_path in config.toml.`,
      );
    }
  }

  const otelListen = config.sources.claudeCodeOtelListen?.trim();
  if (otelListen) {
    try {
      const { startClaudeOtelServer } = await import(
        "./adapters/claude-otel.js"
      );
      otelServer = await startClaudeOtelServer({
        listen: otelListen,
        machineId: identity.machineId,
        machineName: identity.machineName,
        onEvent,
        ignoreClaudeCodeMetrics: config.sources.claudeCode,
      });
      console.log(
        `[tokenops] Claude Code OTEL metrics listening on ${otelListen} (use OTEL_EXPORTER_OTLP_PROTOCOL=http/json)`,
      );
    } catch (err) {
      console.warn(
        "[tokenops] failed to start Claude OTEL receiver:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  const fetchImpl = options.fetchImpl;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const flushResult = await flushOutbox({
      outbox,
      cloudUrl: config.cloud.url,
      ingestToken: config.cloud.ingestToken,
      fetchImpl,
    });
    if (flushResult.error) {
      console.error(`[tokenops] flush error: ${flushResult.error}`);
    } else if (flushResult.sent > 0) {
      console.log(`[tokenops] flushed ${flushResult.sent} event(s)`);
    }

    const hb = await sendHeartbeat({
      cloudUrl: config.cloud.url,
      ingestToken: config.cloud.ingestToken,
      machineId: identity.machineId,
      machineName: identity.machineName,
      queueDepth: outbox.pendingCount(),
      fetchImpl,
    });
    if (!hb.ok && hb.error) {
      console.error(`[tokenops] heartbeat error: ${hb.error}`);
    }
  };

  // Immediate first cycle so status / dashboard update without waiting 5s.
  await tick();

  const intervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Allow process to exit when only the timer is left (tests / stop).
  timer.unref?.();

  const stop = async (): Promise<void> => {
    stopped = true;
    clearInterval(timer);
    sessionWatcher?.stop();
    sessionWatcher = null;
    sessionOffsets?.close();
    sessionOffsets = null;
    // closeAllConnections() *before* close(): Node's Server#close() only
    // stops accepting new connections and waits for every in-flight one to
    // end on its own -- and server.timeout is 0 (never set), so a client
    // mid-stream (the proxy's SSE completions, in particular) can hold
    // close() open indefinitely. closeAllConnections() destroys every open
    // socket immediately, so close()'s callback -- and therefore this
    // await -- resolves promptly regardless of what upstream traffic was
    // in flight when stop() was called. This is deliberate quit behavior,
    // not a bug: whoever calls stop() (the CLI's SIGINT/SIGTERM handler, or
    // the desktop app's before-quit handler) has already decided to shut
    // down, and an in-flight completion losing its response is a strictly
    // better outcome than a quit that never completes.
    if (otelServer) {
      otelServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        otelServer!.close((err) => (err ? reject(err) : resolve()));
      });
      otelServer = null;
    }
    if (proxyServer) {
      proxyServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        proxyServer!.close((err) => (err ? reject(err) : resolve()));
      });
      proxyServer = null;
    }
    outbox.close();
  };

  if (!options.detach) {
    const onSignal = () => {
      console.log("\n[tokenops] shutting down…");
      void stop().then(() => process.exit(0));
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  return {
    outbox,
    config,
    machineId: identity.machineId,
    machineName: identity.machineName,
    stop,
    tick,
  };
}

export { defaultConfigPath, defaultOutboxPath, defaultTokenopsDir, loadConfig };
export { readLocalStats, type LocalStats } from "./local-stats.js";
