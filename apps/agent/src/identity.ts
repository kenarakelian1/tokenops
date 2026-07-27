import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultTokenopsDir } from "./config.js";

export type MachineIdentity = {
  machineId: string;
  machineName: string;
};

type MachineFile = {
  machineId: string;
  machineName: string;
};

/**
 * Ensure a stable machine identity exists under `~/.tokenops/machine.json`.
 * Creates a UUID on first run; reuses on subsequent calls.
 * Optional `machineName` updates the display name when provided.
 */
export function ensureIdentity(options?: {
  dir?: string;
  machineName?: string;
}): MachineIdentity {
  const dir = options?.dir ?? defaultTokenopsDir();
  const path = join(dir, "machine.json");
  mkdirSync(dir, { recursive: true });

  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as MachineFile;
    if (!raw.machineId || typeof raw.machineId !== "string") {
      throw new Error(`Invalid machine identity at ${path}: missing machineId`);
    }
    const machineName =
      options?.machineName?.trim() ||
      raw.machineName ||
      "desktop";
    if (machineName !== raw.machineName) {
      const updated: MachineFile = { machineId: raw.machineId, machineName };
      writeFileSync(path, JSON.stringify(updated, null, 2) + "\n", "utf8");
      return updated;
    }
    return {
      machineId: raw.machineId,
      machineName: raw.machineName || "desktop",
    };
  }

  const identity: MachineFile = {
    machineId: randomUUID(),
    machineName: options?.machineName?.trim() || "desktop",
  };
  writeFileSync(path, JSON.stringify(identity, null, 2) + "\n", "utf8");
  return identity;
}
