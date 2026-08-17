import { describe, expect, it } from "vitest";
import { toTimedUnits } from "./windows.js";
import type { UsageEvent } from "../schema/event.js";
import {
  CANDIDATE_MIN_GAP_HOURS,
  detectCandidateWalls,
  hourOfWeekActivity,
} from "./candidates.js";

const H = 3_600_000;
// A Wednesday, so weekday/weekend cases are unambiguous.
const T0 = Date.parse("2026-07-01T00:00:00.000Z");

function ev(hourOffset: number, inputTokens: number): UsageEvent {
  return {
    eventId: `e${hourOffset}`,
    timestamp: new Date(T0 + hourOffset * H).toISOString(),
    machineId: "m",
    machineName: "n",
    app: "claude-code",
    provider: "anthropic",
    model: "claude-opus-5",
    inputTokens,
    outputTokens: 0,
    costUsd: null,
    hasContent: false,
    features: { modelTier: "frontier" },
  };
}

/**
 * 28 days of steady weekday activity, hours 9..17 UTC, nothing at weekends.
 * That gives the detector a real activity profile to reason against.
 */
function weekdayHistory(heavyDay?: { day: number; multiplier: number }): UsageEvent[] {
  const out: UsageEvent[] = [];
  for (let d = 0; d < 28; d += 1) {
    const dow = new Date(T0 + d * 24 * H).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const mult = heavyDay && heavyDay.day === d ? heavyDay.multiplier : 1;
    for (let h = 9; h < 18; h += 1) {
      out.push(ev(d * 24 + h, 1_000 * mult));
    }
  }
  return out;
}

/**
 * Day 14 (a Wednesday) with 20x normal load, then nothing for 3 days across
 * what would otherwise be working hours (days 15-17 dropped entirely).
 * Shared by the "genuine candidate" tests below.
 */
function heavyMidweekThenGap(): UsageEvent[] {
  return weekdayHistory({ day: 14, multiplier: 20 }).filter((e) => {
    const dayIndex = Math.floor((Date.parse(e.timestamp) - T0) / (24 * H));
    return dayIndex <= 14 || dayIndex >= 18;
  });
}

/**
 * A heavy Friday (day 23) with nothing recorded after it: the open trailing
 * gap, where nextAt = nowMs and keeps advancing every time detection runs.
 * This is the C1 regression fixture.
 */
function heavyFridayThenNothing(): UsageEvent[] {
  return weekdayHistory({ day: 23, multiplier: 20 }).filter((e) => {
    const dayIndex = Math.floor((Date.parse(e.timestamp) - T0) / (24 * H));
    return dayIndex <= 23;
  });
}

describe("hourOfWeekActivity", () => {
  it("has one slot per hour of the week", () => {
    expect(hourOfWeekActivity(toTimedUnits(weekdayHistory()))).toHaveLength(168);
  });

  it("puts the busy hours well above the quiet ones", () => {
    const a = hourOfWeekActivity(toTimedUnits(weekdayHistory()));
    const busyHours = a.filter((x) => x > 0);
    const quietHours = a.filter((x) => x === 0);
    expect(busyHours.length).toBeGreaterThan(0);
    expect(quietHours.length).toBeGreaterThan(0);
    expect(Math.min(...busyHours)).toBeGreaterThan(Math.max(...quietHours));
  });
});

describe("detectCandidateWalls", () => {
  it("does NOT propose an ordinary weekend", () => {
    // The whole point of the activity clause. A weekend is a long zero gap
    // following normal use, and must never be surfaced as a possible limit.
    // Asserted directly against the empty result (not by inspecting
    // `found`'s contents): with `found` empty, a loop over its elements
    // never executes any assertion, which is vacuously true regardless of
    // whether the detector is doing its job.
    const sorted = toTimedUnits(weekdayHistory());
    const now = T0 + 28 * 24 * H;
    const found = detectCandidateWalls(sorted, now, []);
    expect(found).toEqual([]);
  });

  it("proposes a long quiet stretch that follows an unusually heavy period", () => {
    // The positive control for the weekend test above: a quiet stretch that
    // genuinely crosses the user's own working hours (Thursday and Friday
    // 9-17, not a weekend) must be proposed, with exactly the gap expected.
    // `toEqual([])` alone would also be satisfied by a detector that always
    // returns `[]` -- this is what rules that out.
    const sorted = toTimedUnits(heavyMidweekThenGap());
    const now = T0 + 28 * 24 * H;
    const found = detectCandidateWalls(sorted, now, []);
    expect(found).toHaveLength(1);
    const c = found[0]!;
    expect(c.startsAt).toBe(new Date(T0 + (14 * 24 + 17) * H).toISOString());
    expect(c.gapHours).toBeGreaterThanOrEqual(CANDIDATE_MIN_GAP_HOURS);
    expect(c.unitsInWindow).toBeGreaterThan(0);
  });

  it("never proposes a dismissed candidate again, even after now advances", () => {
    // Pins C1 directly: the open trailing gap (last event, nothing since,
    // nextAt = nowMs) is exactly the case where an id keyed on gapHours
    // changed every run and a dismissal could never stick. `now` is
    // deliberately advanced between the dismiss and the re-check, and the
    // assertion is on startsAt (not id), so this fails under the old
    // gapHours-suffixed id even though that id itself also changed.
    const sorted = toTimedUnits(heavyFridayThenNothing());
    const lastAt = sorted[sorted.length - 1]!.at;

    const now1 = lastAt + 74 * H;
    const first = detectCandidateWalls(sorted, now1, []);
    expect(first.length).toBeGreaterThan(0);
    const dismissedId = first[0]!.id;
    const dismissedStartsAt = first[0]!.startsAt;

    const now2 = lastAt + 80 * H;
    const again = detectCandidateWalls(sorted, now2, [dismissedId]);
    expect(again.map((c) => c.startsAt)).not.toContain(dismissedStartsAt);
  });

  it("keeps a candidate's id stable as now advances and the gap later closes", () => {
    // "Across runs" means the case where now has advanced and history has
    // grown -- not two calls with identical inputs, which passes for any
    // pure function regardless of whether the id is actually stable.
    const openSorted = toTimedUnits(heavyFridayThenNothing());
    const lastAt = openSorted[openSorted.length - 1]!.at;
    const openRun = detectCandidateWalls(openSorted, lastAt + 74 * H, []);
    expect(openRun.length).toBeGreaterThan(0);
    const openId = openRun[0]!.id;

    // The user resumes: later weekday history is appended and now advances
    // well past it, so the same gap is no longer open-ended -- it is a
    // closed, dated gap with a fixed nextAt. Resuming specifically on day 27
    // (Tuesday), skipping day 26 (Monday), keeps the closed gap's own active
    // hours at a genuine >= 4 (it still crosses all of Monday 9-17): if it
    // resumed on the Monday instead the gap would degrade into an ordinary
    // Friday-to-Monday weekend, which condition 3 is correctly supposed to
    // exclude -- that would make this a bad regression fixture, not a bug.
    const resumedEvents = heavyFridayThenNothing().concat(
      weekdayHistory().filter((e) => {
        const dayIndex = Math.floor((Date.parse(e.timestamp) - T0) / (24 * H));
        return dayIndex === 27;
      }),
    );
    const closedSorted = toTimedUnits(resumedEvents);
    const closedRun = detectCandidateWalls(closedSorted, T0 + 40 * 24 * H, []);
    expect(closedRun.map((c) => c.id)).toContain(openId);
  });

  it("returns nothing for an empty history", () => {
    expect(detectCandidateWalls([], T0, [])).toEqual([]);
  });
});
