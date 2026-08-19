import { WINDOW_HOURS, type WallCandidate } from "./types.js";
import { type TimedUnit } from "./windows.js";

const MS_PER_HOUR = 3_600_000;

/** A gap shorter than this is a night's sleep, not a wall. */
export const CANDIDATE_MIN_GAP_HOURS = 12;

/** How many of the gap's hours must land in the user's own active hours. */
export const CANDIDATE_MIN_ACTIVE_HOURS = 4;

/** How heavy the preceding window must be, as a quantile of the user's own history. */
export const CANDIDATE_TOP_DECILE = 0.9;

/**
 * Fraction of a slot's calendar occurrences that must have seen activity for
 * that hour-of-week to count as one of the user's normally-active hours.
 *
 * A fourth detector constant, governing behaviour exactly as directly as the
 * three above — named and exported rather than left as a bare literal buried
 * in a comparison.
 */
export const CANDIDATE_ACTIVE_PRESENCE_THRESHOLD = 0.5;

/**
 * Total units per hour-of-week slot (0 = Sunday 00:00 UTC .. 167).
 *
 * A raw magnitude profile of the user's own rhythm: how much was consumed in
 * each hour-of-week, summed across the whole observed history. Exported for
 * callers that want to *display* that rhythm (e.g. a forecast panel).
 *
 * Candidate detection deliberately does NOT consume this. A magnitude
 * threshold is exactly the kind of thing an unusually heavy episode
 * distorts — see `activeSlots` below, which derives "normally active" from
 * presence in the raw event series instead.
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
 * Deliberately frequency-based rather than magnitude-based, and built
 * directly from the event series rather than from `hourOfWeekActivity`'s
 * summed totals: "active" means this slot saw activity in at least
 * CANDIDATE_ACTIVE_PRESENCE_THRESHOLD of its calendar occurrences across the
 * observed span, regardless of how much activity. A magnitude threshold
 * (e.g. a median of summed units) is not robust to the very thing this
 * detector is looking for: a single unusually heavy episode inflates its own
 * slot's total, which can push an ordinary but comparatively lower-volume
 * slot below a magnitude cutoff even though both are worked equally often.
 * It is also not robust in the ordinary case — a magnitude median discards
 * roughly half of any user's genuinely-worked hours by construction, spike
 * or no spike.
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
    if (
      occurrences[slot]! > 0 &&
      present[slot]! / occurrences[slot]! >= CANDIDATE_ACTIVE_PRESENCE_THRESHOLD
    ) {
      out.add(slot);
    }
  }
  return out;
}

/**
 * The trailing-window total sampled at each event, in one linear pass.
 *
 * Equivalent to `sorted.map((p) => trailingWindow(sorted, p.at, hours))`,
 * but that form is O(n^2): each call rescans from the start. Since `sorted`
 * is ascending and the window width is fixed, the trailing edge only ever
 * advances as the sampling point advances, so a single two-pointer sweep
 * suffices — the same idiom `windowHistory` in windows.ts uses, and for the
 * same reason (this file's own top-decile scan is exactly the "30 days
 * hourly against a 7-day window" shape that function's docstring warns
 * about).
 *
 * `trailingWindow`'s boundary `(at - hours, at]` is a pure function of a
 * timestamp *value* — it has no notion of array position, so two events
 * sharing a timestamp always see each other. A naive index-order sweep does
 * not: it would add `sorted[i].units` to the running total and record that
 * total for index `i` before a later-indexed event at the *same* timestamp
 * had been folded in, undercounting every index but the last in a tied run.
 * So before recording a value for any index, the sweep first walks the head
 * pointer through the *entire* run of indices sharing that timestamp and
 * folds all of them into `total`, then writes that one total back across
 * every index in the run. Ties are rare in practice but not theoretical:
 * TokenOps ingests per-message events across multiple machines, and
 * concurrent sessions can land in the same millisecond.
 */
function trailingAtEachEvent(sorted: TimedUnit[], hours: number): number[] {
  const span = hours * MS_PER_HOUR;
  const out = new Array<number>(sorted.length).fill(0);
  let tail = 0;
  let total = 0;
  let i = 0;
  while (i < sorted.length) {
    const at = sorted[i]!.at;
    let j = i;
    while (j < sorted.length && sorted[j]!.at === at) {
      total += sorted[j]!.units;
      j += 1;
    }
    const windowOpensAt = at - span;
    while (tail < j && sorted[tail]!.at <= windowOpensAt) {
      total -= sorted[tail]!.units;
      tail += 1;
    }
    for (let k = i; k < j; k += 1) out[k] = total;
    i = j;
  }
  return out;
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
  const trailingAtEvents = trailingAtEachEvent(sorted, weeklyHours);
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
    // Starts at h = 1, not h = 0: h = 0 is startAt itself, the hour the last
    // event actually landed in, which is by construction always an hour the
    // user was present. Counting it would hand every candidate a free active
    // hour and silently turn CANDIDATE_MIN_ACTIVE_HOURS = 4 into a threshold
    // of 3.
    let activeHours = 0;
    for (let h = 1; h < Math.floor(gapHours); h += 1) {
      const t = new Date(startAt + h * MS_PER_HOUR);
      if (active.has(t.getUTCDay() * 24 + t.getUTCHours())) activeHours += 1;
    }
    if (activeHours < CANDIDATE_MIN_ACTIVE_HOURS) continue;

    // Keyed on startAt alone: a gap is uniquely identified by the event that
    // opens it. Rounded gapHours added no discriminating information for a
    // closed gap (nextAt is a fixed prior event, so gapHours was already
    // constant) and was actively harmful for the trailing gap at the end of
    // history, where nextAt = nowMs grows every time detection runs — a
    // gapHours-keyed id changed hour to hour, so a dismissal of "this gap"
    // could never survive being asked again. Keying on startAt alone means a
    // dismissal also survives the gap later closing when the user resumes.
    const id = `wall:${new Date(startAt).toISOString()}`;
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

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor(q * s.length));
  return s[idx]!;
}
