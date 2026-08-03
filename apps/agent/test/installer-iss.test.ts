import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static guard for the Windows Setup wizard's Pascal script.
 *
 * Inno Setup's CreateInputQueryPage starts with ZERO edit controls — one Add()
 * call is required per input. Indexing Edits/PromptLabels/Values beyond the
 * number of Add() calls raises "List index out of bounds" at runtime, inside
 * InitializeWizard, before the wizard is ever drawn. The compiler does not
 * catch it, so CI's ISCC step stays green and the break only surfaces when a
 * user double-clicks Setup.exe.
 */

const ISS_PATH = fileURLToPath(
  new URL("../../../installer/windows/TokenOpsAgent.iss", import.meta.url),
);

const INDEXED_PROPERTIES = ["Edits", "PromptLabels", "Values"] as const;

function codeSection(): string {
  const source = readFileSync(ISS_PATH, "utf8");
  const start = source.indexOf("[Code]");
  expect(start, "[Code] section not found in TokenOpsAgent.iss").toBeGreaterThan(-1);
  return source.slice(start);
}

/** Page variable name -> which Create*Page factory produced it. */
function pageFactories(code: string): Map<string, string> {
  const pages = new Map<string, string>();
  const re = /(\w+)\s*:=\s*Create(InputQueryPage|CustomPage)\s*\(/gi;
  for (const m of code.matchAll(re)) pages.set(m[1], `Create${m[2]}`);
  return pages;
}

/** Page variable name -> number of .Add(...) calls made against it. */
function addCounts(code: string): Map<string, number> {
  const counts = new Map<string, number>();
  const re = /(\w+)\.Add\s*\(/gi;
  for (const m of code.matchAll(re)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  return counts;
}

interface Access {
  page: string;
  property: string;
  index: number;
}

function indexedAccesses(code: string): Access[] {
  const re = new RegExp(
    `(\\w+)\\.(${INDEXED_PROPERTIES.join("|")})\\s*\\[\\s*(\\d+)\\s*\\]`,
    "gi",
  );
  return [...code.matchAll(re)].map((m) => ({
    page: m[1],
    property: m[2],
    index: Number(m[3]),
  }));
}

describe("TokenOpsAgent.iss wizard pages", () => {
  const code = codeSection();
  const pages = pageFactories(code);
  const adds = addCounts(code);
  const accesses = indexedAccesses(code);

  it("creates at least one wizard page (guards against a vacuous parse)", () => {
    expect(pages.size).toBeGreaterThan(0);
  });

  it("only indexes Edits/PromptLabels/Values on known input-query pages", () => {
    for (const access of accesses) {
      const factory = pages.get(access.page);
      expect(
        factory,
        `${access.page}.${access.property}[${access.index}] indexes a page that is never created by a Create*Page call`,
      ).toBeDefined();
      expect(
        factory,
        `${access.page} is a ${factory} — it has no ${access.property} array. Use TNewCheckBox/TNewStaticText on .Surface instead.`,
      ).toBe("CreateInputQueryPage");
    }
  });

  it("never indexes past the number of Add() calls on a page", () => {
    for (const access of accesses) {
      const count = adds.get(access.page) ?? 0;
      expect(
        access.index,
        `${access.page}.${access.property}[${access.index}] but ${access.page}.Add() is called only ${count} time(s) — Inno raises "List index out of bounds (${access.index})" in InitializeWizard`,
      ).toBeLessThan(count);
    }
  });

  it("keeps the checkbox-only tools page as a custom page", () => {
    expect(pages.get("ToolsPage")).toBe("CreateCustomPage");
    expect(adds.get("ToolsPage") ?? 0).toBe(0);
  });

  it("does not mint machine ids in the installer", () => {
    const source = readFileSync(ISS_PATH, "utf8");

    // The agent owns identity: identity.ts uses randomUUID() on first run.
    // A timestamp-derived id here is guessable and also weakens every event id,
    // since buildEventId hashes machineId.
    expect(source).not.toMatch(/machineId/i);
    expect(source).not.toMatch(/GuidStr/);
  });
});
