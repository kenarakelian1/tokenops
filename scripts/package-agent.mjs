#!/usr/bin/env node
/**
 * Package the desktop agent for Windows install.
 * Output: dist/tokenops-agent-win/
 *
 * Usage (from repo root):
 *   node scripts/package-agent.mjs
 *   pnpm package:agent
 */
import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const out = join(root, "dist", "tokenops-agent-win");
const payload = join(out, "payload");

function run(cmd, cwd = root) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit", shell: true });
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

console.log("Building packages…");
run("pnpm.cmd --filter @tokenops/shared build");
run("pnpm.cmd --filter @tokenops/agent build");

console.log("Preparing output…");
rmSync(out, { recursive: true, force: true });
ensureDir(payload);
ensureDir(join(payload, "agent"));
ensureDir(join(payload, "agent", "dist"));
ensureDir(join(payload, "agent", "node_modules", "@tokenops", "shared", "dist"));

// Standalone package.json for the installed agent
const agentPkg = {
  name: "tokenops-agent",
  version: "0.1.0",
  private: true,
  type: "module",
  bin: { tokenops: "./dist/cli.js" },
  dependencies: {
    "smol-toml": "^1.7.1",
    zod: "^4.4.3",
  },
};
writeFileSync(
  join(payload, "agent", "package.json"),
  JSON.stringify(agentPkg, null, 2),
);

// Copy agent dist
cpSync(join(root, "apps", "agent", "dist"), join(payload, "agent", "dist"), {
  recursive: true,
});

// Install production deps first (npm may wipe node_modules)
console.log("Installing production dependencies into payload…");
run("npm.cmd install --omit=dev --no-fund --no-audit", join(payload, "agent"));

// Vendor @tokenops/shared AFTER npm install so it is not removed
const sharedDest = join(payload, "agent", "node_modules", "@tokenops", "shared");
ensureDir(sharedDest);
writeFileSync(
  join(sharedDest, "package.json"),
  JSON.stringify(
    {
      name: "@tokenops/shared",
      version: "0.1.0",
      type: "module",
      main: "./dist/index.js",
      exports: { ".": "./dist/index.js" },
    },
    null,
    2,
  ),
);
cpSync(
  join(root, "packages", "shared", "dist"),
  join(sharedDest, "dist"),
  { recursive: true },
);

// Ensure shebang on cli.js
const cliPath = join(payload, "agent", "dist", "cli.js");
let cli = readFileSync(cliPath, "utf8");
if (!cli.startsWith("#!")) {
  cli = "#!/usr/bin/env node\n" + cli;
  writeFileSync(cliPath, cli);
}

// Copy installer scripts
const installerSrc = join(root, "installer", "windows");
for (const f of [
  "install.cmd",
  "install.ps1",
  "uninstall.cmd",
  "uninstall.ps1",
  "README.txt",
]) {
  const src = join(installerSrc, f);
  if (!existsSync(src)) {
    throw new Error(`Missing installer file: ${src}`);
  }
  copyFileSync(src, join(out, f));
}

// Version stamp
writeFileSync(
  join(out, "VERSION.txt"),
  `tokenops-agent 0.1.0\nbuilt ${new Date().toISOString()}\nnode target: >=22\n`,
);

console.log(`\nPackaged: ${out}`);
console.log("Distribute the whole tokenops-agent-win folder, or zip it.");
console.log("On the target PC: double-click install.cmd");
