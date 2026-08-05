import { Menu, Tray, nativeImage, shell } from "electron";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * State the tray tooltip can report. "starting" is the honest label for the
 * window between app launch and startDesktopAgent() settling -- the prior
 * hardcoded "capturing" tooltip lied whenever the agent had not started yet
 * or had outright failed (index.ts's dialog.showErrorBox path), which is
 * exactly the "healthy-looking but broken" failure mode this whole app
 * exists to surface, not repeat.
 */
export type TrayStatus = "starting" | "capturing" | "error" | "stopping";

const TOOLTIPS: Record<TrayStatus, string> = {
  starting: "TokenOps — starting…",
  capturing: "TokenOps — capturing",
  error: "TokenOps — agent failed to start",
  stopping: "TokenOps — shutting down…",
};

export function setTrayStatus(tray: Tray, status: TrayStatus): void {
  tray.setToolTip(TOOLTIPS[status]);
}

export function createTray(opts: {
  onShow: () => void;
  onQuit: () => void;
}): Tray {
  // Deliberately NOT "../../build/icon.ico": electron-builder's
  // directories.buildResources default (see electron-builder.yml) excludes
  // `build/**` from the packaged app.asar -- that path only ever resolves in
  // an unpacked dev run (`electron .`), never in a real install. This repo's
  // own packaged build output confirms it: dist/builder-debug.yml lists
  // `'!build{,/**/*}'` in firstOrDefaultFilePatterns, and app.asar has no
  // /build/ entries. build/icon.ico is still kept, and still what
  // electron-builder.yml points `win.icon` at, for the installer/.exe icon
  // -- that one *is* baked into the binary at build time, not read from disk
  // at runtime. This second on-disk copy is the one Tray actually loads.
  const icon = nativeImage.createFromPath(
    join(__dirname, "../../assets/icon.ico"),
  );
  const tray = new Tray(icon);
  setTrayStatus(tray, "starting");

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show TokenOps", click: opts.onShow },
      {
        label: "Open config folder",
        click: () => void shell.openPath(join(homedir(), ".tokenops")),
      },
      { type: "separator" },
      { label: "Quit", click: opts.onQuit },
    ]),
  );

  tray.on("click", opts.onShow);
  return tray;
}

// Deliberate omission: the spec's tray menu listed "Pause capture". It is
// dropped here. Pausing means stopping and restarting the agent, which forces
// the tray, window, and IPC layers all to handle a null AgentHandle -- real
// lifecycle complexity for a feature Quit already covers. Add it later if the
// need proves real; do not add it speculatively.
//
// Two more spec items are recorded here as deliberate cuts, not oversights
// (see docs/superpowers/specs/2026-08-04-desktop-app-design.md's Follow-ups,
// which lists both): a tray icon with distinct idle/capturing/error glyphs
// (this app has one static icon; TrayStatus above only ever changes the
// tooltip text, never the image), and a "restart the agent" menu action
// (Quit + relaunch is the only supported recovery path today). Both are real
// scope, not a one-line add -- do not add speculatively.
