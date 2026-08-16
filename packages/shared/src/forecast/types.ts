/**
 * Where a limit figure came from, and therefore how much it can be trusted.
 *
 * This is a field rather than a comment because the whole design depends on
 * an authoritative "429 in 60 seconds" never rendering like an inferred
 * "you may have hit a wall in July". The UI shows it beside every number.
 */
export type LimitProvenance = "measured" | "reported" | "declared" | "inferred";

/** The two windows Anthropic actually enforces on subscription plans. */
export type WindowKind = "session_5h" | "weekly_7d";

/** Hours in each window. The single definition. */
export const WINDOW_HOURS: Record<WindowKind, number> = {
  session_5h: 5,
  weekly_7d: 24 * 7,
};

/**
 * A limit the user has actually observed, or a candidate awaiting their
 * judgement. `dismissed` candidates are retained so the detector never
 * proposes the same moment twice.
 */
export type LimitObservationStatus = "active" | "superseded" | "dismissed";

export type LimitObservation = {
  id: string;
  windowKind: WindowKind;
  /** When the limit was hit, ISO. */
  observedAt: string;
  /** The trailing-window total at that instant, in consumption units. */
  unitsInWindow: number;
  provenance: LimitProvenance;
  status: LimitObservationStatus;
};

/** A possible limit hit, detected from history. NEVER a ceiling on its own. */
export type WallCandidate = {
  /** Stable id derived from the gap's bounds, so re-running proposes the same key. */
  id: string;
  windowKind: WindowKind;
  startsAt: string;
  endsAt: string;
  gapHours: number;
  /** Trailing-window total immediately before the gap began. */
  unitsInWindow: number;
};

/** One window's answer. */
export type WindowForecast = {
  windowKind: WindowKind;
  /** Consumption units currently inside the trailing window. */
  current: number;
  /** Units per hour over the trailing PACE_HOURS. */
  pacePerHour: number;
  /** The ceiling being compared against, or null when none can be justified. */
  ceiling: number | null;
  ceilingProvenance: LimitProvenance | null;
  /** Fraction of the ceiling consumed, or null when there is no ceiling. */
  fractionOfCeiling: number | null;
  /** ISO instant the window is projected to reach the ceiling, or null. */
  reachesCeilingAt: string | null;
  /**
   * Why there is no projection, when reachesCeilingAt is null. Rendered to
   * the user, so it must read as an explanation rather than an error code.
   */
  noProjectionReason: string | null;
};

export type Forecast = {
  generatedAt: string;
  windows: WindowForecast[];
  /** Days of history available. Below MIN_HISTORY_DAYS, ceilings are withheld. */
  historyDays: number;
  /** Events counted without a cache breakdown, and the total counted. */
  eventsWithoutBreakdown: number;
  eventsCounted: number;
  candidates: WallCandidate[];
};
