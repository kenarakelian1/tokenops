import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import type { ContentMode } from "@tokenops/shared";

/** Agent configuration (camelCase in code; snake_case in TOML). */
export type TokenOpsConfig = {
  cloud: {
    url: string;
    ingestToken: string;
  };
  privacy: {
    contentMode: ContentMode;
    contentTtlDays: number;
  };
  proxy: {
    listen: string;
    upstream: string;
  };
  sources: {
    openaiProxy: boolean;
    claudeCode: boolean;
    /** Path to Claude Code usage JSONL (file or directory). Empty = default under tokenops dir. */
    claudeCodePath: string;
    /**
     * OTLP HTTP metrics listen address for Claude Code telemetry.
     * Empty disables. Example: `127.0.0.1:4318`
     */
    claudeCodeOtelListen: string;
  };
  machine: {
    name: string;
  };
};

const CONTENT_MODES: readonly ContentMode[] = ["off", "local", "cloud_ttl"];

/** Default directory for config, identity, and outbox: `~/.tokenops`. */
export function defaultTokenopsDir(): string {
  return join(homedir(), ".tokenops");
}

/** Default path to `config.toml`. */
export function defaultConfigPath(): string {
  return join(defaultTokenopsDir(), "config.toml");
}

/** Built-in defaults used by `tokenops init` / `writeDefaultConfig`. */
export function defaultConfig(): TokenOpsConfig {
  return {
    cloud: {
      url: "http://127.0.0.1:3000",
      ingestToken: "",
    },
    privacy: {
      contentMode: "local",
      contentTtlDays: 7,
    },
    proxy: {
      listen: "127.0.0.1:8787",
      upstream: "https://api.openai.com",
    },
    sources: {
      openaiProxy: true,
      claudeCode: true,
      claudeCodePath: "",
      claudeCodeOtelListen: "127.0.0.1:4318",
    },
    machine: {
      name: "desktop",
    },
  };
}

type TomlCloud = { url?: string; ingest_token?: string };
type TomlPrivacy = { content_mode?: string; content_ttl_days?: number };
type TomlProxy = { listen?: string; upstream?: string };
type TomlSources = {
  openai_proxy?: boolean;
  claude_code?: boolean;
  claude_code_path?: string;
  claude_code_otel_listen?: string;
};
type TomlMachine = { name?: string };

type TomlRoot = {
  cloud?: TomlCloud;
  privacy?: TomlPrivacy;
  proxy?: TomlProxy;
  sources?: TomlSources;
  machine?: TomlMachine;
};

function parseContentMode(value: unknown): ContentMode {
  if (typeof value === "string" && (CONTENT_MODES as readonly string[]).includes(value)) {
    return value as ContentMode;
  }
  throw new Error(
    `Invalid privacy.content_mode: ${String(value)} (expected off | local | cloud_ttl)`,
  );
}

function fromToml(raw: TomlRoot): TokenOpsConfig {
  const base = defaultConfig();
  return {
    cloud: {
      url: raw.cloud?.url ?? base.cloud.url,
      ingestToken: raw.cloud?.ingest_token ?? base.cloud.ingestToken,
    },
    privacy: {
      contentMode:
        raw.privacy?.content_mode !== undefined
          ? parseContentMode(raw.privacy.content_mode)
          : base.privacy.contentMode,
      contentTtlDays:
        typeof raw.privacy?.content_ttl_days === "number"
          ? raw.privacy.content_ttl_days
          : base.privacy.contentTtlDays,
    },
    proxy: {
      listen: raw.proxy?.listen ?? base.proxy.listen,
      upstream: raw.proxy?.upstream ?? base.proxy.upstream,
    },
    sources: {
      openaiProxy: raw.sources?.openai_proxy ?? base.sources.openaiProxy,
      claudeCode: raw.sources?.claude_code ?? base.sources.claudeCode,
      claudeCodePath:
        typeof raw.sources?.claude_code_path === "string"
          ? raw.sources.claude_code_path
          : base.sources.claudeCodePath,
      claudeCodeOtelListen:
        typeof raw.sources?.claude_code_otel_listen === "string"
          ? raw.sources.claude_code_otel_listen
          : base.sources.claudeCodeOtelListen,
    },
    machine: {
      name: raw.machine?.name ?? base.machine.name,
    },
  };
}

function toToml(config: TokenOpsConfig): string {
  return stringify({
    cloud: {
      url: config.cloud.url,
      ingest_token: config.cloud.ingestToken,
    },
    privacy: {
      content_mode: config.privacy.contentMode,
      content_ttl_days: config.privacy.contentTtlDays,
    },
    proxy: {
      listen: config.proxy.listen,
      upstream: config.proxy.upstream,
    },
    sources: {
      openai_proxy: config.sources.openaiProxy,
      claude_code: config.sources.claudeCode,
      claude_code_path: config.sources.claudeCodePath,
      claude_code_otel_listen: config.sources.claudeCodeOtelListen,
    },
    machine: {
      name: config.machine.name,
    },
  });
}

/**
 * Load config from TOML. Defaults to `~/.tokenops/config.toml`.
 * Partial files merge over defaults; missing file throws.
 */
export function loadConfig(path?: string): TokenOpsConfig {
  const configPath = path ?? defaultConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath} (run tokenops init)`);
  }
  const text = readFileSync(configPath, "utf8");
  const raw = parse(text) as TomlRoot;
  return fromToml(raw);
}

/**
 * Write default config.toml (for `tokenops init`).
 * Creates parent directory. Overwrites only if `force` or file missing.
 */
export function writeDefaultConfig(options?: {
  path?: string;
  config?: PartialDeepConfig;
  force?: boolean;
}): TokenOpsConfig {
  const configPath = options?.path ?? defaultConfigPath();
  if (existsSync(configPath) && !options?.force) {
    return loadConfig(configPath);
  }
  const config = mergePartial(defaultConfig(), options?.config);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, toToml(config), "utf8");
  return config;
}

type PartialDeepConfig = {
  cloud?: Partial<TokenOpsConfig["cloud"]>;
  privacy?: Partial<TokenOpsConfig["privacy"]>;
  proxy?: Partial<TokenOpsConfig["proxy"]>;
  sources?: Partial<TokenOpsConfig["sources"]>;
  machine?: Partial<TokenOpsConfig["machine"]>;
};

function mergePartial(
  base: TokenOpsConfig,
  partial?: PartialDeepConfig,
): TokenOpsConfig {
  if (!partial) return base;
  return {
    cloud: { ...base.cloud, ...partial.cloud },
    privacy: { ...base.privacy, ...partial.privacy },
    proxy: { ...base.proxy, ...partial.proxy },
    sources: { ...base.sources, ...partial.sources },
    machine: { ...base.machine, ...partial.machine },
  };
}
