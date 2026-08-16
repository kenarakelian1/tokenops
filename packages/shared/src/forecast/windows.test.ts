import { describe, expect, it } from "vitest";
import { toTimedUnits, trailingWindow, windowHistory } from "./windows.js";
import type { UsageEvent } from "../schema/event.js";

const H = 3_600_000;
const T0 = Date.parse("2026-08-01T00:00:00.000Z");

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

  it("stays linear rather than quadratic on a long history", () => {
    // 30 days of hourly events sampled hourly is 720 x 720 under a naive
    // re-scan per sample. This must complete promptly; a quadratic
    // implementation on real data (15k+ events) would not.
    const many = Array.from({ length: 720 }, (_, i) => ev(i, 1));
    const sorted = toTimedUnits(many);
    const started = Date.now();
    const h = windowHistory(sorted, 168, T0, T0 + 719 * H, 1);
    expect(h).toHaveLength(720);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
