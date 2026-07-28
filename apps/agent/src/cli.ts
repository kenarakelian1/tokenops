#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  defaultConfigPath,
  defaultTokenopsDir,
  loadConfig,
  writeDefaultConfig,
} from "./config.js";
import { ensureIdentity } from "./identity.js";
import { Outbox, defaultOutboxPath } from "./outbox.js";
import { runAgent } from "./agent-main.js";

function printHelp(): void {
  console.log(`tokenops — local agent CLI

Usage:
  tokenops init [--force]     Write default ~/.tokenops/config.toml
  tokenops agent run          Start proxy, outbox flush, heartbeats
  tokenops status             Queue depth, last error, config paths
  tokenops help               Show this help

Environment:
  OPENAI_API_KEY              Upstream key for OpenAI-compatible proxy
  XAI_API_KEY                 Preferred when proxy.upstream is api.x.ai (Grok)
                              Keys never leave the machine / never go to TokenOps cloud

Grok / xAI example config.toml:
  [proxy]
  listen = "127.0.0.1:8787"
  upstream = "https://api.x.ai/v1"
`);
}

function cmdInit(force: boolean): number {
  const path = defaultConfigPath();
  const existed = existsSync(path);
  const config = writeDefaultConfig({ force });
  if (existed && !force) {
    console.log(`Config already exists: ${path}`);
    console.log("Use --force to overwrite with defaults.");
  } else {
    console.log(`Wrote default config: ${path}`);
  }
  ensureIdentity({ machineName: config.machine.name });
  console.log(`Machine identity: ${join(defaultTokenopsDir(), "machine.json")}`);
  return 0;
}

function cmdStatus(): number {
  const configPath = defaultConfigPath();
  const outboxPath = defaultOutboxPath();
  const dir = defaultTokenopsDir();
  const machinePath = join(dir, "machine.json");

  console.log("tokenops status");
  console.log(`  config:   ${configPath}${existsSync(configPath) ? "" : " (missing — run tokenops init)"}`);
  console.log(`  identity: ${machinePath}${existsSync(machinePath) ? "" : " (missing)"}`);
  console.log(`  outbox:   ${outboxPath}${existsSync(outboxPath) ? "" : " (not created yet)"}`);

  if (existsSync(configPath)) {
    try {
      const cfg = loadConfig(configPath);
      console.log(`  cloud:    ${cfg.cloud.url}`);
      console.log(
        `  token:    ${cfg.cloud.ingestToken ? "(set)" : "(empty — set cloud.ingest_token)"}`,
      );
      console.log(`  proxy:    ${cfg.proxy.listen} → ${cfg.proxy.upstream}`);
      console.log(
        `  sources:  openai_proxy=${cfg.sources.openaiProxy} claude_code=${cfg.sources.claudeCode}`,
      );
    } catch (err) {
      console.log(
        `  config error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (existsSync(outboxPath)) {
    const outbox = new Outbox(outboxPath);
    try {
      console.log(`  queue:    ${outbox.pendingCount()} pending`);
      const err = outbox.latestError();
      console.log(`  last err: ${err ?? "(none)"}`);
    } finally {
      outbox.close();
    }
  } else {
    console.log("  queue:    0 pending");
    console.log("  last err: (none)");
  }

  return 0;
}

async function cmdAgentRun(): Promise<number> {
  const configPath = defaultConfigPath();
  if (!existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    console.error("Run: tokenops init");
    return 1;
  }

  console.log("[tokenops] starting agent…");
  await runAgent();
  // runAgent registers SIGINT handlers and keeps process alive via proxy/timer.
  // Hold the event loop with a never-resolving promise so Node does not exit
  // if proxy is disabled and only unref'd timers remain.
  await new Promise<void>(() => {
    /* run until signal */
  });
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      force: { type: "boolean", short: "f", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    printHelp();
    return values.help ? 0 : 1;
  }

  const [cmd, sub] = positionals;

  if (cmd === "help") {
    printHelp();
    return 0;
  }

  if (cmd === "init") {
    return cmdInit(Boolean(values.force));
  }

  if (cmd === "status") {
    return cmdStatus();
  }

  if (cmd === "agent" && sub === "run") {
    return cmdAgentRun();
  }

  if (cmd === "agent" && !sub) {
    console.error("Usage: tokenops agent run");
    return 1;
  }

  console.error(`Unknown command: ${positionals.join(" ")}`);
  printHelp();
  return 1;
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("cli.js") ||
    process.argv[1].endsWith("cli.ts") ||
    process.argv[1].includes("tokenops"));

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}

export { main };
