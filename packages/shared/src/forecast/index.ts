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

  let ceiling: number | null = null;
  let ceilingProvenance: LimitProvenance | null = null;

  const declared = activeDeclaration(observations, windowKind);
  if (declared) {
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
    fractionOfCeiling: ceiling && ceiling > 0 ? current / ceiling : null,
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
 */
export function runForecast(
  events: UsageEvent[],
  nowIso: string,
  observations: LimitObservation[] = [],
): Forecast {
  const nowMs = Date.parse(nowIso);
  const sorted = toTimedUnits(events);

  const historyDays =
    sorted.length === 0 ? 0 : (nowMs - sorted[0]!.at) / (24 * MS_PER_HOUR);

  let withoutBreakdown = 0;
  for (const e of events) if (!hasCacheBreakdown(e)) withoutBreakdown += 1;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    windows: WINDOW_ORDER.map((k) =>
      forecastWindow(sorted, nowMs, k, historyDays, observations),
    ),
    historyDays: Math.max(0, historyDays),
    eventsWithoutBreakdown: withoutBreakdown,
    eventsCounted: events.length,
    candidates: [],
  };
}
