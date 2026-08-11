import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { UsageEvent } from "@tokenops/shared";
import { createSessionParser } from "./claude-session.js";
import type { SessionOffsets } from "./session-offsets.js";

/**
 * Per-scan ceiling. Matches the back-test's own MAX_BACKTEST_EVENTS, so a
 * full backfill is exactly what one back-test window can consume; a larger
 * ceiling would ship events the headline figure could never reach.
 *
 * Scoped to a single scan(), not the process lifetime: a scan already reads
 * every file to EOF in one pass with no time-slicing, so bounding one scan
 * IS bounding one catch-up pass — whether that's the first cold start or a
 * pass after the agent was down a while. Combined with readFrom() never
 * advancing an offset past a turn the ceiling refused, anything not emitted
 * in one scan is simply retried, with a fresh budget, on the very next
 * scan — so steady-state tailing (a handful of new turns per poll) never
 * runs into an already-exhausted counter, and nothing refused is ever lost,
 * only deferred.
 */
export const MAX_BACKFILL_EVENTS = 20_000;

const DEFAULT_BACKFILL_DAYS = 7;
const DEFAULT_POLL_MS = 5_000;

export type WatchClaudeSessionsOptions = {
  rootDir: string;
  offsets: SessionOffsets;
  machineId: string;
  machineName: string;
  onEvent: (e: UsageEvent) => void;
  backfillDays?: number;
  maxBackfillEvents?: number;
  /** 0 means "scan once and do not schedule" — used by tests. */
  pollMs?: number;
  log?: Pick<Console, "info">;
};

/** Every *.jsonl under rootDir, one level of project directories deep or more. */
function findSessionFiles(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory is missing data, not a crash
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(rootDir);
  return out;
}

/**
 * Read from `offset` to EOF and emit an event per complete assistant turn.
 * Returns the offset of the last *fully processed* line — parsed and, if it
 * produced an event, successfully emitted. A line whose event was refused
 * (ceiling) is never counted: the offset must never move past data the
 * watcher refused, or a restart (or the next poll) can never recover it. A
 * trailing partial line is likewise left unconsumed, so it is read intact
 * next poll rather than being dropped mid-write.
 */
function readFrom(
  path: string,
  offset: number,
  size: number,
  parser: ReturnType<typeof createSessionParser>,
  emit: (e: UsageEvent) => boolean,
): number {
  if (size <= offset) return offset;
  const fd = openSync(path, "r");
  try {
    const length = size - offset;
    const buf = Buffer.allocUnsafe(length);
    // readSync can legitimately return fewer bytes than requested (e.g. the
    // file was truncated between statSync and this call, which is exactly
    // the rotation race this watcher has to survive). `buf` beyond `n` is
    // uninitialized heap memory — decoding it would parse garbage and push
    // the persisted offset past real unread data.
    const n = readSync(fd, buf, 0, length, offset);
    const text = buf.subarray(0, n).toString("utf8");

    // Everything after the final newline is an incomplete line.
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) return offset;
    const complete = text.slice(0, lastNewline);

    // Byte-accurate (not char-index) accumulation: a UTF-8 line's on-disk
    // length and its decoded string length diverge for any multi-byte
    // character, and the persisted offset is a byte offset into the file.
    let consumedBytes = 0;
    for (const raw of complete.split("\n")) {
      const lineBytes = Buffer.byteLength(raw, "utf8") + 1; // + its newline
      const event = parser.parseLine(raw);
      if (event && !emit(event)) break; // ceiling refused this line — stop
      consumedBytes += lineBytes;
    }
    return offset + consumedBytes;
  } finally {
    closeSync(fd);
  }
}

/**
 * Watch Claude Code's own session files and emit one event per assistant turn.
 *
 * Files older than the backfill window are never opened, so the ~1.4 GB on
 * disk is not parsed. Within the window, reading resumes from a persisted
 * per-file offset.
 */
export function watchClaudeSessions(
  opts: WatchClaudeSessionsOptions,
): { rescan(): void; stop(): void } {
  const backfillDays = opts.backfillDays ?? DEFAULT_BACKFILL_DAYS;
  const ceiling = opts.maxBackfillEvents ?? MAX_BACKFILL_EVENTS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const log = opts.log ?? console;

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  /** One live parser per file, so a prompt read in one poll still pairs with
   *  the assistant turn that arrives in the next. */
  const parsers = new Map<string, ReturnType<typeof createSessionParser>>();

  const scan = (): void => {
    if (stopped) return;
    const cutoff = Date.now() - backfillDays * 24 * 3600 * 1000;
    // Scoped to THIS scan — see MAX_BACKFILL_EVENTS's doc comment for why a
    // counter that survives across polls is the severe version of this bug.
    let skipped = 0;
    let emitted = 0;
    let ceilingLogged = false;

    for (const path of findSessionFiles(opts.rootDir)) {
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }

      // A vanished/rotated file between statSync and here (openSync,
      // readSync, the offsets store, or a throwing onEvent) must cost this
      // one file, never the process: missing data, not a crash.
      try {
        const prior = opts.offsets.get(path);
        // Never open a file untouched since before the window — unless we
        // have already been reading it, in which case its tail is live.
        if (!prior && st.mtimeMs < cutoff) continue;

        // A file smaller than its recorded offset was rotated or replaced.
        let offset = prior ? prior.offset : 0;
        if (st.size < offset) offset = 0;
        if (st.size === offset) continue;

        // One parser per FILE, kept alive across scans — not per scan.
        //
        // The parser carries the pending user prompt forward to the
        // assistant turn that follows it. A user line and its assistant
        // reply routinely land in different polls (the poll interval is far
        // shorter than a turn), so recreating the parser each scan would
        // zero `promptChars` for a large share of live turns — and
        // promptChars is exactly what full_document_io and context_bloat
        // gate on. A Map keyed by path keeps the pairing intact for the
        // process's lifetime.
        let parser = parsers.get(path);
        if (!parser || offset === 0) {
          // offset === 0 means first read or a rotation: start clean.
          parser = createSessionParser({
            machineId: opts.machineId,
            machineName: opts.machineName,
          });
          parsers.set(path, parser);
        }

        const next = readFrom(path, offset, st.size, parser, (event) => {
          if (emitted >= ceiling) {
            skipped += 1;
            return false;
          }
          opts.onEvent(event);
          emitted += 1;
          return true;
        });

        opts.offsets.set(path, next, st.size);

        if (emitted >= ceiling) {
          if (!ceilingLogged) {
            log.info(
              `[tokenops] session backfill hit the ${ceiling}-event ceiling for ` +
                `this poll; ${skipped} turn(s) in this file plus any files not ` +
                `yet reached will be retried next poll (offsets were not ` +
                `advanced past them, so nothing is lost).`,
            );
            ceilingLogged = true;
          }
          break;
        }
      } catch {
        continue;
      }
    }
  };

  scan();
  if (pollMs > 0) {
    timer = setInterval(scan, pollMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  return {
    /** Run one scan now. The seam that makes multi-poll behavior testable
     *  without waiting on a timer. */
    rescan(): void {
      scan();
    },
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      parsers.clear();
    },
  };
}
