#!/usr/bin/env node
/**
 * Replay the session rules over real Claude Code history and report what
 * they would have surfaced.
 *
 * This is the acceptance gate for the session-grain rule set. The previous
 * rule set shipped green and useless — roughly 24 findings from 14,546
 * turns — because nobody measured against real data until the end. Run
 * this before calling the work done, and report the number it prints
 * whether or not it is the number you hoped for.
 *
 * Reads ~/.claude/projects/**\/*.jsonl directly rather than the database,
 * so it needs no deployment. Deduplicates by message.id: Claude Code
 * writes one line per content BLOCK, and a naive per-line count inflates
 * everything by ~2.1x.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  CONTEXT_BAND_EDGES,
  contextBandIndex,
  runSessionRules,
} from "../packages/shared/dist/index.js";

const WINDOW_DAYS = Number(process.env.WINDOW_DAYS ?? 7);
const root = join(homedir(), ".claude", "projects");
const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;

function* jsonlFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(path);
    else if (entry.name.endsWith(".jsonl") && statSync(path).mtimeMs > cutoff) {
      yield path;
    }
  }
}

const rollups = [];
let unattributedTurns = 0;
let unattributedInput = 0;
let totalTurns = 0;

for (const file of jsonlFiles(root)) {
  const seen = new Set();
  const byModel = new Map();
  const turnsByContextBand = new Array(CONTEXT_BAND_EDGES.length).fill(0);
  const cacheReadByContextBand = new Array(CONTEXT_BAND_EDGES.length).fill(0);
  let turnCount = 0;
  let input = 0, output = 0, read = 0, creation = 0;
  let start = null, end = null;

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type !== "assistant") continue;
    const usage = row.message?.usage;
    const id = row.message?.id;
    if (!usage || !id || seen.has(id)) continue;
    seen.add(id);
    totalTurns += 1;

    const r = usage.cache_read_input_tokens ?? 0;
    const c = usage.cache_creation_input_tokens ?? 0;
    const context = (usage.input_tokens ?? 0) + r + c;

    // Sidechain turns carry no sessionId, matching the adapter's design.
    if (row.isSidechain) {
      unattributedTurns += 1;
      unattributedInput += context;
      continue;
    }

    const band = contextBandIndex(context);
    turnsByContextBand[band] += 1;
    cacheReadByContextBand[band] += r;
    turnCount += 1;
    input += context; output += usage.output_tokens ?? 0;
    read += r; creation += c;
    byModel.set(row.message.model, (byModel.get(row.message.model) ?? 0) + context);
    if (!start || row.timestamp < start) start = row.timestamp;
    if (!end || row.timestamp > end) end = row.timestamp;
  }

  if (turnCount === 0) continue;
  const model = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0][0];
  rollups.push({
    sessionId: file, start, end, turnCount, model,
    modelTier: "frontier",
    inputTokens: input, outputTokens: output,
    cacheReadTokens: read, cacheCreationTokens: creation,
    turnsByContextBand, cacheReadByContextBand,
  });
}

const byRule = new Map();
for (const rollup of rollups) {
  for (const hit of runSessionRules(rollup, new Date(rollup.end))) {
    const list = byRule.get(hit.ruleId) ?? [];
    list.push(hit);
    byRule.set(hit.ruleId, list);
  }
}

const CAP = 10;
console.log(`window:                ${WINDOW_DAYS} days`);
console.log(`sessions:              ${rollups.length}`);
console.log(`turns (deduped):       ${totalTurns.toLocaleString("en-US")}`);
console.log(`unattributed turns:    ${unattributedTurns.toLocaleString("en-US")} (${(unattributedInput / 1e6).toFixed(1)}M tokens)`);
console.log("");
let shown = 0;
for (const [ruleId, hits] of byRule) {
  const top = [...hits].sort((a, b) => (b.estimatedWastedUsd ?? 0) - (a.estimatedWastedUsd ?? 0)).slice(0, CAP);
  const sum = top.reduce((n, h) => n + (h.estimatedWastedUsd ?? 0), 0);
  shown += top.length;
  console.log(`${ruleId}: ${hits.length} sessions fire, top ${top.length} shown, $${sum.toFixed(2)} API-equivalent`);
}
console.log("");
console.log(`CARDS SHOWN: ${shown}`);
if (shown === 0) {
  console.error("FAIL: no cards. The rules do not fire on real data.");
  process.exit(1);
}
if (shown > 40) {
  console.error(`FAIL: ${shown} cards is noise, not a recommendation set.`);
  process.exit(1);
}
console.log("PASS: bounded, non-empty finding set.");
