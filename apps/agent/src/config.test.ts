import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultConfig,
  loadConfig,
  writeDefaultConfig,
} from "./config.js";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenops-config-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("config", () => {
  it("writeDefaultConfig creates loadable TOML", () => {
    const dir = tmpDir();
    const path = join(dir, "config.toml");
    const written = writeDefaultConfig({ path });
    expect(written.privacy.contentMode).toBe("local");
    expect(written.proxy.listen).toBe("127.0.0.1:8787");

    const loaded = loadConfig(path);
    expect(loaded).toEqual(written);
    expect(loaded.sources.openaiProxy).toBe(true);
    expect(loaded.sources.claudeCode).toBe(true);
  });

  it("loadConfig maps snake_case TOML to camelCase", () => {
    const dir = tmpDir();
    const path = join(dir, "config.toml");
    writeFileSync(
      path,
      `
[cloud]
url = "https://tokenops.example.com"
ingest_token = "pat_secret"

[privacy]
content_mode = "cloud_ttl"
content_ttl_days = 14

[proxy]
listen = "0.0.0.0:9000"
upstream = "https://api.openai.com/v1"

[sources]
openai_proxy = true
claude_code = false
claude_code_path = "C:/logs/claude-usage.jsonl"

[machine]
name = "desktop-main"
`,
      "utf8",
    );

    const cfg = loadConfig(path);
    expect(cfg.cloud.url).toBe("https://tokenops.example.com");
    expect(cfg.cloud.ingestToken).toBe("pat_secret");
    expect(cfg.privacy.contentMode).toBe("cloud_ttl");
    expect(cfg.privacy.contentTtlDays).toBe(14);
    expect(cfg.proxy.listen).toBe("0.0.0.0:9000");
    expect(cfg.sources.claudeCode).toBe(false);
    expect(cfg.sources.claudeCodePath).toBe("C:/logs/claude-usage.jsonl");
    expect(cfg.machine.name).toBe("desktop-main");
  });

  it("loadConfig throws when file missing", () => {
    const path = join(tmpDir(), "missing.toml");
    expect(() => loadConfig(path)).toThrow(/Config not found/);
  });

  it("loadConfig rejects invalid content_mode", () => {
    const path = join(tmpDir(), "bad.toml");
    writeFileSync(
      path,
      `[privacy]\ncontent_mode = "everything"\n`,
      "utf8",
    );
    expect(() => loadConfig(path)).toThrow(/content_mode/);
  });

  it("writeDefaultConfig does not overwrite unless force", () => {
    const path = join(tmpDir(), "config.toml");
    writeDefaultConfig({
      path,
      config: { machine: { name: "first" } },
    });
    writeDefaultConfig({
      path,
      config: { machine: { name: "second" } },
    });
    expect(loadConfig(path).machine.name).toBe("first");

    writeDefaultConfig({
      path,
      force: true,
      config: { machine: { name: "second" } },
    });
    expect(loadConfig(path).machine.name).toBe("second");
  });

  it("defaultConfig matches design sketch shape", () => {
    const d = defaultConfig();
    expect(d.privacy.contentMode).toBe("local");
    expect(d.privacy.contentTtlDays).toBe(7);
    expect(d.proxy.upstream).toContain("openai");
    expect(Object.keys(d)).toEqual([
      "cloud",
      "privacy",
      "proxy",
      "sources",
      "machine",
    ]);
  });
});

describe("session adapter config", () => {
  it("defaults claudeCodePath to the real Claude Code projects directory", () => {
    const c = defaultConfig();
    expect(c.sources.claudeCodePath).toMatch(/[\\/]\.claude[\\/]projects$/);
  });

  it("defaults the backfill window to 7 days", () => {
    expect(defaultConfig().sources.claudeCodeBackfillDays).toBe(7);
  });

  it("reads claude_code_backfill_days from TOML", () => {
    const path = join(tmpDir(), "config.toml");
    writeFileSync(
      path,
      `
[sources]
claude_code_backfill_days = 30
`,
      "utf8",
    );
    expect(loadConfig(path).sources.claudeCodeBackfillDays).toBe(30);
  });

  it("treats a blank claude_code_path as absent and falls back to the default", () => {
    // Every config ever written by writeDefaultConfig() before this fix
    // persisted claude_code_path = "" (the old empty-string default),
    // serialized unconditionally by toToml(). Without this guard, that
    // blank string would beat the new ~/.claude/projects default on every
    // upgrade and silently stop Claude Code capture: readdirSync("") throws,
    // the watcher's per-file try/catch swallows it, and nothing is logged as
    // an error.
    const path = join(tmpDir(), "config.toml");
    writeFileSync(
      path,
      `
[sources]
claude_code_path = ""
`,
      "utf8",
    );
    expect(loadConfig(path).sources.claudeCodePath).toBe(
      defaultConfig().sources.claudeCodePath,
    );
    expect(loadConfig(path).sources.claudeCodePath).not.toBe("");
  });
});
