import { ipcMain, shell } from "electron";
import type { AgentHandle } from "@tokenops/agent";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * `@tokenops/agent` is ESM-only (see main/index.ts's comment on
 * `startDesktopAgent` for the full explanation) while this main process
 * compiles to CommonJS. A static `import { readLocalStats } from
 * "@tokenops/agent"` here downlevels to a `require()` that Node's CJS
 * loader cannot resolve against an ESM-only package's "exports" map (no
 * "require" condition) -- confirmed the hard way: vitest never hits Node's
 * real CJS resolver, so a static import passed every test here and only
 * broke the first time Electron actually loaded this file. A dynamic
 * `import()` is the correct interop path; it's cached after first use so
 * the per-poll "tokenops:stats" handler doesn't re-import on every call.
 */
let agentModule: Promise<typeof import("@tokenops/agent")> | null = null;
function loadAgentModule(): Promise<typeof import("@tokenops/agent")> {
  agentModule ??= import("@tokenops/agent");
  return agentModule;
}

/**
 * Registers the desktop app's entire IPC surface. Every channel is
 * enumerated here and in preload/index.ts -- there is no generic
 * `invoke(channel, ...)` passthrough, so the renderer can never reach
 * anything beyond these four calls.
 */
export function registerIpc(getAgent: () => AgentHandle | null): void {
  ipcMain.handle("tokenops:stats", async () => {
    // Read straight from the outbox file rather than through the agent's own
    // handle: readLocalStats never throws (see apps/agent/src/local-stats.ts)
    // and degrades to all-zero stats when the file or table is missing, so
    // the window has something to show even before the agent has started.
    const { readLocalStats, defaultOutboxPath } = await loadAgentModule();
    return readLocalStats(defaultOutboxPath());
  });

  ipcMain.handle("tokenops:status", () => {
    const agent = getAgent();
    if (!agent) throw new Error("agent not started");
    const { config, machineName } = agent;
    // Presence only. Neither the PAT nor the provider key crosses this line.
    return {
      machineName,
      cloudUrl: config.cloud.url,
      ingestTokenPresent: Boolean(config.cloud.ingestToken),
      upstreamKeyPresent: Boolean(
        process.env.OPENAI_API_KEY || process.env.XAI_API_KEY,
      ),
      proxyListen: config.sources.openaiProxy ? config.proxy.listen : null,
      otelListen: config.sources.claudeCode
        ? config.sources.claudeCodeOtelListen || null
        : null,
      claudeCodeWatching: config.sources.claudeCode,
    };
  });

  ipcMain.on("tokenops:open-dashboard", (_e, url: string) => {
    void shell.openExternal(url);
  });

  ipcMain.on("tokenops:open-config", () => {
    void shell.openPath(join(homedir(), ".tokenops"));
  });
}
