import { WINDOW_HOURS, type WallCandidate } from "./types.js";
import { trailingWindow, type TimedUnit } from "./windows.js";

const MS_PER_HOUR = 3_600_000;

/** A gap shorter than this is a night's sleep, not a wall. */
export const CANDIDATE_MIN_GAP_HOURS = 12;

/** How many of the gap's hours must land in the user's own active hours. */
export const CANDIDATE_MIN_ACTIVE_HOURS = 4;

/** How heavy the preceding window must be, as a quantile of the user's own history. */
export const CANDIDATE_TOP_DECILE = 0.9;

/**
 * Total units per hour-of-week slot (0 = Sunday 00:00 UTC .. 167).
 *
 * This is the user's own rhythm, derived rather than assumed. It is what lets
 * the detector tell "stopped because blocked" from "stopped because it was
 * Saturday" without anyone hard-coding a working week.
 */
export function hourOfWeekActivity(sorted: TimedUnit[]): number[] {
  const slots = new Array<number>(168).fill(0);
  for (const p of sorted) {
    const d = new Date(p.at);
    slots[d.getUTCDay() * 24 + d.getUTCHours()]! += p.units;
  }
  return slots;
}

/**
 * Hour-of-week slots the user is normally active in.
 *
 * Deliberately frequency-based rather than magnitude-based: "active" means
 * this slot saw activity in most of its calendar occurrences across the
 * observed span, regardless of how much. A magnitude threshold (e.g. a
 * median of summed units) is not robust to the very thing this detector is
 * looking for — a single unusually heavy episode inflates its own slot and
 * can push an ordinary but comparatively quieter slot below the cutoff,
 * exactly when that slot is what should decide whether the following gap is
 * an ordinary non-working stretch.
 */
function activeSlots(sorted: TimedUnit[], nowMs: number): Set<number> {
  if (sorted.length === 0) return new Set();

  const presentHours = new Set<number>();
  for (const p of sorted) presentHours.add(Math.floor(p.at / MS_PER_HOUR));

  const startHour = Math.floor(sorted[0]!.at / MS_PER_HOUR);
  const endHour = Math.floor((nowMs - 1) / MS_PER_HOUR);

  const occurrences = new Array<number>(168).fill(0);
  const present = new Array<number>(168).fill(0);
  for (let h = startHour; h <= endHour; h += 1) {
    const t = new Date(h * MS_PER_HOUR);
    const slot = t.getUTCDay() * 24 + t.getUTCHours();
    occurrences[slot]! += 1;
    if (presentHours.has(h)) present[slot]! += 1;
  }

  const out = new Set<number>();
  for (let slot = 0; slot < 168; slot += 1) {
    if (occurrences[slot]! > 0 && present[slot]! / occurrences[slot]! >= 0.5) {
      out.add(slot);
    }
  }
  return out;
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor(q * s.length));
  return s[idx]!;
}

/**
 * Find periods that MIGHT have been limit hits.
 *
 * This function proposes; it never decides. Its output is a question for the
 * user, and only their confirmation turns one into a ceiling. That constraint
 * is the reason it can exist at all: there is no ground truth in the data —
 * Claude Code records no limit marker anywhere — so a detector that set
 * ceilings by itself would be guessing with authority it has not earned.
 *
 * All three conditions must hold:
 *   1. a zero-consumption gap of at least CANDIDATE_MIN_GAP_HOURS
 *   2. the trailing 7-day total just before it sits in the user's own top decile
 *   3. at least CANDIDATE_MIN_ACTIVE_HOURS of the gap fall in hours the user
 *      is normally active
 *
 * Condition 3 is what excludes weekends and holidays, using the user's own
 * observed rhythm rather than an assumed working week.
 */
export function detectCandidateWalls(
  sorted: TimedUnit[],
  nowMs: number,
  dismissedIds: string[],
): WallCandidate[] {
  if (sorted.length === 0) return [];

  const dismissed = new Set(dismissedIds);
  const active = activeSlots(sorted, nowMs);
  const weeklyHours = WINDOW_HOURS.weekly_7d;

  // The user's own distribution of trailing-7d totals, sampled at each event.
  const trailingAtEvents = sorted.map((p) => trailingWindow(sorted, p.at, weeklyHours));
  const heavyThreshold = quantile(trailingAtEvents, CANDIDATE_TOP_DECILE);

  const out: WallCandidate[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const startAt = sorted[i]!.at;
    const nextAt = i + 1 < sorted.length ? sorted[i + 1]!.at : nowMs;
    const gapHours = (nextAt - startAt) / MS_PER_HOUR;
    if (gapHours < CANDIDATE_MIN_GAP_HOURS) continue;

    // Condition 2: was the run-up unusually heavy for THIS user?
    const before = trailingAtEvents[i]!;
    if (before < heavyThreshold || before <= 0) continue;

    // Condition 3: does the gap cover hours they would normally be working?
    let activeHours = 0;
    for (let h = 0; h < Math.floor(gapHours); h += 1) {
      const t = new Date(startAt + h * MS_PER_HOUR);
      if (active.has(t.getUTCDay() * 24 + t.getUTCHours())) activeHours += 1;
    }
    if (activeHours < CANDIDATE_MIN_ACTIVE_HOURS) continue;

    const id = `wall:${new Date(startAt).toISOString()}:${Math.round(gapHours)}`;
    if (dismissed.has(id)) continue;

    out.push({
      id,
      windowKind: "weekly_7d",
      startsAt: new Date(startAt).toISOString(),
      endsAt: new Date(nextAt).toISOString(),
      gapHours,
      unitsInWindow: before,
    });
  }
  return out;
}
