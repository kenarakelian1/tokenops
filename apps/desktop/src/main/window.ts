import { BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { canWindowClose } from "./quit-state.js";

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Only http(s) is ever handed to the OS shell. `shell.openExternal` with an
 * unvalidated URL is a known Windows attack path -- `file:`, UNC paths
 * (`\\host\share`), and registered custom protocol handlers can all launch
 * something other than a browser tab.
 */
function isSafeExternalUrl(url: string): boolean {
  try {
    return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function createMainWindow(): BrowserWindow {
  const indexHtmlPath = join(__dirname, "../renderer/index.html");
  const indexHtmlUrl = pathToFileURL(indexHtmlPath).href;

  const win = new BrowserWindow({
    width: 920,
    height: 640,
    show: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // External links belong in the user's browser, never in an Electron window.
  // This covers window.open()/target=_blank only -- see will-navigate below
  // for plain links and location.href assignments in the same window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // setWindowOpenHandler does not cover a plain <a href> or a script setting
  // location.href -- those navigate this privileged window itself. Only the
  // bundled renderer's own index.html may load in-window; anything else is
  // blocked, and http(s) is redirected to the OS browser instead of being
  // dropped silently.
  win.webContents.on("will-navigate", (event, url) => {
    if (url === indexHtmlUrl) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
  });

  // Closing must NOT stop capture -- that is the console-window behaviour
  // this app exists to replace. The window may only actually close once
  // agent.stop() has genuinely resolved (quit-state.ts's "stopped" phase,
  // reached only via index.ts's before-quit handler); every other close --
  // including a quit that has been requested but is still tearing down --
  // just hides the window to the tray instead.
  win.on("close", (event) => {
    if (!canWindowClose()) {
      event.preventDefault();
      win.hide();
    }
  });

  void win.loadFile(indexHtmlPath);
  return win;
}
