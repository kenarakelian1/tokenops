import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { writeDefaultConfig } from "./config.js";
import { runAgent } from "./agent-main.js";

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
