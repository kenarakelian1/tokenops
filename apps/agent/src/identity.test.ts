import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureIdentity } from "./identity.js";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenops-id-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("ensureIdentity", () => {
  it("creates machine.json with stable id", () => {
    const dir = tmpDir();
    const a = ensureIdentity({ dir, machineName: "laptop" });
    expect(a.machineId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(a.machineName).toBe("laptop");

    const b = ensureIdentity({ dir });
    expect(b.machineId).toBe(a.machineId);
    expect(b.machineName).toBe("laptop");

    const file = JSON.parse(
      readFileSync(join(dir, "machine.json"), "utf8"),
    ) as { machineId: string; machineName: string };
    expect(file.machineId).toBe(a.machineId);
  });

  it("updates display name when provided", () => {
    const dir = tmpDir();
    const first = ensureIdentity({ dir, machineName: "old" });
    const second = ensureIdentity({ dir, machineName: "new" });
    expect(second.machineId).toBe(first.machineId);
    expect(second.machineName).toBe("new");
  });
});
