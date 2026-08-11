import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeDefaultConfig } from "./config.js";
import { runAgent } from "./agent-main.js";
import { SessionOffsets } from "./adapters/session-offsets.js";
import * as sessionWatcherModule from "./adapters/claude-session-watcher.js";

/**
 * The spec (docs/superpowers/plans/2026-08-04-desktop-app.md) calls
 * runAgent/stop() "the contract the desktop app depends on", and until now
 * it had zero lifecycle coverage -- nothing exercised the actual bind/close
 * cycle. Whole-branch review (finding I4) notes this gap would likely have
 * surfaced I1 (agent.stop() awaited unbounded, with no closeAllConnections()
 * call) directly: a test that asserts the listener ports are released after
 * stop() fails outright if close() hangs.
 */

const dirs: string[] = [];

function tmpTokenopsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenops-agent-main-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

/** Ask the OS for a free ephemeral port, then release it immediately. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not allocate a free port")));
      }
    });
  });
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

describe("runAgent lifecycle", () => {
  it("binds the proxy and OTEL listeners on start, and releases both once stop() resolves", async () => {
    const tokenopsDir = tmpTokenopsDir();
    const proxyPort = await getFreePort();
    const otelPort = await getFreePort();

    writeDefaultConfig({
      path: join(tokenopsDir, "config.toml"),
      config: {
        proxy: { listen: `127.0.0.1:${proxyPort}` },
        sources: {
          openaiProxy: true,
          // Keep this test scoped to the proxy/OTEL listeners the spec
          // calls out; the claude-code adapter is a separate concern with
          // its own file-watching lifecycle.
          claudeCode: false,
          claudeCodeOtelListen: `127.0.0.1:${otelPort}`,
        },
      },
    });

    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 });

    const handle = await runAgent({
      tokenopsDir,
      detach: true,
      fetchImpl,
      // Long enough that the interval tick never fires during this test.
      flushIntervalMs: 60_000,
    });

    expect(await isPortOpen(proxyPort)).toBe(true);
    expect(await isPortOpen(otelPort)).toBe(true);

    await handle.stop();

    expect(await isPortOpen(proxyPort)).toBe(false);
    expect(await isPortOpen(otelPort)).toBe(false);
  });
});

/** Fixture used by claude-session*.test.ts: two turns in session `s1`. */
const sessionFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "fixtures",
  "claude-session.jsonl",
);

/** Minimal OTLP ExportMetricsServiceRequest carrying one claude_code.* datapoint. */
function claudeCodeOtelBody(inputTokens: number, model = "claude-3-haiku") {
  return {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.token.usage",
                sum: {
                  dataPoints: [
                    {
                      asInt: String(inputTokens),
                      attributes: [
                        { key: "type", value: { stringValue: "input" } },
                        { key: "model", value: { stringValue: model } },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("runAgent claude-code session watcher wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts the session watcher, ignores claude_code.* OTEL metrics while it owns capture, and tears down both the watcher and the offset store on stop()", async () => {
    const tokenopsDir = tmpTokenopsDir();
    const sessionsDir = mkdtempSync(join(tmpdir(), "tokenops-sessions-"));
    dirs.push(sessionsDir);
    const projectDir = join(sessionsDir, "project1");
    mkdirSync(projectDir, { recursive: true });
    // File mtime is "now" (just written), so it's inside the default 7-day
    // backfill window regardless of the timestamps recorded inside the file.
    copyFileSync(sessionFixture, join(projectDir, "session.jsonl"));

    const otelPort = await getFreePort();

    writeDefaultConfig({
      path: join(tokenopsDir, "config.toml"),
      config: {
        sources: {
          openaiProxy: false,
          claudeCode: true,
          claudeCodePath: sessionsDir,
          claudeCodeOtelListen: `127.0.0.1:${otelPort}`,
        },
      },
    });

    // Spied rather than asserted on indirectly: SessionOffsets.close is a
    // real prototype method, shared by reference regardless of whether the
    // module is reached via this test's static import or agent-main's
    // dynamic import of the same specifier -- so this spy sees the actual
    // instance runAgent constructs.
    const closeSpy = vi.spyOn(SessionOffsets.prototype, "close");

    // watchClaudeSessions is a plain function, not a class, so there's no
    // prototype seam. Spying on the named export, delegating to the real
    // (pre-spy) implementation, lets us capture the specific handle
    // runAgent receives and assert its own stop() was invoked -- without
    // touching claude-session-watcher.ts itself.
    const watchClaudeSessionsOriginal = sessionWatcherModule.watchClaudeSessions;
    let watcherStopSpy: ReturnType<typeof vi.fn> | null = null;
    const watchSpy = vi
      .spyOn(sessionWatcherModule, "watchClaudeSessions")
      .mockImplementation((opts) => {
        const handle = watchClaudeSessionsOriginal(opts);
        watcherStopSpy = vi.fn(handle.stop);
        return { rescan: handle.rescan, stop: watcherStopSpy };
      });

    // Requests to /v1/events, captured so we can prove (a) the watcher's
    // fixture events actually reached the outbox and were shipped, and (b)
    // the ignored OTEL metric posted below produced no additional event.
    const postedEventBatches: unknown[][] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/events")) {
        const body = JSON.parse(String(init?.body)) as { events: unknown[] };
        postedEventBatches.push(body.events);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const handle = await runAgent({
      tokenopsDir,
      detach: true,
      fetchImpl,
      flushIntervalMs: 60_000,
    });

    // 1. The watcher started and actually scanned the fixture: its two
    // assistant turns reached the outbox and were flushed in runAgent's
    // immediate first tick().
    expect(watchSpy).toHaveBeenCalledTimes(1);
    const allPosted = postedEventBatches.flat() as Array<{
      app: string;
      model: string;
    }>;
    expect(allPosted.some((e) => e.app === "claude-code")).toBe(true);
    expect(allPosted.some((e) => e.model === "claude-opus-5[1m]")).toBe(true);
    const postedCountAfterStart = allPosted.length;

    // 2. ignoreClaudeCodeMetrics reached the OTEL server: post a
    // well-formed claude_code.token.usage metric directly at the listener
    // and confirm the server accepted it (200 -- so this isn't testing a
    // request that never landed) yet produced no additional /v1/events
    // batch, because the guard drops it before it becomes a UsageEvent.
    const otelRes = await fetch(`http://127.0.0.1:${otelPort}/v1/metrics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(claudeCodeOtelBody(999)),
    });
    expect(otelRes.status).toBe(200);
    await handle.tick();
    const allPostedAfterOtel = postedEventBatches.flat();
    expect(allPostedAfterOtel.length).toBe(postedCountAfterStart);

    // 3. stop() tears down both the watcher handle and the offset store.
    await handle.stop();
    expect(watcherStopSpy).not.toBeNull();
    expect(watcherStopSpy!).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
