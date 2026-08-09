import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { UsageEvent } from "@tokenops/shared";
import { createSessionParser } from "./claude-session.js";
import type { SessionOffsets } from "./session-offsets.js";

/**
 * First-run ceiling. Matches the back-test's own MAX_BACKTEST_EVENTS, so a
 * full backfill is exactly what one back-test window can consume; a larger
 * ceiling would ship events the headline figure could never reach.
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
 * Returns the offset of the last complete line, so a partial final line is
 * re-read intact next poll rather than being consumed and lost.
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
    readSync(fd, buf, 0, length, offset);
    const text = buf.toString("utf8");

    // Everything after the final newline is an incomplete line.
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) return offset;
    const complete = text.slice(0, lastNewline);

    for (const raw of complete.split("\n")) {
      const event = parser.parseLine(raw);
      if (!event) continue;
      if (!emit(event)) break; // ceiling reached
    }
    return offset + Buffer.byteLength(complete, "utf8") + 1;
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
  let emitted = 0;
  let ceilingLogged = false;
  /** One live parser per file, so a prompt read in one poll still pairs with
   *  the assistant turn that arrives in the next. */
  const parsers = new Map<string, ReturnType<typeof createSessionParser>>();

  const scan = (): void => {
    if (stopped) return;
    const cutoff = Date.now() - backfillDays * 24 * 3600 * 1000;
    let skipped = 0;

    for (const path of findSessionFiles(opts.rootDir)) {
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }

      const prior = opts.offsets.get(path);
      // Never open a file untouched since before the window — unless we have
      // already been reading it, in which case its tail is still live.
      if (!prior && st.mtimeMs < cutoff) continue;

      // A file smaller than its recorded offset was rotated or replaced.
      let offset = prior ? prior.offset : 0;
      if (st.size < offset) offset = 0;
      if (st.size === offset) continue;

      // One parser per FILE, kept alive across scans — not per scan.
      //
      // The parser carries the pending user prompt forward to the assistant
      // turn that follows it. A user line and its assistant reply routinely
      // land in different polls (the poll interval is far shorter than a
      // turn), so recreating the parser each scan would zero `promptChars`
      // for a large share of live turns — and promptChars is exactly what
      // full_document_io and context_bloat gate on. A Map keyed by path
      // keeps the pairing intact for the process's lifetime.
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
            `[tokenops] session backfill hit the ${ceiling}-event ceiling; ` +
              `at least ${skipped} turn(s) skipped. Raise sources.claude_code_backfill_days ` +
              `after this batch drains, or accept the window as bounded.`,
          );
          ceilingLogged = true;
        }
        break;
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
