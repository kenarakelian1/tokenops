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

describe("hourOfWeekActivity", () => {
  it("has one slot per hour of the week", () => {
    expect(hourOfWeekActivity(toTimedUnits(weekdayHistory()))).toHaveLength(168);
  });

  it("puts the busy hours well above the quiet ones", () => {
    const a = hourOfWeekActivity(toTimedUnits(weekdayHistory()));
    const busy = a.filter((x) => x > 0);
    expect(busy.length).toBeGreaterThan(0);
    expect(Math.max(...a)).toBeGreaterThan(0);
  });
});

describe("detectCandidateWalls", () => {
  it("does NOT propose an ordinary weekend", () => {
    // The whole point of the activity clause. A weekend is a long zero gap
    // following normal use, and must never be surfaced as a possible limit.
    const sorted = toTimedUnits(weekdayHistory());
    const now = T0 + 28 * 24 * H;
    const found = detectCandidateWalls(sorted, now, []);
    for (const c of found) {
      const startDow = new Date(Date.parse(c.startsAt)).getUTCDay();
      expect([0, 6]).not.toContain(startDow);
    }
  });

  it("proposes a long quiet stretch that follows an unusually heavy period", () => {
    // Day 14 is a Wednesday with 20x normal load; then nothing for 3 days
    // across what would otherwise be working hours.
    const base = weekdayHistory({ day: 14, multiplier: 20 }).filter((e) => {
      const dayIndex = Math.floor(
        (Date.parse(e.timestamp) - T0) / (24 * H),
      );
      return dayIndex <= 14 || dayIndex >= 18;
    });
    const sorted = toTimedUnits(base);
    const now = T0 + 28 * 24 * H;
    const found = detectCandidateWalls(sorted, now, []);
    expect(found.length).toBeGreaterThan(0);
    const c = found[0]!;
    expect(c.gapHours).toBeGreaterThanOrEqual(CANDIDATE_MIN_GAP_HOURS);
    expect(c.unitsInWindow).toBeGreaterThan(0);
  });

  it("never proposes a dismissed candidate again", () => {
    const base = weekdayHistory({ day: 14, multiplier: 20 }).filter((e) => {
      const dayIndex = Math.floor((Date.parse(e.timestamp) - T0) / (24 * H));
      return dayIndex <= 14 || dayIndex >= 18;
    });
    const sorted = toTimedUnits(base);
    const now = T0 + 28 * 24 * H;
    const first = detectCandidateWalls(sorted, now, []);
    expect(first.length).toBeGreaterThan(0);
    const again = detectCandidateWalls(sorted, now, [first[0]!.id]);
    expect(again.map((c) => c.id)).not.toContain(first[0]!.id);
  });

  it("produces a stable id for the same gap across runs", () => {
    const base = weekdayHistory({ day: 14, multiplier: 20 }).filter((e) => {
      const dayIndex = Math.floor((Date.parse(e.timestamp) - T0) / (24 * H));
      return dayIndex <= 14 || dayIndex >= 18;
    });
    const sorted = toTimedUnits(base);
    const now = T0 + 28 * 24 * H;
    const a = detectCandidateWalls(sorted, now, []);
    const b = detectCandidateWalls(sorted, now, []);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
  });

  it("returns nothing for an empty history", () => {
    expect(detectCandidateWalls([], T0, [])).toEqual([]);
  });
});
