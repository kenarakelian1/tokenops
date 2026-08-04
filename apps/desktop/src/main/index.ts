import { app, BrowserWindow } from "electron";
import type { AgentHandle } from "@tokenops/agent";
import { createMainWindow } from "./window.js";

let agent: AgentHandle | null = null;
let win: BrowserWindow | null = null;

/**
 * `detach: true` suppresses the signal handlers the CLI installs. Lifecycle is
 * ours: nothing stops capture except an explicit quit.
 *
 * `@tokenops/agent` is ESM-only (the repo default) while this main process
 * compiles to CommonJS (see tsconfig.json / README note in window.ts on
 * __dirname and sandboxed preload). A static `import` would downlevel to a
 * `require()` that Node's CJS loader cannot resolve against an ESM-only
 * package's "exports" map (no "require" condition) -- a dynamic `import()`
 * is the correct CJS-consumes-ESM interop path, so it is used here on
 * purpose rather than switched to `require`.
 */
export async function startDesktopAgent(): Promise<AgentHandle> {
  const { runAgent } = await import("@tokenops/agent");
  return runAgent({ detach: true });
}

app.whenReady().then(async () => {
  agent = await startDesktopAgent();
  win = createMainWindow();
});

// Task 3 adds tray + hide-on-close; for now closing the window quits the app
// (Electron's default), which triggers this handler before exit.
app.on("before-quit", async () => {
  await agent?.stop();
  agent = null;
});

app.on("window-all-closed", () => {
  app.quit();
});
