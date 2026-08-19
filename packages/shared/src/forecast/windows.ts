import type { UsageEvent } from "../schema/event.js";
import { consumptionUnits } from "./units.js";

const MS_PER_HOUR = 3_600_000;

/** One event reduced to what the window maths needs. Epoch ms. */
export type TimedUnit = { at: number; units: number };

/**
 * Reduce events to a time-sorted unit series.
 *
 * Sorting once here is what lets every later scan be linear. Events whose
 * timestamp does not parse are dropped rather than admitted as NaN, which
 * would silently poison every sum they touch.
 */
export function toTimedUnits(events: UsageEvent[]): TimedUnit[] {
  const out: TimedUnit[] = [];
  for (const e of events) {
    const at = Date.parse(e.timestamp);
    if (Number.isNaN(at)) continue;
    out.push({ at, units: consumptionUnits(e) });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/**
 * Units inside the half-open trailing window `(at - hours, at]`.
 *
 * The boundary is half-open on purpose: an event exactly `hours` old has
 * rolled out. `projectWindow` computes its outflow term over the same
 * boundary, so any other choice here would double-count events at the edge.
 */
export function trailingWindow(
  sorted: TimedUnit[],
  atMs: number,
  hours: number,
): number {
  const from = atMs - hours * MS_PER_HOUR;
  let total = 0;
  for (const p of sorted) {
    if (p.at <= from) continue;
    if (p.at > atMs) break; // sorted: nothing later can qualify
    total += p.units;
  }
  return total;
}

/**
 * The trailing window sampled every `stepHours` across [fromMs, toMs].
 *
 * Implemented as a two-pointer sweep rather than calling trailingWindow per
 * sample: 30 days sampled hourly against a 7-day window is 720 samples over
 * 15k+ real events, and the naive form is quadratic. Both pointers only ever
 * advance, so the whole history is walked twice regardless of sample count.
 */
export function windowHistory(
  sorted: TimedUnit[],
  hours: number,
  fromMs: number,
  toMs: number,
  stepHours: number,
): { at: number; units: number }[] {
  if (toMs < fromMs) return [];
  const span = hours * MS_PER_HOUR;
  const step = stepHours * MS_PER_HOUR;

  const out: { at: number; units: number }[] = [];
  let head = 0; // first index NOT yet added (p.at <= at)
  let tail = 0; // first index still inside the window (p.at > at - span)
  let total = 0;

  for (let at = fromMs; at <= toMs; at += step) {
    while (head < sorted.length && sorted[head]!.at <= at) {
      total += sorted[head]!.units;
      head += 1;
    }
    const windowOpensAt = at - span;
    while (tail < head && sorted[tail]!.at <= windowOpensAt) {
      total -= sorted[tail]!.units;
      tail += 1;
    }
    out.push({ at, units: total });
  }
  return out;
}

/** Trailing hours the pace is averaged over. */
export const PACE_HOURS = 24;

/** How far ahead the projection looks before giving up. */
export const PROJECTION_HORIZON_HOURS = 24 * 14;

/** Simulation granularity. */
export const PROJECTION_STEP_HOURS = 1;

/** Units per hour over the trailing PACE_HOURS. */
export function pacePerHour(sorted: TimedUnit[], nowMs: number): number {
  return trailingWindow(sorted, nowMs, PACE_HOURS) / PACE_HOURS;
}

/**
 * When will this trailing window reach `ceiling`?
 *
 * A trailing total does NOT simply grow at the current pace: as time
 * advances, old events leave the window. Extrapolating `current + pace * t`
 * ignores that and systematically over-predicts exhaustion — a steady-state
 * user would be told they are about to run out, forever.
 *
 * So this simulates forward:
 *
 *   trailing(t) = [real events still in the window at t]   // outflow, EXACT
 *               + pace * min(t - now, hours)                // assumed inflow
 *
 * The first term is exact because those events are already in the ledger —
 * it is `current` minus whatever has aged out by `t`, tracked with an
 * advancing pointer.
 *
 * The second term is capped at `pace * hours`, not `pace * (t - now)`. Past
 * `hours` from now, the assumed future inflow rolling in at the head of the
 * window is itself old enough to be rolling out the tail — a steady pace
 * saturates the window at `pace * hours` and goes no higher. Without the
 * cap, projecting far enough ahead (the horizon is 14 days; the window may
 * be hours wide) always eventually crosses any ceiling, even one a
 * steady-state user will never actually reach — silently reintroducing the
 * unbounded-growth failure this function exists to avoid, just delayed
 * instead of eliminated.
 *
 * Returns `reachesAtMs: null` with a human-readable `reason` whenever no
 * honest projection exists. The reason is rendered to the user, so it reads
 * as an explanation rather than an error code.
 */
export function projectWindow(
  sorted: TimedUnit[],
  nowMs: number,
  hours: number,
  ceiling: number | null,
): { reachesAtMs: number | null; reason: string | null } {
  if (ceiling == null) {
    return { reachesAtMs: null, reason: "no ceiling to project against" };
  }

  const current = trailingWindow(sorted, nowMs, hours);
  if (current >= ceiling) return { reachesAtMs: nowMs, reason: null };

  const pace = pacePerHour(sorted, nowMs);
  if (pace <= 0) {
    return { reachesAtMs: null, reason: "no recent consumption to project from" };
  }

  const span = hours * MS_PER_HOUR;

  // Outflow accumulates as the window's opening edge sweeps forward, so the
  // pointer only ever advances — the whole series is walked once across all
  // steps, not re-scanned per step.
  let outflow = 0;
  let tail = 0;
  while (tail < sorted.length && sorted[tail]!.at <= nowMs - span) tail += 1;

  for (
    let h = PROJECTION_STEP_HOURS;
    h <= PROJECTION_HORIZON_HOURS;
    h += PROJECTION_STEP_HOURS
  ) {
    const t = nowMs + h * MS_PER_HOUR;
    const windowOpensAt = t - span;
    while (tail < sorted.length && sorted[tail]!.at <= windowOpensAt) {
      outflow += sorted[tail]!.units;
      tail += 1;
    }
    const projected = current - outflow + pace * Math.min(h, hours);
    if (projected >= ceiling) return { reachesAtMs: t, reason: null };

    // Once h reaches the window width, the assumed-inflow term is fully
    // saturated (Math.min(h, hours) stops growing) and outflow is
    // non-decreasing (consumptionUnits is clamped non-negative), so
    // `projected` cannot exceed what it already was at this step for any
    // larger h. If the ceiling isn't reached by here, it never will be —
    // continuing to PROJECTION_HORIZON_HOURS would only re-confirm that.
    if (h >= hours) break;
  }

  return {
    reachesAtMs: null,
    reason: "not reachable at this pace",
  };
}
