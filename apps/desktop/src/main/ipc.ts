import { ipcMain, shell } from "electron";
import type { AgentHandle } from "@tokenops/agent";
import { isSafeExternalUrl } from "./url-safety.js";

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
 * Resolves the dashboard URL and opens it -- shared by the
 * "tokenops:open-dashboard" IPC handler (renderer-triggered) and the tray's
 * "Open dashboard" item (main-process-triggered, see index.ts), so there is
 * exactly one place that resolves the URL and exactly one place that
 * validates it.
 *
 * Prefers the live agent's `config.cloud.url` (already in memory, no disk
 * read). Falls back to reading `~/.tokenops/config.toml` directly via
 * `loadConfig()` when there is no live `AgentHandle` yet -- e.g. the agent
 * hasn't started, failed to start, or isn't running, which is exactly the
 * "window is otherwise a dead end" case this exists to fix. That fallback
 * file is just as user-editable as the live agent's config (it's the same
 * file), so the `isSafeExternalUrl` check below applies to *both* paths --
 * see main/url-safety.ts's comment on why an unvalidated `cloud.url` must
 * never reach `shell.openExternal`.
 */
export async function openDashboard(
  getAgent: () => AgentHandle | null,
): Promise<void> {
  let url = getAgent()?.config.cloud.url;
  if (!url) {
    try {
      const { loadConfig } = await loadAgentModule();
      url = loadConfig().cloud.url;
    } catch {
      // No config on disk (e.g. never ran `tokenops init`) -- nothing to open.
      return;
    }
  }
  if (url && isSafeExternalUrl(url)) {
    void shell.openExternal(url);
  }
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
      // .trim() matches apps/agent/src/proxy/handler.ts's resolveUpstreamApiKey,
      // which is what the proxy actually authenticates with. Without it, a
      // whitespace-only OPENAI_API_KEY reads as "present" here while the
      // proxy treats it as absent ("none") -- exactly the silent
      // healthy-looking-but-broken state this window exists to prevent.
      upstreamKeyPresent: Boolean(
        (process.env.OPENAI_API_KEY ?? "").trim() ||
          (process.env.XAI_API_KEY ?? "").trim(),
      ),
      proxyListen: config.sources.openaiProxy ? config.proxy.listen : null,
      otelListen: config.sources.claudeCode
        ? config.sources.claudeCodeOtelListen || null
        : null,
      claudeCodeWatching: config.sources.claudeCode,
    };
  });

  // Argument-less on purpose: the renderer never supplies the URL. Main
  // resolves it itself (see openDashboard above -- live agent config, or a
  // disk fallback) and validates it the same way window.ts validates every
  // other URL handed to the OS shell -- http(s) only. Taking a
  // renderer-supplied string here instead would let a hostile or malformed
  // cloud.url (this file is user-editable) reach shell.openExternal
  // unchecked, e.g. file:///... or a registered custom protocol.
  ipcMain.on("tokenops:open-dashboard", () => {
    void openDashboard(getAgent);
  });

  ipcMain.on("tokenops:open-config", () => {
    void loadAgentModule().then(({ defaultTokenopsDir }) => {
      void shell.openPath(defaultTokenopsDir());
    });
  });
}
