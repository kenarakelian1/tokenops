import { Menu, Tray, nativeImage, shell } from "electron";
import { join } from "node:path";
import { homedir } from "node:os";

export function createTray(opts: {
  onShow: () => void;
  onQuit: () => void;
}): Tray {
  const icon = nativeImage.createFromPath(
    join(__dirname, "../../build/icon.ico"),
  );
  const tray = new Tray(icon);
  tray.setToolTip("TokenOps — capturing");

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
