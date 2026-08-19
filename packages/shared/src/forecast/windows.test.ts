import { describe, expect, it } from "vitest";
import { toTimedUnits, trailingWindow, windowHistory } from "./windows.js";
import { pacePerHour, projectWindow } from "./windows.js";
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

describe("pacePerHour", () => {
  it("averages the trailing 24 hours", () => {
    // 240 units spread across the last 24h -> 10/hour
    const evs = Array.from({ length: 24 }, (_, i) => ev(i, 10));
    expect(pacePerHour(toTimedUnits(evs), T0 + 23 * H)).toBeCloseTo(10, 6);
  });

  it("is zero when nothing was consumed recently", () => {
    expect(pacePerHour(toTimedUnits([ev(0, 1000)]), T0 + 500 * H)).toBe(0);
  });
});

describe("projectWindow", () => {
  it("accounts for events rolling OUT of the window, not just inflow", () => {
    // THIS TEST FAILS UNDER NAIVE EXTRAPOLATION, which is the point.
    //
    // A 5-hour window. In the last 5h: 100 units, all of it in one spike at
    // hour 0. Current pace is low. Naive `current + pace*t` climbs forever;
    // the truth is that the hour-0 spike leaves the window within an hour and
    // the total DROPS. A ceiling just above `current` must therefore never be
    // reached.
    const evs = [ev(0, 100), ev(4, 1)];
    const sorted = toTimedUnits(evs);
    const now = T0 + 4 * H;
    expect(trailingWindow(sorted, now, 5)).toBe(101);

    const res = projectWindow(sorted, now, 5, 110);
    expect(res.reachesAtMs).toBeNull();
    expect(res.reason).toMatch(/not reachable/i);
  });

  it("never crosses a ceiling above the pace-hours saturation cap, even at steady state", () => {
    // Pins the property named in projectWindow's docstring: a steady-state
    // user must never be told they are perpetually about to run out. This
    // is the single most discriminating case available -- it is what
    // originally caught the brief's uncapped formula (which reached this
    // exact ceiling anyway, just delayed to h=27 instead of never) and
    // would have caught the naive formula too (reaches at h=15). Nothing
    // else in this file pins the saturation cap itself.
    //
    // Steady 10 units/hour for 24h -> pace = 10/h. A 5-hour window at
    // steady state holds pace * hours = 50 units and no more. A ceiling of
    // 200 is 4x that headroom: comfortably, permanently unreachable.
    const evs = Array.from({ length: 24 }, (_, i) => ev(i, 10));
    const sorted = toTimedUnits(evs);
    const now = T0 + 23 * H;
    expect(trailingWindow(sorted, now, 5)).toBe(50);
    expect(pacePerHour(sorted, now)).toBeCloseTo(10, 6);

    const res = projectWindow(sorted, now, 5, 200);
    expect(res.reachesAtMs).toBeNull();
    expect(res.reason).toMatch(/not reachable/i);
  });

  it("projects a reach time when inflow genuinely outpaces roll-out", () => {
    // FIXTURE CHANGED FROM THE BRIEF (implementation left untouched — see
    // task-3-report.md): the brief's rising series (10*(i+1) units/hour)
    // only produced a reachable projection under the brief's own
    // roll-out formula, which turned out to have a real bug of its own —
    // the assumed-inflow term was never capped at `pace * hours`, so it
    // grew without bound and crossed any ceiling given a long enough
    // horizon, the exact unbounded-growth failure this function exists to
    // avoid. Once that's fixed (inflow saturates at `pace * hours`,
    // matching a steady-state window), the original fixture's "reach" was
    // an artifact of the bug, not a real one, and the corrected model
    // legitimately never reaches it.
    //
    // This fixture instead models a lull ending: 19 steady hours at 10
    // units/hour, then a 5-hour lull at 1 unit/hour right before `now`.
    // The 24h pace (~8.1/h) is pulled up by the steady hours, so the
    // 5-hour window's steady-state ceiling (pace * 5 ~= 40.6) sits well
    // above the current lull-depressed total (5) -- a ceiling in between
    // is reached honestly, as the lull ages out and normal pace resumes.
    //
    // NOTE: this reaches at h=1 under the naive formula, the brief's
    // uncapped formula, and the corrected capped formula alike -- it does
    // NOT discriminate the roll-out/saturation fix. No positive-reach test
    // can: a first crossing under the *correct* model can only ever occur
    // at h <= hours (after that, `projected` is non-increasing -- see the
    // saturation-cap test above), and capped vs. uncapped formulas agree
    // exactly on that range (Math.min(h, hours) === h there). All of the
    // discriminating power necessarily lives in the negative cases, not
    // this one. This test is a regression guard against an
    // always-null/broken implementation, nothing more.
    const evs = [
      ...Array.from({ length: 19 }, (_, i) => ev(i, 10)),
      ...Array.from({ length: 5 }, (_, i) => ev(19 + i, 1)),
    ];
    const sorted = toTimedUnits(evs);
    const now = T0 + 23 * H;
    const current = trailingWindow(sorted, now, 5);
    const res = projectWindow(sorted, now, 5, current * 1.05);
    expect(res.reachesAtMs).not.toBeNull();
    expect(res.reachesAtMs!).toBeGreaterThan(now);
    expect(res.reason).toBeNull();
  });

  it("excludes an event from outflow only once it is exactly `hours` old, matching trailingWindow", () => {
    // Pins the outflow boundary itself. A flip of the pointer guard from
    // `<=` to `<` (an event ages out only once *strictly* older than
    // `hours`, instead of at exactly `hours`) previously left all 17 tests
    // green: the roll-out test above returns null either way, and the
    // positive test only shifts which hour it reaches, invisible to a
    // `toBeGreaterThan(now)` assertion. This test asserts an exact
    // `reachesAtMs`, so a boundary flip changes the returned instant and
    // the assertion fails.
    //
    // hours=5, now=T0+10H. A 50-unit spike sits at T0+8H, exactly 2 hours
    // before `now` -- inside the current window. Its exact age-out instant
    // is where `windowOpensAt(h) = t - 5H` equals T0+8H, which happens at
    // h=3 (t=T0+13H). A second event (670 units at T0) sits outside the
    // 5h window but inside the 24h pace window, giving pace=(50+670)/24
    // = 30/h exactly.
    //
    // With the correct `<=` boundary, the spike is subtracted starting at
    // h=3, so ceiling=115 first crosses one step later, at h=4 (t=T0+14H):
    //   h=1: 50 + 30*1        = 80
    //   h=2: 50 + 30*2        = 110
    //   h=3: (50-50) + 30*3   = 90   <- spike just left; still under 115
    //   h=4: (50-50) + 30*4   = 120  >= 115  -> reachesAtMs = T0+14H
    // Flip to `<` and the spike is still counted at h=3, so it crosses one
    // step earlier instead: h=3 gives 50 + 30*3 = 140 >= 115.
    const evs = [ev(0, 670), ev(8, 50)];
    const sorted = toTimedUnits(evs);
    const now = T0 + 10 * H;
    expect(trailingWindow(sorted, now, 5)).toBe(50);
    expect(pacePerHour(sorted, now)).toBeCloseTo(30, 6);

    const res = projectWindow(sorted, now, 5, 115);
    expect(res.reachesAtMs).toBe(T0 + 14 * H);
    expect(res.reason).toBeNull();
  });

  it("reports already-exceeded rather than a past instant", () => {
    const sorted = toTimedUnits([ev(0, 100)]);
    const res = projectWindow(sorted, T0, 5, 50);
    expect(res.reachesAtMs).toBe(T0);
    expect(res.reason).toBeNull();
  });

  it("declines to project when the pace is zero", () => {
    const sorted = toTimedUnits([ev(0, 100)]);
    const res = projectWindow(sorted, T0 + 400 * H, 168, 1_000_000);
    expect(res.reachesAtMs).toBeNull();
    expect(res.reason).toMatch(/no recent consumption/i);
  });

  it("declines to project against a null ceiling", () => {
    const sorted = toTimedUnits([ev(0, 100)]);
    const res = projectWindow(sorted, T0, 5, null);
    expect(res.reachesAtMs).toBeNull();
    expect(res.reason).toMatch(/no ceiling/i);
  });
});
