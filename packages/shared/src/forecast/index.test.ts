import { describe, expect, it } from "vitest";
import type { UsageEvent } from "../schema/event.js";
import type { LimitObservation } from "./types.js";
import { MIN_HISTORY_DAYS, runForecast } from "./index.js";

const H = 3_600_000;
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

/** 30 days of hourly events, so history exceeds MIN_HISTORY_DAYS. */
function longHistory(): UsageEvent[] {
  return Array.from({ length: 24 * 30 }, (_, i) => ev(i, 100));
}

const NOW = new Date(T0 + (24 * 30 - 1) * H).toISOString();

describe("runForecast", () => {
  it("reports both windows", () => {
    const f = runForecast(longHistory(), NOW);
    expect(f.windows.map((w) => w.windowKind)).toEqual(["session_5h", "weekly_7d"]);
  });

  it("uses the user's own historical maximum as an inferred ceiling", () => {
    const f = runForecast(longHistory(), NOW);
    const weekly = f.windows.find((w) => w.windowKind === "weekly_7d")!;
    expect(weekly.ceilingProvenance).toBe("inferred");
    expect(weekly.ceiling).toBeGreaterThan(0);
    // Steady history: current should be at or just under its own maximum.
    expect(weekly.fractionOfCeiling).toBeGreaterThan(0.9);
  });

  it("withholds a ceiling entirely when history is too short to have one", () => {
    // A "historical maximum" drawn from a few days is just the current few
    // days. Reporting it as a ceiling would be circular.
    const short = Array.from({ length: 24 * 3 }, (_, i) => ev(i, 100));
    const f = runForecast(short, new Date(T0 + 24 * 3 * H).toISOString());
    for (const w of f.windows) {
      expect(w.ceiling).toBeNull();
      expect(w.ceilingProvenance).toBeNull();
      expect(w.reachesCeilingAt).toBeNull();
      expect(w.noProjectionReason).toMatch(/history/i);
    }
    expect(f.historyDays).toBeLessThan(MIN_HISTORY_DAYS);
  });

  it("prefers a declared observation over the inferred maximum", () => {
    const obs: LimitObservation[] = [
      {
        id: "o1",
        windowKind: "weekly_7d",
        observedAt: new Date(T0 + 24 * 20 * H).toISOString(),
        unitsInWindow: 999_999,
        provenance: "declared",
        status: "active",
      },
    ];
    const f = runForecast(longHistory(), NOW, obs);
    const weekly = f.windows.find((w) => w.windowKind === "weekly_7d")!;
    expect(weekly.ceilingProvenance).toBe("declared");
    expect(weekly.ceiling).toBe(999_999);
  });

  it("takes the most recent active declaration, not the largest", () => {
    // Limits change — Anthropic doubled Claude Code's 5-hour limits on
    // 2026-05-06. Averaging or maxing across regimes describes neither.
    const obs: LimitObservation[] = [
      {
        id: "old", windowKind: "weekly_7d",
        observedAt: new Date(T0 + 24 * 5 * H).toISOString(),
        unitsInWindow: 5_000_000, provenance: "declared", status: "active",
      },
      {
        id: "new", windowKind: "weekly_7d",
        observedAt: new Date(T0 + 24 * 25 * H).toISOString(),
        unitsInWindow: 1_000_000, provenance: "declared", status: "active",
      },
    ];
    const f = runForecast(longHistory(), NOW, obs);
    expect(f.windows.find((w) => w.windowKind === "weekly_7d")!.ceiling).toBe(1_000_000);
  });

  it("ignores superseded and dismissed observations", () => {
    const obs: LimitObservation[] = [
      {
        id: "d", windowKind: "weekly_7d",
        observedAt: new Date(T0 + 24 * 25 * H).toISOString(),
        unitsInWindow: 42, provenance: "declared", status: "dismissed",
      },
    ];
    const f = runForecast(longHistory(), NOW, obs);
    expect(f.windows.find((w) => w.windowKind === "weekly_7d")!.ceiling).not.toBe(42);
  });

  it("counts events lacking a cache breakdown so the UI can caveat", () => {
    const withBreakdown: UsageEvent = {
      ...ev(1, 1000),
      cacheReadTokens: 900,
      cacheCreationTokens: 50,
    };
    const f = runForecast([withBreakdown, ev(2, 1000)], new Date(T0 + 3 * H).toISOString());
    expect(f.eventsCounted).toBe(2);
    expect(f.eventsWithoutBreakdown).toBe(1);
  });

  it("returns a usable shape with no events at all", () => {
    const f = runForecast([], NOW);
    expect(f.eventsCounted).toBe(0);
    expect(f.historyDays).toBe(0);
    for (const w of f.windows) {
      expect(w.current).toBe(0);
      expect(w.pacePerHour).toBe(0);
      expect(w.reachesCeilingAt).toBeNull();
    }
  });

  it("emits no candidates of its own", () => {
    // Candidate detection arrives in a later task and is wired in there.
    expect(runForecast(longHistory(), NOW).candidates).toEqual([]);
  });

  it("I1: a declared ceiling of 0 never renders as both 'no ceiling' and a projected reach date", () => {
    // The route that creates a declaration now rejects `unitsInWindow: 0`
    // before it is ever written (see forecast.ts's POST
    // /v1/limit-observations), but this exercises runForecast directly so
    // the invariant holds structurally, independent of that route-level
    // guard: an active/declared observation of exactly 0 units must never
    // reach a WindowForecast that both withholds a ceiling AND claims a
    // reach date. Short history (below MIN_HISTORY_DAYS) so there is no
    // inferred fallback to mask the bug -- the zero declaration must fall
    // all the way through to "no ceiling", not resolve some other way.
    const short = Array.from({ length: 24 * 3 }, (_, i) => ev(i, 100));
    const now = new Date(T0 + 24 * 3 * H).toISOString();
    const obs: LimitObservation[] = [
      {
        id: "zero",
        windowKind: "weekly_7d",
        observedAt: now,
        unitsInWindow: 0,
        provenance: "declared",
        status: "active",
      },
    ];
    const f = runForecast(short, now, obs);
    const weekly = f.windows.find((w) => w.windowKind === "weekly_7d")!;
    // Before the fix: ceiling=0/declared, fractionOfCeiling=null (0 read as
    // falsy), but current(0) >= ceiling(0) so reachesCeilingAt was a real
    // ISO timestamp -- "No ceiling established yet." rendered right beside
    // "Projected to reach the ceiling around ...".
    expect(weekly.ceiling).toBeNull();
    expect(weekly.ceilingProvenance).toBeNull();
    expect(weekly.fractionOfCeiling).toBeNull();
    expect(weekly.reachesCeilingAt).toBeNull();
    expect(weekly.noProjectionReason).not.toBeNull();
  });

  it("I1: a declared ceiling of 0 falls through to the inferred maximum when history is long enough", () => {
    // With ample history, a zero declaration must not black-hole the window
    // into "no ceiling" when a real, positive, honest ceiling (the user's
    // own historical maximum) is available -- it degrades to the SAME
    // behavior as having no declaration at all, not to a permanently
    // withheld ceiling.
    const obs: LimitObservation[] = [
      {
        id: "zero",
        windowKind: "weekly_7d",
        observedAt: new Date(T0 + 24 * 20 * H).toISOString(),
        unitsInWindow: 0,
        provenance: "declared",
        status: "active",
      },
    ];
    const f = runForecast(longHistory(), NOW, obs);
    const weekly = f.windows.find((w) => w.windowKind === "weekly_7d")!;
    expect(weekly.ceiling).toBeGreaterThan(0);
    expect(weekly.ceilingProvenance).toBe("inferred");
  });
});
