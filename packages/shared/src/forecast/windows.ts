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
