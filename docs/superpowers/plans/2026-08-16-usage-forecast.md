# Usage Forecast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell the user whether they will reach their reset at the current consumption pace, without inventing a quota Anthropic does not publish.

**Architecture:** A pure-function module in `packages/shared/src/forecast/` computes consumption units, trailing 5h/7d windows, an exactly-modelled forward projection, and candidate limit-hit detection. A new `limit_observations` table records limits the user has actually observed. An API route assembles them; a web panel renders every figure beside its provenance.

**Tech Stack:** TypeScript (ESM, NodeNext), pnpm workspaces, Vitest, Drizzle + Postgres, Hono, React/Vite.

**Spec:** `docs/superpowers/specs/2026-08-16-usage-forecast-design.md`

**Base:** `main` at `434c579`.

## Global Constraints

- `LimitProvenance` is exactly `"measured" | "reported" | "declared" | "inferred"`. Every limit and projection carries one, and the UI renders it beside the number.
- Consumption units are a **proxy**, never called "usage" in code, comments, or UI copy.
- Unit weights: uncached input `1.0`, cache creation `1.25`, cache read `0.10`, output `5.0`. The cache weights MUST be imported from `packages/shared/src/pricing.ts` (`CACHE_CREATION_PRICE_MULTIPLIER`, `CACHE_READ_PRICE_MULTIPLIER`) — never re-declared.
- Windows are trailing **5 hours** (`session_5h`) and trailing **7 days** (`weekly_7d`). No fixed reset date.
- The projection models roll-out exactly. Naive extrapolation (`current + pace × hours`) is a defect, and a test must fail under it.
- `CANDIDATE_MIN_GAP_HOURS = 12`, `CANDIDATE_MIN_ACTIVE_HOURS = 4`, `MIN_HISTORY_DAYS = 14`, `PACE_HOURS = 24`, `PROJECTION_HORIZON_HOURS = 336` (14 days), `PROJECTION_STEP_HOURS = 1`.
- **Candidate detection proposes; it never sets a ceiling.** A candidate becomes a ceiling only when the user confirms it, at which point its provenance becomes `declared`.
- `cacheReadTokens` / `cacheCreationTokens` are optional on `UsageEvent`. Absent means "not recorded" and must never be fabricated as `0`; events lacking a breakdown are counted separately and surfaced.
- `now` is always an explicit parameter. No pure function reads the clock.
- TypeScript ESM/NodeNext: relative imports carry the `.js` extension.
- `packages/shared/src/index.ts` uses explicit named exports — add named exports, not a wildcard.
- End every commit message with: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Never use `--no-verify`, never force-push.

---

## File Structure

**Create:**
- `packages/shared/src/forecast/types.ts` — `LimitProvenance`, `WindowKind`, `LimitObservation`, `WindowForecast`, `Forecast`, `WallCandidate`
- `packages/shared/src/forecast/units.ts` — `consumptionUnits`, weights
- `packages/shared/src/forecast/units.test.ts`
- `packages/shared/src/forecast/windows.ts` — `trailingWindow`, `windowHistory`, `projectWindow`
- `packages/shared/src/forecast/windows.test.ts`
- `packages/shared/src/forecast/candidates.ts` — `detectCandidateWalls`, `hourOfWeekActivity`
- `packages/shared/src/forecast/candidates.test.ts`
- `packages/shared/src/forecast/index.ts` — `runForecast`
- `packages/shared/src/forecast/index.test.ts`
- `apps/api/src/routes/forecast.ts`
- `apps/api/src/routes/forecast.test.ts`
- `apps/web/src/pages/Forecast.tsx`
- `apps/web/src/pages/Forecast.test.tsx`
- `scripts/measure-forecast.mjs`

**Modify:**
- `packages/shared/src/index.ts` — named exports for the forecast module
- `apps/api/src/db/schema.ts` — `limitObservations` table
- `apps/api/drizzle/` — generated migration
- `apps/api/src/services/events-repo.ts` — observation methods on BOTH implementations
- `apps/api/src/app.ts` — mount the forecast routes
- `apps/web/src/api/client.ts` — forecast DTOs and fetchers
- `apps/web/src/App.tsx` (or wherever routes are registered) — add the Forecast page

---

### Task 1: Types and consumption units

**Files:**
- Create: `packages/shared/src/forecast/types.ts`, `packages/shared/src/forecast/units.ts`
- Test: `packages/shared/src/forecast/units.test.ts`

**Interfaces:**
- Consumes: `UsageEvent` from `../schema/event.js`; `CACHE_CREATION_PRICE_MULTIPLIER`, `CACHE_READ_PRICE_MULTIPLIER` from `../pricing.js`
- Produces: `LimitProvenance`, `WindowKind`, `LimitObservation`, `WallCandidate`, `WindowForecast`, `Forecast`, `consumptionUnits(event): number`, `hasCacheBreakdown(event): boolean`, `OUTPUT_UNIT_WEIGHT`, `RAW_INPUT_UNIT_WEIGHT`

- [ ] **Step 1: Confirm the pricing exports exist**

Run: `grep -n "export const CACHE_\(READ\|CREATION\)_PRICE_MULTIPLIER" packages/shared/src/pricing.ts`
Expected: both exported, values `0.1` and `1.25`. Import them; do not re-declare the numbers.

- [ ] **Step 2: Write the failing test**

Create `packages/shared/src/forecast/units.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { UsageEvent } from "../schema/event.js";
import { consumptionUnits, hasCacheBreakdown } from "./units.js";

function ev(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    eventId: "e1",
    timestamp: "2026-08-01T00:00:00.000Z",
    machineId: "m",
    machineName: "n",
    app: "claude-code",
    provider: "anthropic",
    model: "claude-opus-5",
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    hasContent: false,
    features: { modelTier: "frontier" },
    ...over,
  };
}

describe("consumptionUnits", () => {
  it("weights each component by its billing multiplier", () => {
    // 1000 raw + 2000 creation + 7000 read = 10_000 inputTokens.
    // 1000*1.0 + 2000*1.25 + 7000*0.10 + 100*5.0 = 1000 + 2500 + 700 + 500
    const u = consumptionUnits(
      ev({
        inputTokens: 10_000,
        cacheCreationTokens: 2_000,
        cacheReadTokens: 7_000,
        outputTokens: 100,
      }),
    );
    expect(u).toBeCloseTo(4_700, 6);
  });

  it("treats a cache read as far cheaper than a cache write", () => {
    // The whole premise of the ledger: a write costs 12.5x a read.
    const read = consumptionUnits(ev({ inputTokens: 1_000, cacheReadTokens: 1_000 }));
    const write = consumptionUnits(ev({ inputTokens: 1_000, cacheCreationTokens: 1_000 }));
    expect(write / read).toBeCloseTo(12.5, 6);
  });

  it("never returns a negative raw component when the breakdown exceeds inputTokens", () => {
    // Defensive: cache fields are documented as subsets of inputTokens, but a
    // malformed producer must not make the whole window go negative.
    const u = consumptionUnits(
      ev({ inputTokens: 100, cacheReadTokens: 900, cacheCreationTokens: 900 }),
    );
    expect(u).toBeGreaterThan(0);
  });

  it("counts an event with no breakdown from what was actually recorded", () => {
    // No breakdown means we cannot know the split. Charging all input at the
    // raw weight is the known-information answer; fabricating a zero for the
    // cache fields would silently claim we checked.
    const u = consumptionUnits(ev({ inputTokens: 1_000, outputTokens: 10 }));
    expect(u).toBeCloseTo(1_000 * 1.0 + 10 * 5.0, 6);
  });

  it("is zero for an event with no tokens at all", () => {
    expect(consumptionUnits(ev())).toBe(0);
  });
});

describe("hasCacheBreakdown", () => {
  it("is true only when both cache fields were recorded", () => {
    expect(hasCacheBreakdown(ev({ cacheReadTokens: 0, cacheCreationTokens: 0 }))).toBe(true);
    expect(hasCacheBreakdown(ev({ cacheReadTokens: 5 }))).toBe(false);
    expect(hasCacheBreakdown(ev())).toBe(false);
  });

  it("treats a recorded zero as recorded, not as missing", () => {
    // The absent-vs-zero distinction the whole ledger depends on.
    expect(hasCacheBreakdown(ev({ cacheReadTokens: 0, cacheCreationTokens: 0 }))).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @tokenops/shared exec vitest run src/forecast/units.test.ts`
Expected: FAIL — cannot resolve `./units.js`.

- [ ] **Step 4: Write the types**

Create `packages/shared/src/forecast/types.ts`:

```ts
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
```

- [ ] **Step 5: Write the units implementation**

Create `packages/shared/src/forecast/units.ts`:

```ts
import {
  CACHE_CREATION_PRICE_MULTIPLIER,
  CACHE_READ_PRICE_MULTIPLIER,
} from "../pricing.js";
import type { UsageEvent } from "../schema/event.js";

/** Uncached input is the reference weight all others are expressed against. */
export const RAW_INPUT_UNIT_WEIGHT = 1.0;

/**
 * Output relative to uncached input. Frontier models price output at roughly
 * five times input across the table in ../pricing.ts, so this is that ratio
 * rather than a free parameter. It is NOT imported from pricing.ts because no
 * single constant there expresses it — the ratio varies slightly per model,
 * and pinning one number keeps the proxy comparable across models.
 */
export const OUTPUT_UNIT_WEIGHT = 5.0;

/**
 * Was a cache breakdown recorded for this event?
 *
 * Both fields must be present. A recorded `0` counts as recorded — the
 * absent-vs-zero distinction the rest of the ledger depends on.
 */
export function hasCacheBreakdown(event: UsageEvent): boolean {
  return (
    event.cacheReadTokens !== undefined && event.cacheCreationTokens !== undefined
  );
}

/**
 * A cache-aware PROXY for how much of an allowance an event consumed.
 *
 * Deliberately not called "usage": Anthropic does not publish what a
 * subscription meters, so this cannot be the real quantity. It only has to be
 * MONOTONICALLY related to it, because the forecast's headline output is
 * self-relative ("2.1x your own median"). That is a far weaker assumption
 * than knowing the metering formula, and it is why the no-configuration path
 * is honest.
 *
 * When no cache breakdown was recorded, all input is charged at the raw
 * weight. That over-counts relative to a cached-heavy event, which is why
 * `hasCacheBreakdown` is tracked separately and surfaced rather than hidden.
 */
export function consumptionUnits(event: UsageEvent): number {
  const read = event.cacheReadTokens ?? 0;
  const creation = event.cacheCreationTokens ?? 0;
  // Cache fields are documented subsets of inputTokens. Clamp rather than
  // trust: one malformed producer must not drive a whole window negative.
  const raw = Math.max(0, event.inputTokens - read - creation);

  return (
    raw * RAW_INPUT_UNIT_WEIGHT +
    creation * CACHE_CREATION_PRICE_MULTIPLIER +
    read * CACHE_READ_PRICE_MULTIPLIER +
    event.outputTokens * OUTPUT_UNIT_WEIGHT
  );
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @tokenops/shared exec vitest run src/forecast/units.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/forecast/types.ts packages/shared/src/forecast/units.ts packages/shared/src/forecast/units.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): forecast types and the consumption-unit proxy

Deliberately a proxy, not "usage": Anthropic publishes no metering formula
for subscription plans, so the quantity cannot be reproduced. It only needs
to be monotonically related to it, because the headline output is
self-relative — which is what makes the no-configuration path honest.

Events without a cache breakdown are counted from what was recorded and
tracked separately rather than having a zero fabricated for them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Trailing windows and window history

**Files:**
- Create: `packages/shared/src/forecast/windows.ts`
- Test: `packages/shared/src/forecast/windows.test.ts`

**Interfaces:**
- Consumes: `consumptionUnits` from `./units.js`; `WindowKind`, `WINDOW_HOURS` from `./types.js`
- Produces:
  - `type TimedUnit = { at: number; units: number }` (epoch ms)
  - `toTimedUnits(events: UsageEvent[]): TimedUnit[]` — sorted ascending by `at`
  - `trailingWindow(sorted: TimedUnit[], atMs: number, hours: number): number`
  - `windowHistory(sorted: TimedUnit[], hours: number, fromMs: number, toMs: number, stepHours: number): { at: number; units: number }[]`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/forecast/windows.test.ts`:

```ts
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
    // at hour 6, a 5-hour window covers (hour 1, hour 6]: 20 + 40 + 80
    expect(trailingWindow(sorted, T0 + 6 * H, 5)).toBe(140);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tokenops/shared exec vitest run src/forecast/windows.test.ts`
Expected: FAIL — cannot resolve `./windows.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/forecast/windows.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tokenops/shared exec vitest run src/forecast/windows.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/forecast/windows.ts packages/shared/src/forecast/windows.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): trailing windows and window history

Half-open (at-hours, at] boundary, chosen so the projection's roll-out term
can use the same edge without double-counting.

windowHistory is a two-pointer sweep, not a re-scan per sample: 30 days
sampled hourly against a 7-day window over 15k real events is quadratic in
the naive form. A test pins the complexity rather than trusting it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The projection, with roll-out modelled exactly

**Files:**
- Modify: `packages/shared/src/forecast/windows.ts`
- Test: `packages/shared/src/forecast/windows.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `TimedUnit`, `trailingWindow` from this module
- Produces: `PACE_HOURS`, `PROJECTION_HORIZON_HOURS`, `PROJECTION_STEP_HOURS`, `pacePerHour(sorted, nowMs)`, `projectWindow(sorted, nowMs, hours, ceiling): { reachesAtMs: number | null; reason: string | null }`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/forecast/windows.test.ts`:

```ts
import { pacePerHour, projectWindow } from "./windows.js";

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
    expect(res.reason).toMatch(/not.*within/i);
  });

  it("projects a reach time when inflow genuinely outpaces roll-out", () => {
    // Steady 100 units/hour for 24h: pace is 100/h, and a 5-hour window sits
    // at ~500. A ceiling of 600 is unreachable at steady state (inflow equals
    // outflow), but 550 is already exceeded, so use a rising series instead.
    const evs = Array.from({ length: 24 }, (_, i) => ev(i, 10 * (i + 1)));
    const sorted = toTimedUnits(evs);
    const now = T0 + 23 * H;
    const current = trailingWindow(sorted, now, 5);
    const res = projectWindow(sorted, now, 5, current * 1.05);
    expect(res.reachesAtMs).not.toBeNull();
    expect(res.reachesAtMs!).toBeGreaterThan(now);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tokenops/shared exec vitest run src/forecast/windows.test.ts`
Expected: FAIL — `projectWindow` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `packages/shared/src/forecast/windows.ts`:

```ts
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
 *   trailing(t) = trailing(now)
 *               + pace * (t - now)        // inflow, estimated from recent use
 *               - units leaving the window // outflow, EXACT
 *
 * The outflow term is exact because those events are already in the ledger —
 * it is `trailingWindow` evaluated over the slice that ages out. Nothing about
 * it is a guess.
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
    const projected = current + pace * h - outflow;
    if (projected >= ceiling) return { reachesAtMs: t, reason: null };
  }

  return {
    reachesAtMs: null,
    reason: `not reached within ${PROJECTION_HORIZON_HOURS / 24} days at the current pace`,
  };
}
```

**Why the pointer, not a re-scan:** the obvious implementation re-sums the outflow slice on every one of the 336 steps, which is quadratic in the event count — on the 15k+ events a real history carries, that is millions of comparisons per window per request. Because the window's opening edge only moves forward, a single advancing pointer gives the same answer in one pass. `windowHistory` uses the identical technique for the same reason.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tokenops/shared exec vitest run src/forecast/windows.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/forecast/windows.ts packages/shared/src/forecast/windows.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): forward projection with exact roll-out

A trailing total does not grow at the current pace — old events leave the
window. Extrapolating current + pace*t would tell a steady-state user they
are perpetually about to run out. The outflow term is computed from events
already in the ledger, so it is exact rather than estimated.

The roll-out test fails under naive extrapolation by construction.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `runForecast` — the no-configuration answer

**Files:**
- Create: `packages/shared/src/forecast/index.ts`
- Create: `packages/shared/src/forecast/index.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: everything from `./types.js`, `./units.js`, `./windows.js`
- Produces: `MIN_HISTORY_DAYS`, `HISTORY_SAMPLE_STEP_HOURS`, `runForecast(events: UsageEvent[], nowIso: string, observations?: LimitObservation[]): Forecast`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/forecast/index.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tokenops/shared exec vitest run src/forecast/index.test.ts`
Expected: FAIL — cannot resolve `./index.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/forecast/index.ts`:

```ts
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
```

**Note on the import list:** `consumptionUnits` and `PACE_HOURS` appear in the `export { … }` blocks at the top but are not used in this file's body, so they are deliberately absent from the `import` statement. Re-exporting a name does not require importing it. Adding them to the import would produce an unused-binding warning.

- [ ] **Step 4: Add named exports to the package entry point**

In `packages/shared/src/index.ts`, append (this file uses explicit named exports — match that, do not add a wildcard):

```ts
export {
  runForecast,
  MIN_HISTORY_DAYS,
  HISTORY_SAMPLE_STEP_HOURS,
  PACE_HOURS,
  PROJECTION_HORIZON_HOURS,
  PROJECTION_STEP_HOURS,
  WINDOW_HOURS,
  consumptionUnits,
  hasCacheBreakdown,
  pacePerHour,
  projectWindow,
  toTimedUnits,
  trailingWindow,
  windowHistory,
  type Forecast,
  type WindowForecast,
  type LimitObservation,
  type LimitObservationStatus,
  type LimitProvenance,
  type WallCandidate,
  type WindowKind,
  type TimedUnit,
} from "./forecast/index.js";
```

- [ ] **Step 5: Run the whole shared suite**

Run: `pnpm --filter @tokenops/shared test`
Expected: PASS, all files green.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/forecast/index.ts packages/shared/src/forecast/index.test.ts packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
feat(shared): runForecast

The no-configuration answer: both windows, pace, and a ceiling taken from
the user's own historical maximum — a lower bound on their real limit, since
they reached it.

Below 14 days of history no ceiling is offered at all, because a maximum
drawn from one week is just that week restated and comparing against it
would be circular.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Candidate wall detection

**Files:**
- Create: `packages/shared/src/forecast/candidates.ts`
- Create: `packages/shared/src/forecast/candidates.test.ts`
- Modify: `packages/shared/src/forecast/index.ts` (re-export only)
- Modify: `packages/shared/src/index.ts` (re-export only)

**Interfaces:**
- Consumes: `TimedUnit`, `trailingWindow` from `./windows.js`; `WINDOW_HOURS`, `WallCandidate` from `./types.js`
- Produces: `CANDIDATE_MIN_GAP_HOURS`, `CANDIDATE_MIN_ACTIVE_HOURS`, `CANDIDATE_TOP_DECILE`, `hourOfWeekActivity(sorted): number[]` (length 168), `detectCandidateWalls(sorted, nowMs, dismissedIds): WallCandidate[]`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/forecast/candidates.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tokenops/shared exec vitest run src/forecast/candidates.test.ts`
Expected: FAIL — cannot resolve `./candidates.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/forecast/candidates.ts`:

```ts
import { WINDOW_HOURS, type WallCandidate } from "./types.js";
import { trailingWindow, type TimedUnit } from "./windows.js";

const MS_PER_HOUR = 3_600_000;

/** A gap shorter than this is a night's sleep, not a wall. */
export const CANDIDATE_MIN_GAP_HOURS = 12;

/** How many of the gap's hours must land in the user's own active hours. */
export const CANDIDATE_MIN_ACTIVE_HOURS = 4;

/** How heavy the preceding window must be, as a quantile of the user's own history. */
export const CANDIDATE_TOP_DECILE = 0.9;

/**
 * Total units per hour-of-week slot (0 = Sunday 00:00 UTC .. 167).
 *
 * This is the user's own rhythm, derived rather than assumed. It is what lets
 * the detector tell "stopped because blocked" from "stopped because it was
 * Saturday" without anyone hard-coding a working week.
 */
export function hourOfWeekActivity(sorted: TimedUnit[]): number[] {
  const slots = new Array<number>(168).fill(0);
  for (const p of sorted) {
    const d = new Date(p.at);
    slots[d.getUTCDay() * 24 + d.getUTCHours()]! += p.units;
  }
  return slots;
}

/** Slots at or above the median of the non-empty slots. */
function activeSlots(activity: number[]): Set<number> {
  const nonEmpty = activity.filter((x) => x > 0).sort((a, b) => a - b);
  if (nonEmpty.length === 0) return new Set();
  const median = nonEmpty[Math.floor(nonEmpty.length / 2)]!;
  const out = new Set<number>();
  activity.forEach((v, i) => {
    if (v >= median && v > 0) out.add(i);
  });
  return out;
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor(q * s.length));
  return s[idx]!;
}

/**
 * Find periods that MIGHT have been limit hits.
 *
 * This function proposes; it never decides. Its output is a question for the
 * user, and only their confirmation turns one into a ceiling. That constraint
 * is the reason it can exist at all: there is no ground truth in the data —
 * Claude Code records no limit marker anywhere — so a detector that set
 * ceilings by itself would be guessing with authority it has not earned.
 *
 * All three conditions must hold:
 *   1. a zero-consumption gap of at least CANDIDATE_MIN_GAP_HOURS
 *   2. the trailing 7-day total just before it sits in the user's own top decile
 *   3. at least CANDIDATE_MIN_ACTIVE_HOURS of the gap fall in hours the user
 *      is normally active
 *
 * Condition 3 is what excludes weekends and holidays, using the user's own
 * observed rhythm rather than an assumed working week.
 */
export function detectCandidateWalls(
  sorted: TimedUnit[],
  nowMs: number,
  dismissedIds: string[],
): WallCandidate[] {
  if (sorted.length === 0) return [];

  const dismissed = new Set(dismissedIds);
  const active = activeSlots(hourOfWeekActivity(sorted));
  const weeklyHours = WINDOW_HOURS.weekly_7d;

  // The user's own distribution of trailing-7d totals, sampled at each event.
  const trailingAtEvents = sorted.map((p) => trailingWindow(sorted, p.at, weeklyHours));
  const heavyThreshold = quantile(trailingAtEvents, CANDIDATE_TOP_DECILE);

  const out: WallCandidate[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const startAt = sorted[i]!.at;
    const nextAt = i + 1 < sorted.length ? sorted[i + 1]!.at : nowMs;
    const gapHours = (nextAt - startAt) / MS_PER_HOUR;
    if (gapHours < CANDIDATE_MIN_GAP_HOURS) continue;

    // Condition 2: was the run-up unusually heavy for THIS user?
    const before = trailingAtEvents[i]!;
    if (before < heavyThreshold || before <= 0) continue;

    // Condition 3: does the gap cover hours they would normally be working?
    let activeHours = 0;
    for (let h = 0; h < Math.floor(gapHours); h += 1) {
      const t = new Date(startAt + h * MS_PER_HOUR);
      if (active.has(t.getUTCDay() * 24 + t.getUTCHours())) activeHours += 1;
    }
    if (activeHours < CANDIDATE_MIN_ACTIVE_HOURS) continue;

    const id = `wall:${new Date(startAt).toISOString()}:${Math.round(gapHours)}`;
    if (dismissed.has(id)) continue;

    out.push({
      id,
      windowKind: "weekly_7d",
      startsAt: new Date(startAt).toISOString(),
      endsAt: new Date(nextAt).toISOString(),
      gapHours,
      unitsInWindow: before,
    });
  }
  return out;
}
```

- [ ] **Step 4: Re-export from the module and the package**

In `packages/shared/src/forecast/index.ts`, add:

```ts
export {
  CANDIDATE_MIN_GAP_HOURS,
  CANDIDATE_MIN_ACTIVE_HOURS,
  CANDIDATE_TOP_DECILE,
  detectCandidateWalls,
  hourOfWeekActivity,
} from "./candidates.js";
```

And add the same five names to the `export { … } from "./forecast/index.js";` block in `packages/shared/src/index.ts`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @tokenops/shared test`
Expected: PASS, all files green.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/forecast/candidates.ts packages/shared/src/forecast/candidates.test.ts packages/shared/src/forecast/index.ts packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
feat(shared): candidate wall detection that proposes but never decides

Claude Code records no limit marker anywhere, so there is no ground truth to
detect against — only behaviour to infer from. A detector that set ceilings
by itself would be guessing with authority it has not earned, so this one
only ever produces a question for the user.

Weekends are excluded by the user's own observed hour-of-week rhythm rather
than an assumed working week, and a test pins that a weekend is never
proposed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `limit_observations` table and repo methods

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: migration via `pnpm --filter @tokenops/api db:generate`
- Modify: `apps/api/src/services/events-repo.ts`
- Test: `apps/api/src/services/events-repo.test.ts`

**Interfaces:**
- Consumes: `LimitObservation`, `LimitObservationStatus`, `WindowKind` from `@tokenops/shared`
- Produces, on `EventsRepo`:
  - `listLimitObservations(userId: string): Promise<LimitObservation[]>`
  - `insertLimitObservation(userId: string, o: Omit<LimitObservation, "id">): Promise<LimitObservation>`
  - `setLimitObservationStatus(userId: string, id: string, status: LimitObservationStatus): Promise<boolean>`
  - `eventsSince(userId: string, sinceIso: string): Promise<UsageEvent[]>`

- [ ] **Step 1: Read the patterns you are mirroring**

Run: `grep -n -A 20 "export const recommendations = pgTable" apps/api/src/db/schema.ts`
Run: `grep -n "listRecommendations\|dismissRecommendation" apps/api/src/services/events-repo.ts`

There are TWO `EventsRepo` implementations in that file — Drizzle-backed and in-memory. **Both must gain all four methods.** The session-rules work shipped SQL that no test could reach; do not repeat that silently.

- [ ] **Step 2: Write the failing test**

Add to `apps/api/src/services/events-repo.test.ts`, using the file's existing repo factory and insert helpers:

```ts
describe("limit observations", () => {
  it("round-trips an observation", async () => {
    const repo = makeMemoryRepo();
    const created = await repo.insertLimitObservation("u1", {
      windowKind: "weekly_7d",
      observedAt: "2026-08-09T12:00:00.000Z",
      unitsInWindow: 1_234_567,
      provenance: "declared",
      status: "active",
    });
    expect(created.id).toBeTruthy();
    const all = await repo.listLimitObservations("u1");
    expect(all).toHaveLength(1);
    expect(all[0]!.unitsInWindow).toBe(1_234_567);
    expect(all[0]!.provenance).toBe("declared");
  });

  it("scopes observations to their user", async () => {
    const repo = makeMemoryRepo();
    await repo.insertLimitObservation("u1", {
      windowKind: "weekly_7d", observedAt: "2026-08-09T12:00:00.000Z",
      unitsInWindow: 1, provenance: "declared", status: "active",
    });
    expect(await repo.listLimitObservations("u2")).toEqual([]);
  });

  it("updates status and reports whether a row matched", async () => {
    const repo = makeMemoryRepo();
    const created = await repo.insertLimitObservation("u1", {
      windowKind: "session_5h", observedAt: "2026-08-09T12:00:00.000Z",
      unitsInWindow: 10, provenance: "declared", status: "active",
    });
    expect(await repo.setLimitObservationStatus("u1", created.id, "dismissed")).toBe(true);
    expect((await repo.listLimitObservations("u1"))[0]!.status).toBe("dismissed");
    expect(await repo.setLimitObservationStatus("u1", "no-such-id", "dismissed")).toBe(false);
  });

  it("will not let one user change another's observation", async () => {
    const repo = makeMemoryRepo();
    const created = await repo.insertLimitObservation("u1", {
      windowKind: "session_5h", observedAt: "2026-08-09T12:00:00.000Z",
      unitsInWindow: 10, provenance: "declared", status: "active",
    });
    expect(await repo.setLimitObservationStatus("u2", created.id, "dismissed")).toBe(false);
    expect((await repo.listLimitObservations("u1"))[0]!.status).toBe("active");
  });
});

describe("eventsSince", () => {
  it("returns only events at or after the cutoff, oldest first", async () => {
    const repo = makeMemoryRepo();
    await insertEvent(repo, { userId: "u1", eventId: "a", timestamp: "2026-08-01T00:00:00.000Z", model: "claude-opus-5", inputTokens: 10, outputTokens: 1 });
    await insertEvent(repo, { userId: "u1", eventId: "b", timestamp: "2026-08-10T00:00:00.000Z", model: "claude-opus-5", inputTokens: 20, outputTokens: 2 });
    const got = await repo.eventsSince("u1", "2026-08-05T00:00:00.000Z");
    expect(got.map((e) => e.eventId)).toEqual(["b"]);
  });

  it("excludes aggregate-grain events, which have no single request inside them", async () => {
    const repo = makeMemoryRepo();
    await insertEvent(repo, { userId: "u1", eventId: "agg", grain: "aggregate", timestamp: "2026-08-10T00:00:00.000Z", model: "claude-opus-5", inputTokens: 5_000_000, outputTokens: 1 });
    expect(await repo.eventsSince("u1", "2026-08-01T00:00:00.000Z")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @tokenops/api exec vitest run src/services/events-repo.test.ts`
Expected: FAIL — `repo.insertLimitObservation is not a function`.

- [ ] **Step 4: Add the table**

In `apps/api/src/db/schema.ts`, after `recommendations`:

```ts
/**
 * Limits the user has actually observed being enforced.
 *
 * There is deliberately no "limit" column populated from a provider: for
 * subscription plans Anthropic publishes no quota and exposes none
 * programmatically, so every row here originates with the user — either
 * declared outright, or confirmed from a detected candidate.
 */
export const limitObservations = pgTable("limit_observations", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** "session_5h" | "weekly_7d" */
  windowKind: text("window_kind").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  /** Trailing-window total in consumption units at the observed instant. */
  unitsInWindow: numeric("units_in_window", { precision: 20, scale: 4 }).notNull(),
  /** "measured" | "reported" | "declared" | "inferred" */
  provenance: text("provenance").notNull(),
  /** "active" | "superseded" | "dismissed" */
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LimitObservationRow = typeof limitObservations.$inferSelect;
```

- [ ] **Step 5: Generate and inspect the migration**

Run: `pnpm --filter @tokenops/api db:generate`
Then: `ls apps/api/drizzle/` and read the newest `.sql` file. It must contain exactly one `CREATE TABLE "limit_observations"` and no `DROP` of any existing table. If it contains a drop, stop and report — do not apply it.

- [ ] **Step 6: Add the methods to the `EventsRepo` type**

In `apps/api/src/services/events-repo.ts`, inside the `EventsRepo` type:

```ts
  /** Every limit observation for a user, newest first. */
  listLimitObservations(userId: string): Promise<LimitObservation[]>;
  insertLimitObservation(
    userId: string,
    observation: Omit<LimitObservation, "id">,
  ): Promise<LimitObservation>;
  /** Returns false when no row matched — including when it belongs to another user. */
  setLimitObservationStatus(
    userId: string,
    id: string,
    status: LimitObservationStatus,
  ): Promise<boolean>;
  /**
   * Request-grain events at or after `sinceIso`, oldest first, for the
   * forecast. Aggregate-grain rows are excluded: they are time-bucketed sums
   * with no single request inside them, so they would distort both the
   * windows and the pace.
   */
  eventsSince(userId: string, sinceIso: string): Promise<UsageEvent[]>;
```

- [ ] **Step 7: Implement in the Drizzle repo**

```ts
    async listLimitObservations(userId) {
      const rows = await db
        .select()
        .from(limitObservations)
        .where(eq(limitObservations.userId, userId))
        .orderBy(desc(limitObservations.observedAt));
      return rows.map((r) => ({
        id: r.id,
        windowKind: r.windowKind as WindowKind,
        observedAt: new Date(r.observedAt).toISOString(),
        unitsInWindow: Number(r.unitsInWindow),
        provenance: r.provenance as LimitProvenance,
        status: r.status as LimitObservationStatus,
      }));
    },

    async insertLimitObservation(userId, observation) {
      const [row] = await db
        .insert(limitObservations)
        .values({
          userId,
          windowKind: observation.windowKind,
          observedAt: new Date(observation.observedAt),
          unitsInWindow: String(observation.unitsInWindow),
          provenance: observation.provenance,
          status: observation.status,
        })
        .returning();
      return {
        id: row!.id,
        windowKind: row!.windowKind as WindowKind,
        observedAt: new Date(row!.observedAt).toISOString(),
        unitsInWindow: Number(row!.unitsInWindow),
        provenance: row!.provenance as LimitProvenance,
        status: row!.status as LimitObservationStatus,
      };
    },

    async setLimitObservationStatus(userId, id, status) {
      const updated = await db
        .update(limitObservations)
        .set({ status })
        .where(and(eq(limitObservations.userId, userId), eq(limitObservations.id, id)))
        .returning({ id: limitObservations.id });
      return updated.length > 0;
    },

    async eventsSince(userId, sinceIso) {
      const rows = await db
        .select()
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.userId, userId),
            gte(usageEvents.timestamp, new Date(sinceIso)),
            or(isNull(usageEvents.grain), ne(usageEvents.grain, "aggregate")),
          ),
        )
        .orderBy(usageEvents.timestamp);
      return rows.map(rowToUsageEvent);
    },
```

**Note:** `grain` is nullable, so `ne(grain, "aggregate")` alone evaluates to NULL — and therefore excludes the row — for ordinary request events. The `or(isNull(...), ne(...))` form is required. Reuse the existing `rowToUsageEvent` mapper in this file; do not write a second one. Add `desc` to the `drizzle-orm` import if absent.

- [ ] **Step 8: Implement in the memory repo**

Mirror all four using the in-memory arrays: a `Map<string, LimitObservation & { userId: string }>` keyed by a generated id (use `crypto.randomUUID()`), and for `eventsSince`, filter the event array by `userId`, `timestamp >= sinceIso`, and `grain !== "aggregate"`, sorted ascending by timestamp.

- [ ] **Step 9: Run the tests**

Run: `pnpm --filter @tokenops/api test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/src/services/events-repo.ts apps/api/src/services/events-repo.test.ts
git commit -m "$(cat <<'EOF'
feat(api): limit_observations table and repo methods

Every row here originates with the user — declared outright, or confirmed
from a detected candidate. There is deliberately no provider-populated limit
column, because for subscription plans none is exposed.

eventsSince excludes aggregate-grain rows: time-bucketed sums have no single
request inside them and would distort both the windows and the pace. The
grain filter uses or(isNull, ne) because grain is nullable and a bare ne
would exclude every ordinary request event.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The forecast API

**Files:**
- Create: `apps/api/src/routes/forecast.ts`
- Create: `apps/api/src/routes/forecast.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `runForecast`, `detectCandidateWalls`, `toTimedUnits`, `trailingWindow`, `WINDOW_HOURS` from `@tokenops/shared`; the four repo methods from Task 6
- Produces:
  - `GET /v1/forecast` → `Forecast`
  - `POST /v1/limit-observations` → body `{ windowKind }`, stamps `observedAt = now` and `unitsInWindow` from the live trailing window; supersedes any previous active observation for that window kind
  - `POST /v1/limit-observations/:id/dismiss` → 200 `{ ok: true }` / 404
  - `POST /v1/wall-candidates/confirm` → body `{ id, windowKind, observedAt, unitsInWindow }`, creates a `declared` observation
  - `POST /v1/wall-candidates/dismiss` → body `{ id }`, stores a dismissed marker so it is never re-proposed

- [ ] **Step 1: Read an existing route for its auth and error patterns**

Run: `sed -n '1,60p' apps/api/src/routes/recommendations.ts`
Follow the same user resolution, the same JSON error shape, and the same registration style.

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/routes/forecast.test.ts`, mirroring the setup in `apps/api/src/routes/recommendations.test.ts`:

```ts
describe("GET /v1/forecast", () => {
  it("returns both windows and the counted-event totals", async () => {
    const res = await request("/v1/forecast");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.windows.map((w: { windowKind: string }) => w.windowKind)).toEqual([
      "session_5h",
      "weekly_7d",
    ]);
    expect(typeof body.eventsCounted).toBe("number");
    expect(typeof body.eventsWithoutBreakdown).toBe("number");
  });

  it("renders every ceiling with a provenance or with neither", async () => {
    // A number without provenance is exactly what this design exists to
    // prevent, so assert they travel together.
    const body = await (await request("/v1/forecast")).json();
    for (const w of body.windows) {
      if (w.ceiling === null) expect(w.ceilingProvenance).toBeNull();
      else expect(["measured", "reported", "declared", "inferred"]).toContain(w.ceilingProvenance);
    }
  });
});

describe("POST /v1/limit-observations", () => {
  it("records the live trailing total rather than trusting the client", async () => {
    // The client must not be able to claim an arbitrary ceiling; the server
    // stamps the number from its own ledger.
    const res = await request("/v1/limit-observations", {
      method: "POST",
      body: JSON.stringify({ windowKind: "weekly_7d", unitsInWindow: 999_999_999 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.observation.unitsInWindow).not.toBe(999_999_999);
    expect(body.observation.provenance).toBe("declared");
    expect(body.observation.status).toBe("active");
  });

  it("rejects an unknown window kind", async () => {
    const res = await request("/v1/limit-observations", {
      method: "POST",
      body: JSON.stringify({ windowKind: "monthly" }),
    });
    expect(res.status).toBe(400);
  });

  it("supersedes the previous active observation for that window", async () => {
    await request("/v1/limit-observations", {
      method: "POST", body: JSON.stringify({ windowKind: "weekly_7d" }),
    });
    await request("/v1/limit-observations", {
      method: "POST", body: JSON.stringify({ windowKind: "weekly_7d" }),
    });
    const body = await (await request("/v1/forecast")).json();
    // Exactly one active weekly ceiling drives the forecast.
    expect(body.windows.find((w: { windowKind: string }) => w.windowKind === "weekly_7d").ceilingProvenance).toBe("declared");
  });
});

describe("POST /v1/wall-candidates/dismiss", () => {
  it("stores a dismissal so the candidate is never proposed again", async () => {
    const res = await request("/v1/wall-candidates/dismiss", {
      method: "POST",
      body: JSON.stringify({ id: "wall:2026-08-03T00:00:00.000Z:72" }),
    });
    expect(res.status).toBe(200);
    const body = await (await request("/v1/forecast")).json();
    expect(body.candidates.map((c: { id: string }) => c.id)).not.toContain(
      "wall:2026-08-03T00:00:00.000Z:72",
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @tokenops/api exec vitest run src/routes/forecast.test.ts`
Expected: FAIL — 404, the routes do not exist.

- [ ] **Step 4: Write the routes**

Create `apps/api/src/routes/forecast.ts`. Key decisions to implement:

```ts
/** History fetched for the forecast. Enough for MIN_HISTORY_DAYS plus margin. */
const FORECAST_HISTORY_DAYS = 45;

/**
 * A dismissed candidate is stored as a limit_observations row with status
 * "dismissed" and provenance "inferred", using the candidate's own id encoded
 * in the observedAt/unitsInWindow pair. Reusing the table avoids a second
 * store for what is the same concept — a judgement the user has made about a
 * moment in their history.
 */
```

The handler for `GET /v1/forecast`:

1. `const since = new Date(Date.now() - FORECAST_HISTORY_DAYS * 86_400_000).toISOString()`
2. `const events = await repo.eventsSince(userId, since)`
3. `const observations = await repo.listLimitObservations(userId)`
4. `const forecast = runForecast(events, new Date().toISOString(), observations)`
5. `const dismissedIds` = ids reconstructed from observations with `status === "dismissed"`
6. `forecast.candidates = detectCandidateWalls(toTimedUnits(events), Date.now(), dismissedIds)`
7. Return it.

For `POST /v1/limit-observations`: validate `windowKind` against `["session_5h", "weekly_7d"]` (400 otherwise), compute `unitsInWindow = trailingWindow(toTimedUnits(events), Date.now(), WINDOW_HOURS[windowKind])` **from the server's own ledger, ignoring any client-supplied figure**, set every existing active observation for that window to `superseded`, then insert the new one with `provenance: "declared", status: "active"`.

For `POST /v1/wall-candidates/confirm`: validate the body, then insert a `declared`, `active` observation carrying the candidate's `observedAt` and `unitsInWindow`, superseding prior active ones for that window.

For dismissals: insert an `inferred`, `dismissed` observation whose id-bearing fields let step 5 above reconstruct the candidate id.

Wrap each repo call so a failure returns a JSON error rather than throwing — and make `GET /v1/forecast` degrade to `candidates: []` if only candidate detection fails, rather than failing the whole response. The recommendations route already carries this pattern for its coverage query.

- [ ] **Step 5: Mount the routes**

In `apps/api/src/app.ts`, register the forecast routes beside the existing ones, matching their prefix and middleware exactly.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @tokenops/api test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/forecast.ts apps/api/src/routes/forecast.test.ts apps/api/src/app.ts
git commit -m "$(cat <<'EOF'
feat(api): forecast route and limit observations

The server stamps unitsInWindow from its own ledger rather than trusting a
client-supplied figure — a declared ceiling is only meaningful if it is the
number TokenOps actually measured at that instant.

Candidate detection failing degrades to an empty candidate list rather than
failing the whole forecast, the same isolation the recommendations route
uses for its coverage query.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: The forecast panel

**Files:**
- Create: `apps/web/src/pages/Forecast.tsx`
- Create: `apps/web/src/pages/Forecast.test.tsx`
- Modify: `apps/web/src/api/client.ts`
- Modify: whichever file registers routes (find with `grep -rn "Recommendations" apps/web/src/App.tsx`)

**Interfaces:**
- Consumes: `GET /v1/forecast`, `POST /v1/limit-observations`, the candidate endpoints
- Produces: exported presentational components `WindowCard` and `CandidatePrompt`, plus the `Forecast` page

- [ ] **Step 1: Read the existing page and its tests**

Run: `sed -n '1,60p' apps/web/src/pages/Recommendations.test.tsx`

The web tests use `renderToStaticMarkup` from `react-dom/server` and strip tags with a regex — deliberately, so assertions pin what a person reads. **Do not introduce `@testing-library/react`.** Export small presentational components that take props, so they can be rendered without hooks or fetching, exactly as `RecommendationCard` and `CoverageNote` are.

- [ ] **Step 2: Write the failing test**

Create `apps/web/src/pages/Forecast.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WindowForecastDto } from "../api/client";
import { WindowCard } from "./Forecast";

function textOf(w: WindowForecastDto): string {
  return renderToStaticMarkup(<WindowCard window={w} />).replace(/<[^>]*>/g, "");
}

const base: WindowForecastDto = {
  windowKind: "weekly_7d",
  current: 1_340_000,
  pacePerHour: 9_000,
  ceiling: 1_540_000,
  ceilingProvenance: "inferred",
  fractionOfCeiling: 0.87,
  reachesCeilingAt: "2026-08-18T12:00:00.000Z",
  noProjectionReason: null,
};

describe("WindowCard", () => {
  it("always names the provenance beside the ceiling", () => {
    // A number without its provenance is the failure this design exists to
    // prevent: an inferred bound must never read like a measured fact.
    expect(textOf(base)).toMatch(/inferred/i);
  });

  it("calls an inferred ceiling the user's own maximum, not a limit", () => {
    expect(textOf(base)).not.toMatch(/your limit/i);
    expect(textOf(base)).toMatch(/highest|maximum/i);
  });

  it("calls a declared ceiling an observed limit", () => {
    const t = textOf({ ...base, ceilingProvenance: "declared" });
    expect(t).toMatch(/observed/i);
  });

  it("shows the reason instead of a date when there is no projection", () => {
    const t = textOf({
      ...base,
      ceiling: null,
      ceilingProvenance: null,
      fractionOfCeiling: null,
      reachesCeilingAt: null,
      noProjectionReason: "needs 14 days of history before a ceiling means anything (have 3)",
    });
    expect(t).toMatch(/needs 14 days of history/);
    expect(t).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("never renders a raw unit count without calling it an estimate", () => {
    // The unit is a proxy, not Anthropic's metering. Saying "usage" would
    // claim an accuracy this cannot have.
    const t = textOf(base);
    expect(t).not.toMatch(/\busage\b/i);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @tokenops/web exec vitest run src/pages/Forecast.test.tsx`
Expected: FAIL — cannot resolve `./Forecast`.

- [ ] **Step 4: Add the DTOs**

In `apps/web/src/api/client.ts`:

```ts
export type LimitProvenanceDto = "measured" | "reported" | "declared" | "inferred";

export type WindowForecastDto = {
  windowKind: "session_5h" | "weekly_7d";
  current: number;
  pacePerHour: number;
  ceiling: number | null;
  ceilingProvenance: LimitProvenanceDto | null;
  fractionOfCeiling: number | null;
  reachesCeilingAt: string | null;
  noProjectionReason: string | null;
};

export type WallCandidateDto = {
  id: string;
  windowKind: "session_5h" | "weekly_7d";
  startsAt: string;
  endsAt: string;
  gapHours: number;
  unitsInWindow: number;
};

export type ForecastDto = {
  generatedAt: string;
  windows: WindowForecastDto[];
  historyDays: number;
  eventsWithoutBreakdown: number;
  eventsCounted: number;
  candidates: WallCandidateDto[];
};

export function getForecast(): Promise<ForecastDto> {
  return api<ForecastDto>("/v1/forecast");
}
```

Add fetchers for the three POST endpoints following the existing `dismissRecommendation` style.

- [ ] **Step 5: Write the page**

Create `apps/web/src/pages/Forecast.tsx` exporting `WindowCard`, `CandidatePrompt`, and the `Forecast` page. Copy requirements, all pinned by the tests above:

- An **inferred** ceiling reads as *"87% of your highest week ever"* — never "your limit".
- A **declared** ceiling reads as *"78% of your observed limit (marked 9 Aug)"*.
- Provenance is rendered on every card.
- When `reachesCeilingAt` is null, render `noProjectionReason` verbatim and no date.
- The word "usage" never appears for a unit figure; use "consumption units (estimated)".
- When `eventsWithoutBreakdown / eventsCounted > 0.05`, add a line naming how many events lacked a cache breakdown, so the reader knows the proxy is coarser than usual.
- `CandidatePrompt` renders the question and two buttons, and must never state a ceiling.

- [ ] **Step 6: Register the page**

Add the route beside the existing pages, matching their nav pattern.

- [ ] **Step 7: Run both suites**

Run: `pnpm --filter @tokenops/web test && pnpm --filter @tokenops/api test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/Forecast.tsx apps/web/src/pages/Forecast.test.tsx apps/web/src/api/client.ts apps/web/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(web): forecast panel

Every figure renders beside its provenance, and the copy differs by it: an
inferred ceiling is "your highest week ever", a declared one is "your
observed limit". A number without provenance is the failure this design
exists to prevent, and a test pins it.

The word "usage" is kept off unit figures — the unit is a proxy, not
Anthropic's metering, and saying otherwise would claim an accuracy it
cannot have.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The acceptance gate

**Files:**
- Create: `scripts/measure-forecast.mjs`
- Modify: `README.md`, `README.html`

**Interfaces:**
- Consumes: `runForecast`, `detectCandidateWalls`, `toTimedUnits` from `../packages/shared/dist/index.js`

- [ ] **Step 1: Build so the script can import the package**

Run: `pnpm -r build`

**Import by relative path, not by bare specifier.** The repo root declares no dependency on `@tokenops/shared`, so `import … from "@tokenops/shared"` fails with `ERR_MODULE_NOT_FOUND`. Use:

```js
import {
  detectCandidateWalls,
  runForecast,
  toTimedUnits,
} from "../packages/shared/dist/index.js";
```

- [ ] **Step 2: Write the script**

Create `scripts/measure-forecast.mjs`. It must:

1. Read `~/.claude/projects/**/*.jsonl` recursively, honouring `WINDOW_DAYS` (default **45**, wider than the rules' gate because the forecast needs history for `MIN_HISTORY_DAYS`).
2. Keep only `type: "assistant"` lines with `message.usage`, **deduplicating by `message.id`** — Claude Code writes one line per content block, so a naive count inflates everything ~2×.
3. Build synthetic `UsageEvent` objects carrying `timestamp`, `inputTokens` (folded: `input + cache_read + cache_creation`), `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, and `features.modelTier: "frontier"`.
4. Call `runForecast(events, new Date().toISOString())` and print each window: current, pace/hour, ceiling with provenance, fraction, and either the projected date or the reason.
5. Call `detectCandidateWalls(toTimedUnits(events), Date.now(), [])` and print every candidate with its dates and gap length.
6. Support `--detail` to additionally print the top-20 hour-of-week activity slots, so the activity model can be eyeballed.

Gate, in this order:

```js
let failed = false;
// Criterion 1: the projection is computable and sane.
for (const w of forecast.windows) {
  if (!Number.isFinite(w.current) || !Number.isFinite(w.pacePerHour)) {
    console.error(`FAIL: ${w.windowKind} produced a non-finite figure`); failed = true;
  }
  if (w.reachesCeilingAt && Date.parse(w.reachesCeilingAt) < Date.now() - 60_000) {
    console.error(`FAIL: ${w.windowKind} projects exhaustion in the past`); failed = true;
  }
}
// Criterion 2: detection is bounded. Unbounded proposals are noise, and a
// detector that fires constantly is worse than none — the user stops reading.
if (candidates.length > 5) {
  console.error(
    `FAIL: ${candidates.length} wall candidates over ${WINDOW_DAYS} days is noise, not a prompt. ` +
      `Ship detection disabled and report this number rather than tuning until it looks right.`,
  );
  failed = true;
}
process.exit(failed ? 1 : 0);
```

- [ ] **Step 3: Run the gate and record the real numbers**

Run: `node scripts/measure-forecast.mjs --detail`

Capture the complete output. **Then check criterion 2's substance by hand**, which the script cannot: this project's author ran out of usage roughly three days before a reset. Look at the proposed candidates and report whether any corresponds to that period.

- If detection proposes that period → it works; say so with the dates.
- If it proposes nothing → report that plainly. Do not lower the thresholds to manufacture a hit.
- If it proposes many unrelated periods → the gate fails; **ship detection disabled** (return `[]` from the route's candidate step behind a clearly-named constant) and report the number.

Whichever happens, that outcome is the deliverable. Report it.

- [ ] **Step 4: Record the result in the README**

Add a short subsection under the existing **See your own numbers** heading:

```markdown
### Will I make it to reset?

```bash
node scripts/measure-forecast.mjs           # both windows, pace, projection
node scripts/measure-forecast.mjs --detail  # plus your hour-of-week activity model
```

Anthropic publishes no quota for subscription plans and exposes none
programmatically, so this never invents one. With no configuration it
compares your pace against **your own history** — your highest week ever is a
lower bound on your real limit, because you reached it. Mark a real limit hit
in the app and the projection switches to that instead, and says so.
```

Then regenerate the HTML: `node scripts/build-doc-html.mjs README.md README.html`

- [ ] **Step 5: Run the full suite and build**

Run: `pnpm -r build && pnpm -r test`
Expected: build clean, all tests green.

- [ ] **Step 6: Commit**

```bash
git add scripts/measure-forecast.mjs README.md README.html
git commit -m "$(cat <<'EOF'
test: acceptance gate for the usage forecast

Replays over real ~/.claude/projects history, deduplicating by message.id.
Fails on a non-finite figure, on a projection that lands in the past, and on
an unbounded candidate list — a detector that fires constantly is worse than
none, because the user stops reading it.

The substantive check cannot be automated: the author ran out of usage about
three days before a reset, and whether detection finds that period is the
real test. If it does not, detection ships disabled and the number is
reported rather than the thresholds moved.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Task |
|---|---|
| `LimitProvenance`, rendered beside every number | 1 (type), 8 (render) |
| Consumption units as a proxy; weights imported from pricing | 1 |
| Events without a cache breakdown counted, never fabricated | 1, 4 |
| Trailing 5h / 7d windows | 1 (constants), 2 |
| Exact roll-out modelling, test fails under naive extrapolation | 3 |
| Pace over trailing 24h | 3 |
| Ceiling order: declared, else historical maximum as `inferred` | 4 |
| `MIN_HISTORY_DAYS = 14` withholds a ceiling | 4 |
| Newest declaration wins; superseded/dismissed ignored | 4 (selection), 7 (supersede on write) |
| Candidate detection: three conditions, weekend excluded | 5 |
| Proposes but never decides | 5 (no ceiling emitted), 7 (confirm creates the declaration) |
| `limit_observations` on BOTH repo implementations | 6 |
| `GET /v1/forecast`, observation and candidate endpoints | 7 |
| Web panel rendering provenance | 8 |
| Error handling: no events, short history, zero pace, null cache, isolated failure | 1, 3, 4, 7 |
| Acceptance gate with ground truth | 9 |

No gaps.

**2. Placeholder scan**

No TBDs, and no deliberately-incomplete code. One place names a conditional outcome rather than a hole: Task 9 instructs shipping detection disabled if the gate's substantive check fails. That is a decision with a stated criterion, not deferred work.

**3. Type consistency**

- `WindowKind` values `"session_5h"` / `"weekly_7d"` identical across Tasks 1, 4, 5, 6, 7, 8.
- `LimitObservation` fields identical in Tasks 1, 4, 6, 7.
- `WindowForecast` field names match between Task 1 (definition), Task 4 (construction), and Task 8 (`WindowForecastDto`).
- `toTimedUnits` / `trailingWindow` / `projectWindow` / `pacePerHour` signatures identical in Tasks 2, 3, 4, 5, 7, 9.
- `detectCandidateWalls(sorted, nowMs, dismissedIds)` identical in Tasks 5, 7, 9.
- Repo method signatures identical between Task 6 (definition) and Task 7 (use).

## Known Risks

- **The Drizzle path still has no executable test.** No in-process Postgres fixture exists in this repo, so Task 6's SQL is verified by reading only — the same gap the session-rules work shipped with. Task 6 requires both implementations and a shared shape, but the honest statement is that only the memory one is exercised. Verify against Railway before calling this delivered.
- **Task 5's thresholds are not measured.** Unlike the rules' constants, no data exists to calibrate `CANDIDATE_MIN_GAP_HOURS` or `CANDIDATE_MIN_ACTIVE_HOURS`. Task 9 is what decides whether they survive, and the correct response to failing it is to disable the component, not to move them.
- **The forecast needs the agent running.** The API-side path produces nothing until events flow again; Task 9's script reads local JSONL directly and is therefore the only way to validate before that happens.
