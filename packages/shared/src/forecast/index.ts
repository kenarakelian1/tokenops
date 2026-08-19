import type { UsageEvent } from "../schema/event.js";
import { hasCacheBreakdown } from "./units.js";
import {
  pacePerHour,
  projectWindow,
  toTimedUnits,
  trailingWindow,
  windowHistory,
  type TimedUnit,
} from "./windows.js";
import {
  WINDOW_HOURS,
  type Forecast,
  type LimitObservation,
  type LimitProvenance,
  type WindowForecast,
  type WindowKind,
} from "./types.js";

export * from "./types.js";
export {
  consumptionUnits,
  hasCacheBreakdown,
  OUTPUT_UNIT_WEIGHT,
  RAW_INPUT_UNIT_WEIGHT,
} from "./units.js";
export {
  PACE_HOURS,
  PROJECTION_HORIZON_HOURS,
  PROJECTION_STEP_HOURS,
  pacePerHour,
  projectWindow,
  toTimedUnits,
  trailingWindow,
  windowHistory,
  type TimedUnit,
} from "./windows.js";
export {
  CANDIDATE_MIN_GAP_HOURS,
  CANDIDATE_MIN_ACTIVE_HOURS,
  CANDIDATE_TOP_DECILE,
  CANDIDATE_ACTIVE_PRESENCE_THRESHOLD,
  detectCandidateWalls,
  hourOfWeekActivity,
} from "./candidates.js";

/**
 * Below this, a "historical maximum" is just the current period restated, so
 * no ceiling is offered at all. Reporting one would be circular: the number
 * you are compared against would be the number you just produced.
 */
export const MIN_HISTORY_DAYS = 14;

/** Sampling granularity for the historical-maximum sweep. */
export const HISTORY_SAMPLE_STEP_HOURS = 1;

const MS_PER_HOUR = 3_600_000;
const WINDOW_ORDER: WindowKind[] = ["session_5h", "weekly_7d"];

/** The most recent ACTIVE declaration for a window, or null. */
function activeDeclaration(
  observations: LimitObservation[],
  windowKind: WindowKind,
): LimitObservation | null {
  const active = observations
    .filter((o) => o.windowKind === windowKind && o.status === "active")
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  return active[0] ?? null;
}

function forecastWindow(
  sorted: TimedUnit[],
  nowMs: number,
  windowKind: WindowKind,
  historyDays: number,
  observations: LimitObservation[],
): WindowForecast {
  const hours = WINDOW_HOURS[windowKind];
  const current = trailingWindow(sorted, nowMs, hours);
  const pace = pacePerHour(sorted, nowMs);

  /**
   * INVARIANT: `ceiling` is either `null` (no ceiling can be justified) or a
   * strictly positive number — never `0`. Both branches below enforce this
   * at the one place `ceiling` is ever assigned, so every downstream reader
   * (this function's own `fractionOfCeiling` below, `projectWindow`, and the
   * UI's `ceilingClause`/`projectionClause`) can treat `ceiling != null` as
   * a single three-way switch without a second, independent falsy-vs-null
   * check of its own to keep in sync.
   *
   * That second check is exactly what went wrong before this comment
   * existed (I1): `fractionOfCeiling` read a stored `ceiling: 0` as falsy
   * ("no ceiling") while `projectWindow`'s `current >= ceiling` read that
   * same `0` as "already exceeded" — one `WindowForecast` rendering both
   * "No ceiling established yet." and a projected reach date at once. A
   * zero-unit declaration is now rejected at the API route that creates one
   * (see `POST /v1/limit-observations` in forecast.ts), so this should never
   * see `declared.unitsInWindow <= 0` in practice; the guard stays here too
   * so any other path that ever constructs a `LimitObservation` — a fixture,
   * a migration, a future caller — degrades to "no ceiling" (or falls
   * through to the inferred branch) instead of resurrecting the
   * self-contradiction.
   */
  let ceiling: number | null = null;
  let ceilingProvenance: LimitProvenance | null = null;

  const declared = activeDeclaration(observations, windowKind);
  if (declared != null && declared.unitsInWindow > 0) {
    ceiling = declared.unitsInWindow;
    ceilingProvenance = declared.provenance;
  } else if (historyDays >= MIN_HISTORY_DAYS && sorted.length > 0) {
    // The user's own maximum is a LOWER BOUND on their real limit: they
    // reached it, so the limit is at least that. That is the strongest
    // honest claim available without them telling us anything.
    const history = windowHistory(
      sorted,
      hours,
      sorted[0]!.at,
      nowMs,
      HISTORY_SAMPLE_STEP_HOURS,
    );
    const max = history.reduce((m, p) => (p.units > m ? p.units : m), 0);
    if (max > 0) {
      ceiling = max;
      ceilingProvenance = "inferred";
    }
  }

  const projected = projectWindow(sorted, nowMs, hours, ceiling);
  const noProjectionReason =
    ceiling == null && historyDays < MIN_HISTORY_DAYS
      ? `needs ${MIN_HISTORY_DAYS} days of history before a ceiling means anything (have ${Math.floor(historyDays)})`
      : projected.reason;

  return {
    windowKind,
    current,
    pacePerHour: pace,
    ceiling,
    ceilingProvenance,
    // `ceiling` is never `0` here (see the invariant above `let ceiling`),
    // so a plain nullness check is enough — no `ceiling > 0` falsy check
    // needed, and adding one back would silently reopen I1.
    fractionOfCeiling: ceiling != null ? current / ceiling : null,
    reachesCeilingAt:
      projected.reachesAtMs == null ? null : new Date(projected.reachesAtMs).toISOString(),
    noProjectionReason,
  };
}

/**
 * The whole forecast, from events alone.
 *
 * `now` is an explicit parameter so replays are deterministic — the same
 * discipline the rules' pricing instant follows.
 *
 * Candidate detection is NOT performed here; callers pass detected candidates
 * through separately, because a candidate only becomes a ceiling once the
 * user has confirmed it and it has been stored as a declaration.
 *
 * `presorted`, when given, is used instead of recomputing `toTimedUnits(events)`
 * — purely an optimization for `GET /v1/forecast`, which also needs the same
 * sorted series for `detectCandidatesSafely` and would otherwise sort the
 * same (potentially large) event array twice per request (M5). Every other
 * caller omits it and gets the old behavior.
 *
 * `historyStartIso`, when given, overrides `sorted[0].at` as the origin
 * `historyDays` is measured from. See the comment above `historyStartMs`
 * below for why this exists (defect A, 2026-08-16 review): without it,
 * `historyDays` silently meant "days retained after `EVENTS_SINCE_MAX`
 * truncation" rather than "days of real history", and a dense-enough user
 * could have their ceiling withheld — "needs 14 days of history (have 12)"
 * — despite forty real days on file. Every caller but `GET /v1/forecast`
 * omits it and falls back to `sorted[0].at`; none of those paths ever
 * truncates.
 */
export function runForecast(
  events: UsageEvent[],
  nowIso: string,
  observations: LimitObservation[] = [],
  presorted?: TimedUnit[],
  historyStartIso?: string | null,
): Forecast {
  const nowMs = Date.parse(nowIso);
  const sorted = presorted ?? toTimedUnits(events);

  // The TRUE origin of `historyDays`: the real oldest matching event, not
  // merely the oldest one that survived `EVENTS_SINCE_MAX`'s row cap (see
  // events-repo.ts). `GET /v1/forecast` passes `historyStartIso` from
  // `EventsRepo.eventsSince`'s `historyStartIso` field, which is computed by
  // a MIN(timestamp) query scoped identically to the capped fetch but NOT
  // subject to its row limit — so it stays accurate even when the cap bit.
  // Falling back to `sorted[0]!.at` (the old behavior) is only correct when
  // nothing was truncated, which is true for every caller that omits this
  // parameter.
  const historyStartMs =
    historyStartIso != null
      ? Date.parse(historyStartIso)
      : sorted.length > 0
        ? sorted[0]!.at
        : NaN;

  // Clamped once, here — the single source of truth for `historyDays` — and
  // used everywhere downstream, rather than clamping only the returned
  // field while `forecastWindow` (below) interpolates the raw, unclamped
  // value into its `noProjectionReason` copy via `Math.floor(historyDays)`.
  // A future-dated first event (nowMs < historyStartMs, e.g. clock skew)
  // makes the raw value negative; without a single clamp point, that
  // negative count would print in user-facing copy ("have -3") even though
  // the returned `historyDays` field itself correctly reported `0` (M3).
  const rawHistoryDays = Number.isNaN(historyStartMs)
    ? 0
    : (nowMs - historyStartMs) / (24 * MS_PER_HOUR);
  const historyDays = Math.max(0, rawHistoryDays);

  let withoutBreakdown = 0;
  for (const e of events) {
    // Same exclusion `toTimedUnits` applies: an event whose timestamp fails
    // to parse never entered `sorted`, so it must not enter this count
    // either. Without this, `eventsWithoutBreakdown` (drawn from raw
    // `events`) and `eventsCounted` (drawn from `sorted`, below) would be
    // counted over two different populations, and `BreakdownNote` could
    // print "N of M" with N > M for a caller passing an unparseable
    // timestamp.
    if (Number.isNaN(Date.parse(e.timestamp))) continue;
    if (!hasCacheBreakdown(e)) withoutBreakdown += 1;
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    windows: WINDOW_ORDER.map((k) =>
      forecastWindow(sorted, nowMs, k, historyDays, observations),
    ),
    historyDays,
    eventsWithoutBreakdown: withoutBreakdown,
    // `sorted.length`, not `events.length`: toTimedUnits (whether computed
    // here or passed in as `presorted`) silently drops any event whose
    // timestamp fails to parse, so every window figure above is already
    // computed over `sorted`. Counting raw `events` here would let
    // `BreakdownNote`'s "X of Y events" denominator include events that are
    // invisible to the window maths the sentence is describing (M4).
    eventsCounted: sorted.length,
    candidates: [],
    // Set by the route that fetches events from the repo, which is the only
    // place that knows whether that fetch was capped (see the `truncated`
    // field's doc comment in types.ts).
    truncated: false,
  };
}
