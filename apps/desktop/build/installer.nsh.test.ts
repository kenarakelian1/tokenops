import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guard for installer.nsh -- the NSIS include that customInstall runs
 * during setup to remove the old Inno install's leftovers (its logon task,
 * a stray TOKENOPS_HOME env var, and its stale PATH entry). This is the
 * only piece of this repo that writes to the user's registry, and nothing
 * here executes as part of `pnpm test` (that would mean running a real NSIS
 * compiler against the real registry), so this guards the source text
 * instead -- the same approach the deleted installer-iss.test.ts used for
 * TokenOpsAgent.iss's Pascal script.
 *
 * The macros' actual runtime correctness (six PATH-shape cases, including
 * this repo's real machine's captured PATH string) was verified by
 * compiling and running a standalone NSIS harness against
 * TokenOpsRemovePathEntry -- see task-5-report.md's Finding-3 fix-round
 * entry. That harness isn't checked in (it needs a real NSIS compiler,
 * which this repo doesn't vendor), so it can't run in CI; this test is the
 * cheap, always-on regression net for the same class of bug.
 */

// import.meta.url resolves to a non-file:// URL under this package's jsdom
// test environment, so fileURLToPath(new URL(...)) throws -- import.meta.dirname
// (Node 22+) sidesteps that entirely.
const NSH_PATH = join(import.meta.dirname, "installer.nsh");

function source(): string {
  return readFileSync(NSH_PATH, "utf8");
}

function macroBody(src: string, name: string): string {
  const start = src.indexOf(`!macro ${name}`);
  expect(start, `!macro ${name} not found in installer.nsh`).toBeGreaterThan(-1);
  const end = src.indexOf("!macroend", start);
  expect(end, `!macroend for ${name} not found`).toBeGreaterThan(-1);
  return src.slice(start, end);
}

describe("installer.nsh: customInstall", () => {
  const src = source();
  const body = macroBody(src, "customInstall");

  it("still deletes the old Inno install's TokenOpsAgent logon task", () => {
    expect(body).toMatch(/schtasks\s+\/Delete\s+\/TN\s+"TokenOpsAgent"\s+\/F/);
  });

  it("pops the exit code nsExec::Exec pushes, so it doesn't leave a stray value on the stack", () => {
    const execLine = body.indexOf("nsExec::Exec");
    expect(execLine).toBeGreaterThan(-1);
    const afterExec = body.slice(execLine, execLine + 200);
    expect(afterExec).toMatch(/nsExec::Exec[^\n]*\n\s*Pop\s+\$\w+/);
  });

  it("still deletes the stray TOKENOPS_HOME env var from the old install", () => {
    expect(body).toMatch(/DeleteRegValue\s+HKCU\s+"Environment"\s+"TOKENOPS_HOME"/);
  });

  it("still runs the PATH cleanup (not removed or short-circuited)", () => {
    expect(body).toMatch(/!insertmacro\s+TokenOpsRemoveStaleBinFromPath/);
  });
});

describe("installer.nsh: TokenOpsRemovePathEntry stays entry-anchored", () => {
  const src = source();
  const body = macroBody(src, "TokenOpsRemovePathEntry");

  // Regression guard for the bug an unanchored 3-pass replace had: it could
  // match inside an entry that merely *starts with* the needle (e.g. a
  // sibling "...\TokenOps\bin\tools" directory), gluing the remainder onto
  // the previous PATH entry. The fix wraps the string in artificial
  // leading/trailing ";" delimiters and does one replace of ";NEEDLE;", so
  // a match can only ever be a *whole* entry.
  it("wraps the PATH value in artificial ';' delimiters before matching", () => {
    expect(body).toMatch(/;\$\{PATHVAR\};/);
  });

  it("replaces the needle only when delimiter-bounded on both sides", () => {
    expect(body).toMatch(/;\$\{NEEDLE\};/);
  });

  it("strips the artificial wrapping back off after the replace", () => {
    // one call to trim the leading ";" (positive offset) and one to trim
    // the trailing ";" (negative length)
    expect(body).toMatch(/StrCpy\s+\$R8\s+\$R8\s+""\s+1/);
    expect(body).toMatch(/StrCpy\s+\$R8\s+\$R8\s+-1/);
  });
});

describe("installer.nsh: label uniquifiers", () => {
  const src = source();

  it("never passes the same UNIQ token to two different macro insertions", () => {
    // Every call site that takes a UNIQ argument as its first parameter --
    // this is what keeps NSIS labels (plain text, not macro-scoped) from
    // colliding into a "label already defined" compile error if this file
    // is ever restructured to insert one of these macros more than once.
    const re = /!insertmacro\s+(TokenOpsStrReplaceAll|TokenOpsRemovePathEntry|TokenOpsRemoveStaleBinFromPath)\s+"([^"]+)"/g;
    const seen = new Map<string, string>();
    for (const m of src.matchAll(re)) {
      const [, macroName, uniq] = m;
      const key = uniq;
      const prior = seen.get(key);
      expect(
        prior,
        `UNIQ "${uniq}" used by both ${prior} and ${macroName} -- these expand into the same NSIS labels`,
      ).toBeUndefined();
      seen.set(key, macroName);
    }
    expect(seen.size).toBeGreaterThan(0);
  });
});
