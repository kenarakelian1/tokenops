import { describe, expect, it } from "vitest";
import { toTimedUnits, trailingWindow, windowHistory } from "./windows.js";
import type { UsageEvent } from "../schema/event.js";

const H = 3_600_000;
const T0 = Date.parse("2026-08-01T00:00:00.000Z");

/** Deterministic PRNG (mulberry32) so the large fixture below is reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
    // No cache fields: all input counts at the raw weight of 1.0, so
    // units === inputTokens and the window arithmetic is readable.
  };
}

describe("toTimedUnits", () => {
  it("sorts ascending regardless of input order", () => {
    const t = toTimedUnits([ev(5, 100), ev(1, 200), ev(3, 300)]);
    expect(t.map((x) => x.units)).toEqual([200, 300, 100]);
  });

  it("drops events with an unparseable timestamp rather than emitting NaN", () => {
    const bad = { ...ev(1, 100), timestamp: "not-a-date" };
    expect(toTimedUnits([bad, ev(2, 50)])).toHaveLength(1);
  });
});

describe("trailingWindow", () => {
  const sorted = toTimedUnits([ev(0, 10), ev(1, 20), ev(2, 40), ev(6, 80)]);

  it("sums only events inside the trailing window", () => {
    // at hour 6, a 5-hour window covers (hour 1, hour 6]: hour 1 sits exactly
    // on the open lower edge and is excluded, leaving hour 2 and hour 6.
    expect(trailingWindow(sorted, T0 + 6 * H, 5)).toBe(120);
  });

  it("excludes the event exactly at the window's opening edge", () => {
    // The window is half-open (at-hours, at]. An event exactly `hours` old has
    // already rolled out; including it would double-count it against the
    // projection's roll-out term, which uses the same boundary.
    expect(trailingWindow(sorted, T0 + 5 * H, 5)).toBe(60); // hours 1 and 2, not 0
  });

  it("includes an event exactly at `at`", () => {
    expect(trailingWindow(sorted, T0 + 2 * H, 5)).toBe(70);
  });

  it("is zero when nothing falls in the window", () => {
    expect(trailingWindow(sorted, T0 + 100 * H, 5)).toBe(0);
  });

  it("is zero for an empty series", () => {
    expect(trailingWindow([], T0, 5)).toBe(0);
  });
});

describe("windowHistory", () => {
  it("samples the trailing window at each step", () => {
    const sorted = toTimedUnits([ev(0, 10), ev(1, 20), ev(2, 40)]);
    const h = windowHistory(sorted, 5, T0, T0 + 2 * H, 1);
    expect(h.map((x) => x.units)).toEqual([10, 30, 70]);
  });

  it("returns an empty array when the range is inverted", () => {
    expect(windowHistory([], 5, T0 + H, T0, 1)).toEqual([]);
  });

  // windowHistory's linear complexity (two-pointer sweep, not a re-scan per
  // sample) is a property enforced by code review, not by a test in this
  // file: no timing bound at a fixture size this suite can afford actually
  // separates the sweep from the naive per-sample form -- both finish in low
  // single-digit milliseconds on fixtures this test file can afford to
  // build, so a timing assertion here would claim a guarantee it cannot
  // provide, which is worse than no assertion at all. What a test here CAN
  // check, and what would otherwise be invisible, is that windowHistory's
  // sweep and trailingWindow's independent re-scan agree at every sampled
  // instant -- including instants that land exactly on a window edge, which
  // is the case that actually exercises the half-open boundary logic that
  // differs between a correct sweep and an off-by-one one.
  it("windowHistory agrees with trailingWindow at every sample", () => {
    const GRID_H = 3; // equals the sample step below
    const WINDOW_H = 168; // multiple of GRID_H, so window edges land on the same grid

    const rand = seededRandom(0xc0ffee);
    const events: UsageEvent[] = [];
    let cursor = 0; // hours from T0
    for (let i = 0; i < 1700; i++) {
      events.push(ev(cursor, 1 + (i % 5)));
      const r = rand();
      if (r < 0.12) {
        // duplicate timestamp: several events share this instant, no advance
      } else if (r < 0.97) {
        cursor += rand() * 0.5; // small irregular gap, off the 3h grid
      } else {
        cursor += 15 + rand() * 45; // long gap, up to 60h
      }
    }
    // Grid-aligned events, overlaid on the irregular noise above, guarantee
    // that some window edges coincide exactly with an event timestamp.
    const gridSpan = Math.min(cursor, 900);
    for (let g = 0; g <= gridSpan; g += GRID_H) {
      events.push(ev(g, 2));
      if ((g / GRID_H) % 6 === 0) events.push(ev(g, 3)); // duplicate cluster
    }

    const sorted = toTimedUnits(events);
    expect(sorted.length).toBeGreaterThanOrEqual(2_000);

    const fromMs = T0;
    const toMs = sorted[sorted.length - 1]!.at + GRID_H * H;
    const history = windowHistory(sorted, WINDOW_H, fromMs, toMs, GRID_H);
    expect(history.length).toBeGreaterThan(300);

    for (const point of history) {
      expect(point.units).toBe(trailingWindow(sorted, point.at, WINDOW_H));
    }
  });
});
