#!/usr/bin/env node
/**
 * Replay the usage forecast over real Claude Code history and report what
 * it would have told this author.
 *
 * This is the acceptance gate for the forecast. The session-rules work
 * shipped fully green and useless — roughly 24 findings from 14,546 real
 * turns — because nobody measured it against real data until the end. This
 * script is that measurement, for the forecast: it prints the actual
 * windows, paces, ceilings and projections, and the actual candidate wall
 * proposals, over this machine's own history.
 *
 * Reads ~/.claude/projects/**\/*.jsonl directly rather than the database,
 * so it needs no deployment. Deduplicates by message.id: Claude Code writes
 * one line per content BLOCK, and a naive per-line count inflates
 * everything by ~2x.
 *
 * WINDOW_DAYS defaults to 45, wider than the session-rules gate's default,
 * because the forecast withholds a ceiling below MIN_HISTORY_DAYS (14) and
 * needs margin past that to say anything.
 *
 * Usage:
 *   node scripts/measure-forecast.mjs            windows + candidates + gate
 *   node scripts/measure-forecast.mjs --detail   also the hour-of-week model
 *   WINDOW_DAYS=30 node scripts/measure-forecast.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  detectCandidateWalls,
  hourOfWeekActivity,
  runForecast,
  toTimedUnits,
} from "../packages/shared/dist/index.js";

const WINDOW_DAYS = Number(process.env.WINDOW_DAYS ?? 45);
const DETAIL = process.argv.includes("--detail");
const root = join(homedir(), ".claude", "projects");
const now = new Date();
const nowMs = now.getTime();
const cutoffMs = nowMs - WINDOW_DAYS * 86_400_000;

function* jsonlFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(path);
    // mtime is a fast pre-filter, not the source of truth: session files are
    // append-only, so a file untouched since before the window cannot hold
    // any line inside it. Lines are still checked individually below,
    // because a file touched inside the window can still carry older lines
    // from earlier in the same session.
    else if (entry.name.endsWith(".jsonl") && statSync(path).mtimeMs > cutoffMs) {
      yield path;
    }
  }
}

let rawUsageLines = 0;
const events = [];

for (const file of jsonlFiles(root)) {
  const seen = new Set();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== "assistant") continue;
    const usage = row.message?.usage;
    const id = row.message?.id;
    if (!usage || !id) continue;

    const ts = Date.parse(row.timestamp);
    if (Number.isNaN(ts) || ts < cutoffMs || ts > nowMs) continue;

    rawUsageLines += 1;
    if (seen.has(id)) continue;
    seen.add(id);

    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;
    // Folded: cache tokens are a documented subset of inputTokens (see
    // UsageEventSchema's comment), the same convention
    // measure-session-rules.mjs uses for its "context" figure.
    const inputTokens = (usage.input_tokens ?? 0) + cacheRead + cacheCreation;

    events.push({
      timestamp: row.timestamp,
      inputTokens,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      features: { modelTier: "frontier" },
    });
  }
}

const dedupedCount = events.length;
const dedupRatio = dedupedCount > 0 ? rawUsageLines / dedupedCount : 0;

const forecast = runForecast(events, now.toISOString());
const sorted = toTimedUnits(events);
const candidates = detectCandidateWalls(sorted, nowMs, []);

console.log(`window:                 ${WINDOW_DAYS} days`);
console.log(`raw assistant lines:    ${rawUsageLines.toLocaleString("en-US")}`);
console.log(`deduped events:         ${dedupedCount.toLocaleString("en-US")}`);
console.log(`dedup ratio:            ${dedupRatio.toFixed(2)}x (raw / deduped; ~2x expected)`);
console.log(`history days:           ${forecast.historyDays.toFixed(1)}`);
console.log(
  `events without cache breakdown: ${forecast.eventsWithoutBreakdown} / ${forecast.eventsCounted}`,
);
console.log("");

for (const w of forecast.windows) {
  console.log(`── ${w.windowKind} ${"─".repeat(60 - w.windowKind.length)}`);
  console.log(`   current:          ${w.current.toFixed(1)} units`);
  console.log(`   pace:             ${w.pacePerHour.toFixed(1)} units/hour`);
  if (w.ceiling == null) {
    console.log(`   ceiling:          none`);
  } else {
    console.log(
      `   ceiling:          ${w.ceiling.toFixed(1)} units  [${w.ceilingProvenance}]`,
    );
    console.log(
      `   fraction:         ${((w.fractionOfCeiling ?? 0) * 100).toFixed(1)}%`,
    );
  }
  if (w.reachesCeilingAt) {
    console.log(`   projected:        reaches ceiling at ${w.reachesCeilingAt}`);
  } else {
    console.log(`   projected:        ${w.noProjectionReason ?? "(no reason given)"}`);
  }
  console.log("");
}

console.log(`candidates (${candidates.length}):`);
if (candidates.length === 0) {
  console.log("   none");
} else {
  for (const cand of candidates) {
    console.log(
      `   ${cand.id}`,
    );
    console.log(
      `     gap: ${cand.startsAt} .. ${cand.endsAt}  (${cand.gapHours.toFixed(1)}h)  ` +
        `trailing-7d before gap: ${cand.unitsInWindow.toFixed(1)} units`,
    );
  }
}
console.log("");

if (DETAIL) {
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const slots = hourOfWeekActivity(sorted);
  const ranked = slots
    .map((units, slot) => ({ slot, units }))
    .filter((s) => s.units > 0)
    .sort((a, b) => b.units - a.units)
    .slice(0, 20);

  console.log("top hour-of-week activity slots (UTC):");
  ranked.forEach(({ slot, units }, i) => {
    const day = DAY_NAMES[Math.floor(slot / 24)];
    const hour = slot % 24;
    console.log(
      `   #${(i + 1).toString().padStart(2, " ")}  ${day} ${hour.toString().padStart(2, "0")}:00  ${units.toFixed(1)} units`,
    );
  });
  console.log("");
}

let failed = false;
// Criterion 1: the projection is computable and sane.
for (const w of forecast.windows) {
  if (!Number.isFinite(w.current) || !Number.isFinite(w.pacePerHour)) {
    console.error(`FAIL: ${w.windowKind} produced a non-finite figure`);
    failed = true;
  }
  if (w.reachesCeilingAt && Date.parse(w.reachesCeilingAt) < Date.now() - 60_000) {
    console.error(`FAIL: ${w.windowKind} projects exhaustion in the past`);
    failed = true;
  }
}
// Criterion 2: detection is bounded. Unbounded proposals are noise, and a
// detector that fires constantly is worse than none — the user stops
// reading it.
if (candidates.length > 5) {
  console.error(
    `FAIL: ${candidates.length} wall candidates over ${WINDOW_DAYS} days is noise, not a prompt. ` +
      `Ship detection disabled and report this number rather than tuning until it looks right.`,
  );
  failed = true;
}

console.log(failed ? "GATE: FAIL" : "GATE: PASS");
process.exit(failed ? 1 : 0);
