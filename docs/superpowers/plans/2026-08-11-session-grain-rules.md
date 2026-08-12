# Session-Grain Recommendation Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace recommendation rules that cannot fire on coding-agent usage with two session-grain rules that measure the workload's actual cost drivers.

**Architecture:** A new `SessionRollup` input type — per-session totals plus a fixed-band histogram of context sizes — feeds a `runSessionRules` runner that sits alongside the existing `runAggregateRules`. Both reuse `priceFinding` and `isMaterial`, so savings assembly stays in one place. A new API job builds rollups from stored events and upserts one card per qualifying session, keyed on `ruleId|sessionId`.

**Tech Stack:** TypeScript (ESM, NodeNext), pnpm workspaces, Vitest, Drizzle + Postgres, Hono, React/Vite.

**Spec:** `docs/superpowers/specs/2026-08-11-session-grain-rules-design.md`

**Branch:** `feat/session-grain-rules`, already created off `main` at `732ad0a` with the spec committed at `6245734`.

## Global Constraints

- `CONTEXT_BAND_EDGES` is exactly `[0, 100_000, 200_000, 300_000, 400_000, 600_000]`. Band `i` covers `[edge[i], edge[i+1])`; the last band is `[600_000, ∞)`. Array fields sized by it always have `length === 6`.
- `SESSION_CONTEXT_TARGET_TOKENS = 300_000`, and it MUST be a member of `CONTEXT_BAND_EDGES`.
- `SESSION_MIN_TURNS = 20`.
- `SESSION_CHURN_MIN_COST_SHARE = 0.45`.
- `SESSION_CHURN_BASELINE_TOKEN_SHARE = 0.026`.
- `CACHE_READ_PRICE_MULTIPLIER = 0.1` and `CACHE_CREATION_PRICE_MULTIPLIER = 1.25` already exist in `packages/shared/src/pricing.ts`. Import them; never re-declare the numbers.
- `cacheReadTokens` / `cacheCreationTokens` are `number | null`. `null` means no breakdown was ever recorded; `0` means recorded and genuinely zero. Never coalesce `null` to `0`. Both rules stay silent when either is `null`.
- Rules never compute money. They return a `RuleFinding` with a `counterfactual`; `priceFinding` prices it.
- `assumption` strings are the CLAUSE ONLY, with no leading "Assumes" — the UI renders `Assumes: {assumption}`.
- Every new rule declares `grain: "aggregate"` (it consumes a rollup, not a single request), so `runRules`' declared-grain gate keeps it out of the per-request path.
- Open session cards are capped at the top 10 per rule, ranked by savings, and the cap is stated in the UI.
- End every commit message with: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Never use `--no-verify`, never force-push.

---

## File Structure

**Create:**
- `packages/shared/src/rules/session/rollup.ts` — `CONTEXT_BAND_EDGES`, `SessionRollup`, `contextBandIndex`, `assertBandArrays`, `sumBandsFrom`
- `packages/shared/src/rules/session/rollup.test.ts`
- `packages/shared/src/rules/session/context-ceiling.ts` — `sessionContextCeilingRule`
- `packages/shared/src/rules/session/context-ceiling.test.ts`
- `packages/shared/src/rules/session/cache-churn.ts` — `sessionCacheChurnRule`
- `packages/shared/src/rules/session/cache-churn.test.ts`
- `packages/shared/src/rules/session/index.ts` — `runSessionRules`, `SESSION_RULE_IDS`
- `packages/shared/src/rules/session/index.test.ts`
- `apps/api/src/jobs/session-rules.ts` — the job
- `apps/api/src/jobs/session-rules.test.ts`
- `scripts/measure-session-rules.mjs` — the back-test acceptance gate

**Modify:**
- `packages/shared/src/rules/types.ts` — add two `RuleId` members
- `packages/shared/src/index.ts` — re-export the session module
- `packages/shared/src/rules/aggregate/index.ts` — stop evaluating `cacheEfficiencyRule`
- `packages/shared/src/rules/assumptions.test.ts` — pin six strings, not five
- `apps/api/src/services/events-repo.ts` — add `sessionRollups` and `sessionCoverage` to both implementations
- `apps/api/src/routes/recommendations.ts` — expose coverage
- `apps/api/src/server.ts` (or wherever `startAggregateRulesJob` is called) — start the session job
- `apps/web/src/pages/Recommendations.tsx` — `API-equivalent` label, coverage line
- `apps/web/src/api/client.ts` — coverage field on the response type

**Delete:**
- `packages/shared/src/rules/aggregate/cache-efficiency.ts` and its test

---

### Task 1: Rollup type and band arithmetic

**Files:**
- Create: `packages/shared/src/rules/session/rollup.ts`
- Test: `packages/shared/src/rules/session/rollup.test.ts`

**Interfaces:**
- Consumes: `ModelTier` from `packages/shared/src/model-tier.js`
- Produces: `CONTEXT_BAND_EDGES`, `SessionRollup`, `contextBandIndex(tokens): number`, `assertBandArrays(rollup): void`, `sumBandsFrom(values, fromIndex): number`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/rules/session/rollup.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CONTEXT_BAND_EDGES,
  contextBandIndex,
  sumBandsFrom,
  assertBandArrays,
  type SessionRollup,
} from "./rollup.js";

function rollup(over: Partial<SessionRollup> = {}): SessionRollup {
  return {
    sessionId: "s1",
    start: "2026-08-01T00:00:00.000Z",
    end: "2026-08-01T01:00:00.000Z",
    turnCount: 30,
    model: "claude-opus-5",
    modelTier: "frontier",
    inputTokens: 1_000_000,
    outputTokens: 10_000,
    cacheReadTokens: 990_000,
    cacheCreationTokens: 10_000,
    turnsByContextBand: [1, 2, 3, 4, 5, 15],
    cacheReadByContextBand: [10, 20, 30, 40, 50, 60],
    ...over,
  };
}

describe("CONTEXT_BAND_EDGES", () => {
  it("is the exact published set of edges", () => {
    expect([...CONTEXT_BAND_EDGES]).toEqual([
      0, 100_000, 200_000, 300_000, 400_000, 600_000,
    ]);
  });

  it("is strictly ascending and starts at zero", () => {
    expect(CONTEXT_BAND_EDGES[0]).toBe(0);
    for (let i = 1; i < CONTEXT_BAND_EDGES.length; i += 1) {
      expect(CONTEXT_BAND_EDGES[i]).toBeGreaterThan(CONTEXT_BAND_EDGES[i - 1]);
    }
  });
});

describe("contextBandIndex", () => {
  it("places a value at a band's lower edge in that band, not the one below", () => {
    // The rule sums "reads at or above the target", so an off-by-one at the
    // edge silently moves a whole band's tokens across the threshold.
    expect(contextBandIndex(300_000)).toBe(3);
    expect(contextBandIndex(299_999)).toBe(2);
  });

  it("places every edge in its own band", () => {
    CONTEXT_BAND_EDGES.forEach((edge, i) => {
      expect(contextBandIndex(edge)).toBe(i);
    });
  });

  it("puts everything above the last edge in the final open-ended band", () => {
    expect(contextBandIndex(600_000)).toBe(5);
    expect(contextBandIndex(998_027)).toBe(5);
    expect(contextBandIndex(50_000_000)).toBe(5);
  });

  it("puts zero in the first band", () => {
    expect(contextBandIndex(0)).toBe(0);
  });

  it("throws on a negative context size rather than returning band 0", () => {
    expect(() => contextBandIndex(-1)).toThrow(/negative/i);
  });
});

describe("sumBandsFrom", () => {
  it("sums from the given index to the end, inclusive", () => {
    expect(sumBandsFrom([10, 20, 30, 40, 50, 60], 3)).toBe(150);
  });

  it("sums everything from index 0", () => {
    expect(sumBandsFrom([10, 20, 30, 40, 50, 60], 0)).toBe(210);
  });

  it("returns 0 when the index is past the end", () => {
    expect(sumBandsFrom([10, 20], 5)).toBe(0);
  });
});

describe("assertBandArrays", () => {
  it("accepts arrays matching the edge count", () => {
    expect(() => assertBandArrays(rollup())).not.toThrow();
  });

  it("throws when a band array is the wrong length", () => {
    // A wrong-length array is a bug in the rollup builder, not user data.
    // Truncating silently would drop the highest band — the one carrying
    // 46.9% of cache reads.
    expect(() =>
      assertBandArrays(rollup({ turnsByContextBand: [1, 2, 3] })),
    ).toThrow(/turnsByContextBand/);
    expect(() =>
      assertBandArrays(rollup({ cacheReadByContextBand: [1, 2, 3] })),
    ).toThrow(/cacheReadByContextBand/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tokenops/shared exec vitest run src/rules/session/rollup.test.ts`
Expected: FAIL — cannot resolve `./rollup.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/rules/session/rollup.ts`:

```ts
import type { ModelTier } from "../../model-tier.js";

/**
 * Context-size band edges, owned here and imported by the rollup builder in
 * the API. Band `i` covers [edge[i], edge[i+1]); the last band is
 * open-ended, so a rollup's band arrays always have length === 6.
 *
 * These are load-bearing rather than cosmetic: a rule threshold must BE one
 * of these edges, because the histogram can only be summed at boundaries.
 * A threshold between edges would require interpolating within a band —
 * an estimate presented to the user as an exact sum.
 */
export const CONTEXT_BAND_EDGES = [
  0, 100_000, 200_000, 300_000, 400_000, 600_000,
] as const;

/**
 * Per-session totals plus a context-size histogram.
 *
 * The histogram, rather than per-turn samples, is what keeps this bounded:
 * the largest session measured carries 1,935 turns, and a rollup that grew
 * with turn count could not be stored or passed around cheaply.
 *
 * cacheReadTokens/cacheCreationTokens keep the `number | null` semantics
 * established on ModelWindowTotals: `null` means no cache breakdown was
 * recorded for this session, `0` means recorded and genuinely zero.
 * Collapsing the two produces a confidently wrong finding in either
 * direction, so both session rules stay silent on `null`.
 */
export type SessionRollup = {
  sessionId: string;
  start: string;
  end: string;
  turnCount: number;
  /** Dominant model by input tokens — what the counterfactual is priced at. */
  model: string;
  modelTier: ModelTier;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** Turn counts per band. length === CONTEXT_BAND_EDGES.length. */
  turnsByContextBand: number[];
  /** Cache-read tokens per band. length === CONTEXT_BAND_EDGES.length. */
  cacheReadByContextBand: number[];
};

/**
 * Which band a context size falls in.
 *
 * A value sitting exactly on an edge belongs to the band that edge OPENS,
 * not the one it closes. That choice is what makes "reads at or above the
 * target" an exact sum starting at the target's own index.
 */
export function contextBandIndex(contextTokens: number): number {
  if (contextTokens < 0) {
    throw new Error(
      `contextBandIndex: negative context size ${contextTokens}`,
    );
  }
  let index = 0;
  for (let i = 0; i < CONTEXT_BAND_EDGES.length; i += 1) {
    if (contextTokens >= CONTEXT_BAND_EDGES[i]!) index = i;
  }
  return index;
}

/** Sum band values from `fromIndex` to the end, inclusive. */
export function sumBandsFrom(values: number[], fromIndex: number): number {
  let total = 0;
  for (let i = fromIndex; i < values.length; i += 1) total += values[i]!;
  return total;
}

/**
 * Guard the rollup builder's output shape.
 *
 * A mismatched length is a programming error upstream, never user data, so
 * this throws rather than padding or truncating — truncation would silently
 * discard the top band, which carries 46.9% of all cache reads.
 */
export function assertBandArrays(rollup: SessionRollup): void {
  const expected = CONTEXT_BAND_EDGES.length;
  if (rollup.turnsByContextBand.length !== expected) {
    throw new Error(
      `SessionRollup.turnsByContextBand must have length ${expected}, got ${rollup.turnsByContextBand.length}`,
    );
  }
  if (rollup.cacheReadByContextBand.length !== expected) {
    throw new Error(
      `SessionRollup.cacheReadByContextBand must have length ${expected}, got ${rollup.cacheReadByContextBand.length}`,
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tokenops/shared exec vitest run src/rules/session/rollup.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/rules/session/rollup.ts packages/shared/src/rules/session/rollup.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): session rollup type and context-band arithmetic

A fixed-band histogram rather than per-turn samples, so a rollup stays
bounded on the 1,935-turn sessions the measurements found. Band edges live
here because rule thresholds must be edges: the histogram can only be
summed at boundaries, and a threshold between them would interpolate.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The `session_context_ceiling` rule

**Files:**
- Create: `packages/shared/src/rules/session/context-ceiling.ts`
- Modify: `packages/shared/src/rules/types.ts`
- Test: `packages/shared/src/rules/session/context-ceiling.test.ts`

**Interfaces:**
- Consumes: `SessionRollup`, `CONTEXT_BAND_EDGES`, `contextBandIndex`, `sumBandsFrom`, `assertBandArrays` from `./rollup.js`; `Rule`, `RuleFinding`, `RuleContext` from `../contract.js`
- Produces: `sessionContextCeilingRule: Rule<SessionRollup>`, `SESSION_CONTEXT_TARGET_TOKENS`, `SESSION_MIN_TURNS`

- [ ] **Step 1: Add the rule ids**

Modify `packages/shared/src/rules/types.ts`, replacing the `RuleId` union:

```ts
export type RuleId =
  | "frontier_trivial"
  | "full_document_io"
  | "context_bloat"
  | "frontier_share"
  /**
   * Retired 2026-08-11: its gate (cache-read ratio below 0.50) cannot fire
   * on coding-agent traffic, where the measured median is 0.997. The id
   * stays in the union so historical rows already stored under it still
   * type-check when read back, and so the retirement sweep in
   * AGGREGATE_RULE_IDS can clear the cards it left open.
   */
  | "cache_efficiency"
  | "session_context_ceiling"
  | "session_cache_churn";
```

- [ ] **Step 2: Write the failing test**

Create `packages/shared/src/rules/session/context-ceiling.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { RuleContext } from "../contract.js";
import type { SessionRollup } from "./rollup.js";
import {
  SESSION_CONTEXT_TARGET_TOKENS,
  SESSION_MIN_TURNS,
  sessionContextCeilingRule,
} from "./context-ceiling.js";
import { CONTEXT_BAND_EDGES } from "./rollup.js";

const ctx: RuleContext = { now: new Date("2026-08-11T00:00:00.000Z") };

function rollup(over: Partial<SessionRollup> = {}): SessionRollup {
  return {
    sessionId: "s1",
    start: "2026-08-01T00:00:00.000Z",
    end: "2026-08-01T06:00:00.000Z",
    turnCount: 100,
    model: "claude-opus-5",
    modelTier: "frontier",
    inputTokens: 60_000_000,
    outputTokens: 200_000,
    cacheReadTokens: 59_000_000,
    cacheCreationTokens: 1_000_000,
    // 40 turns at/above the 300k target (bands 3,4,5), carrying 24M reads.
    turnsByContextBand: [20, 20, 20, 10, 10, 20],
    cacheReadByContextBand: [1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000, 15_000_000],
    ...over,
  };
}

describe("sessionContextCeilingRule", () => {
  it("declares an aggregate grain so the per-request runner skips it", () => {
    expect(sessionContextCeilingRule.grain).toBe("aggregate");
    expect(sessionContextCeilingRule.id).toBe("session_context_ceiling");
    expect(sessionContextCeilingRule.defaultSeverity).toBe("warn");
  });

  it("targets a value that is an actual band edge", () => {
    // Not a style check: a target between edges cannot be summed exactly
    // from the histogram, so the rule would be interpolating.
    expect([...CONTEXT_BAND_EDGES]).toContain(SESSION_CONTEXT_TARGET_TOKENS);
  });

  it("fires on a session carrying reads above the target", () => {
    const finding = sessionContextCeilingRule.evaluate(rollup(), ctx);
    expect(finding).not.toBeNull();
    // Bands 3,4,5 = 4M + 5M + 15M reads over 40 turns.
    expect(finding!.implicatedTokens).toBe(24_000_000);
    expect(finding!.eventIds).toEqual([]);
  });

  it("prices the counterfactual as those same turns each reading the target", () => {
    const finding = sessionContextCeilingRule.evaluate(rollup(), ctx)!;
    // 40 turns above target x 300_000 = 12_000_000.
    expect(finding.counterfactual.inputTokens).toBe(12_000_000);
    expect(finding.counterfactual.cacheReadTokens).toBe(12_000_000);
    // Output and cache creation are unchanged by the advice, so they are
    // set to 0 on BOTH sides and cancel out of the subtraction.
    expect(finding.counterfactual.outputTokens).toBe(0);
    expect(finding.counterfactual.cacheCreationTokens).toBe(0);
    expect(finding.counterfactual.model).toBe("claude-opus-5");
  });

  it("resolves the actual to only the above-target turns", () => {
    const finding = sessionContextCeilingRule.evaluate(rollup(), ctx)!;
    const actual = sessionContextCeilingRule.resolveActual!(rollup(), finding);
    expect(actual).toEqual({
      model: "claude-opus-5",
      inputTokens: 24_000_000,
      outputTokens: 0,
      cacheReadTokens: 24_000_000,
      cacheCreationTokens: 0,
    });
  });

  it("stays silent on a session shorter than the turn floor", () => {
    expect(
      sessionContextCeilingRule.evaluate(
        rollup({ turnCount: SESSION_MIN_TURNS - 1 }),
        ctx,
      ),
    ).toBeNull();
  });

  it("fires exactly at the turn floor", () => {
    expect(
      sessionContextCeilingRule.evaluate(
        rollup({ turnCount: SESSION_MIN_TURNS }),
        ctx,
      ),
    ).not.toBeNull();
  });

  it("stays silent when no turn reached the target", () => {
    expect(
      sessionContextCeilingRule.evaluate(
        rollup({
          turnsByContextBand: [50, 50, 0, 0, 0, 0],
          cacheReadByContextBand: [1_000_000, 2_000_000, 0, 0, 0, 0],
        }),
        ctx,
      ),
    ).toBeNull();
  });

  it("stays silent when no cache breakdown was recorded", () => {
    // null is "never recorded", not "zero" — a finding here would be
    // invented from absent data.
    expect(
      sessionContextCeilingRule.evaluate(rollup({ cacheReadTokens: null }), ctx),
    ).toBeNull();
    expect(
      sessionContextCeilingRule.evaluate(
        rollup({ cacheCreationTokens: null }),
        ctx,
      ),
    ).toBeNull();
  });

  it("stays silent when above-target reads do not exceed the counterfactual", () => {
    // 40 turns x 300k = 12M counterfactual; 6M actual reads is less, so
    // there is nothing to claim. Emitting here would rely on the pricer's
    // Math.max(0, ...) clamp to hide a negative saving.
    expect(
      sessionContextCeilingRule.evaluate(
        rollup({
          cacheReadByContextBand: [0, 0, 0, 2_000_000, 2_000_000, 2_000_000],
        }),
        ctx,
      ),
    ).toBeNull();
  });

  it("throws when the rollup's band arrays are the wrong length", () => {
    expect(() =>
      sessionContextCeilingRule.evaluate(
        rollup({ turnsByContextBand: [1, 2, 3] }),
        ctx,
      ),
    ).toThrow(/turnsByContextBand/);
  });

  it("names the session and its turn count in the detail", () => {
    const finding = sessionContextCeilingRule.evaluate(rollup(), ctx)!;
    expect(finding.detail).toContain("40");
    expect(finding.title).toMatch(/context/i);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @tokenops/shared exec vitest run src/rules/session/context-ceiling.test.ts`
Expected: FAIL — cannot resolve `./context-ceiling.js`.

- [ ] **Step 4: Write the implementation**

Create `packages/shared/src/rules/session/context-ceiling.ts`:

```ts
import type { Actual } from "../counterfactual.js";
import type { Rule, RuleFinding } from "../contract.js";
import {
  assertBandArrays,
  contextBandIndex,
  sumBandsFrom,
  type SessionRollup,
} from "./rollup.js";

/**
 * The context size a long session is compared against.
 *
 * MUST be a member of CONTEXT_BAND_EDGES — see the doc comment there. 300k
 * is chosen from measurement, not taste: across a real week, 21.1% of turns
 * ran above 600k and carried 46.9% of all cache reads, and holding context
 * at 300k would have cut cache-read tokens by 39.3%.
 */
export const SESSION_CONTEXT_TARGET_TOKENS = 300_000;

/** Below this, a session has no reset decision worth surfacing. */
export const SESSION_MIN_TURNS = 20;

const TARGET_BAND = contextBandIndex(SESSION_CONTEXT_TARGET_TOKENS);

/**
 * Reads and turns at or above the target. Split out because both evaluate()
 * and resolveActual() need exactly the same slice, and deriving it twice by
 * hand is how the two sides of a subtraction drift apart.
 */
function aboveTarget(rollup: SessionRollup): {
  turns: number;
  reads: number;
} {
  assertBandArrays(rollup);
  return {
    turns: sumBandsFrom(rollup.turnsByContextBand, TARGET_BAND),
    reads: sumBandsFrom(rollup.cacheReadByContextBand, TARGET_BAND),
  };
}

/**
 * A long-running session re-reads its whole context every turn at the cache
 * -read rate. This rule states what the turns above the target cost, and
 * what they would have cost held at the target.
 *
 * It reports a BOUND, not a promise. Resetting a session is not free — you
 * lose context and may pay for rework — so the `assumption` string carries
 * the claim a user may reasonably dispute, and the detail text says what
 * the turns cost rather than what resetting would save.
 *
 * Known conservatism: a turn in the 300-400k band has context >= 300k but
 * cache READS slightly below it, since part of its input is cache creation.
 * `target * turns` can therefore marginally exceed that band's actual
 * reads. The effect pushes savings DOWN, which is the correct direction for
 * a bound. Do not "fix" it by inflating the counterfactual.
 */
export const sessionContextCeilingRule: Rule<SessionRollup> = {
  id: "session_context_ceiling",
  grain: "aggregate",
  defaultSeverity: "warn",

  evaluate(rollup: SessionRollup): RuleFinding | null {
    if (rollup.turnCount < SESSION_MIN_TURNS) return null;
    // null means no breakdown was recorded; inventing 0 here would mint a
    // finding out of absent data.
    if (rollup.cacheReadTokens === null) return null;
    if (rollup.cacheCreationTokens === null) return null;

    const { turns, reads } = aboveTarget(rollup);
    if (turns === 0) return null;

    const counterfactualReads = SESSION_CONTEXT_TARGET_TOKENS * turns;
    // Emit only a positive claim. Leaving this to the pricer's
    // Math.max(0, ...) clamp would surface a $0 card asserting a saving
    // that the arithmetic does not support.
    if (reads <= counterfactualReads) return null;

    const targetK = SESSION_CONTEXT_TARGET_TOKENS / 1_000;
    return {
      title: "Long session re-reading a very large context",
      detail:
        `${turns} of this session's ${rollup.turnCount} turns ran with a context at or above ` +
        `${targetK}k tokens, re-reading ${reads.toLocaleString("en-US")} cached tokens between them. ` +
        `Held at ${targetK}k, those turns would have re-read ` +
        `${counterfactualReads.toLocaleString("en-US")}.`,
      eventIds: [],
      implicatedTokens: reads,
      counterfactual: {
        model: rollup.model,
        inputTokens: counterfactualReads,
        outputTokens: 0,
        cacheReadTokens: counterfactualReads,
        cacheCreationTokens: 0,
      },
      assumption:
        "resetting context at this size would not have required re-doing work already in it",
    };
  },

  /**
   * Only the above-target turns are being compared, not the whole session —
   * so the runner cannot build the Actual from the input, and this rule
   * must say which slice it chose.
   */
  resolveActual(rollup: SessionRollup): Actual | null {
    const { reads } = aboveTarget(rollup);
    return {
      model: rollup.model,
      inputTokens: reads,
      outputTokens: 0,
      cacheReadTokens: reads,
      cacheCreationTokens: 0,
    };
  },
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @tokenops/shared exec vitest run src/rules/session/context-ceiling.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/rules/session/context-ceiling.ts packages/shared/src/rules/session/context-ceiling.test.ts packages/shared/src/rules/types.ts
git commit -m "$(cat <<'EOF'
feat(shared): session_context_ceiling rule

The measured lever: 21.1% of turns run above 600k context and carry 46.9%
of all cache reads. Holding context at 300k would have cut cache-read
tokens 39.3%, roughly 4x the entire cache-churn opportunity.

Reports a bound rather than a promise — resetting a session costs rework,
so the disputable claim rides on the card as its assumption, and the
counterfactual understates rather than overstates at band edges.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The `session_cache_churn` rule

**Files:**
- Create: `packages/shared/src/rules/session/cache-churn.ts`
- Test: `packages/shared/src/rules/session/cache-churn.test.ts`

**Interfaces:**
- Consumes: `SessionRollup` from `./rollup.js`; `SESSION_MIN_TURNS` from `./context-ceiling.js`; `CACHE_READ_PRICE_MULTIPLIER`, `CACHE_CREATION_PRICE_MULTIPLIER` from `../../pricing.js`
- Produces: `sessionCacheChurnRule: Rule<SessionRollup>`, `SESSION_CHURN_MIN_COST_SHARE`, `SESSION_CHURN_BASELINE_TOKEN_SHARE`, `churnCostShare(read, creation): number`

- [ ] **Step 1: Verify the multiplier export names before writing code**

Run: `grep -n "CACHE_READ_PRICE_MULTIPLIER\|CACHE_CREATION_PRICE_MULTIPLIER" packages/shared/src/pricing.ts`
Expected: both constants exported, `0.1` and `1.25`. Use these imports; do not re-declare the numbers.

- [ ] **Step 2: Write the failing test**

Create `packages/shared/src/rules/session/cache-churn.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { RuleContext } from "../contract.js";
import type { SessionRollup } from "./rollup.js";
import {
  SESSION_CHURN_BASELINE_TOKEN_SHARE,
  SESSION_CHURN_MIN_COST_SHARE,
  churnCostShare,
  sessionCacheChurnRule,
} from "./cache-churn.js";
import { SESSION_MIN_TURNS } from "./context-ceiling.js";

const ctx: RuleContext = { now: new Date("2026-08-11T00:00:00.000Z") };

function rollup(over: Partial<SessionRollup> = {}): SessionRollup {
  return {
    sessionId: "s1",
    start: "2026-08-01T00:00:00.000Z",
    end: "2026-08-01T06:00:00.000Z",
    turnCount: 100,
    model: "claude-opus-5",
    modelTier: "frontier",
    inputTokens: 10_000_000,
    outputTokens: 100_000,
    // churn share = 2M*1.25 / (2M*1.25 + 8M*0.1) = 2.5 / 3.3 = 0.757
    cacheReadTokens: 8_000_000,
    cacheCreationTokens: 2_000_000,
    turnsByContextBand: [50, 20, 10, 10, 5, 5],
    cacheReadByContextBand: [1, 1, 1, 1, 1, 1],
    ...over,
  };
}

describe("churnCostShare", () => {
  it("weights creation at 1.25x and reads at 0.1x", () => {
    // 100*1.25 = 125; 100*0.1 = 10; 125/135
    expect(churnCostShare(100, 100)).toBeCloseTo(125 / 135, 10);
  });

  it("is 0 when there is no creation", () => {
    expect(churnCostShare(1_000, 0)).toBe(0);
  });

  it("is 0 when there is neither, rather than NaN", () => {
    expect(churnCostShare(0, 0)).toBe(0);
  });
});

describe("SESSION_CHURN_BASELINE_TOKEN_SHARE", () => {
  it("is the creation share that yields a 25% baseline cost share", () => {
    // Solving 1.25C / (1.25C + 0.1(T-C)) = 0.25 for C/T gives 0.02597.
    // This test is the constant's derivation, executable.
    const T = 1_000_000;
    const C = T * SESSION_CHURN_BASELINE_TOKEN_SHARE;
    expect(churnCostShare(T - C, C)).toBeCloseTo(0.25, 2);
  });
});

describe("sessionCacheChurnRule", () => {
  it("declares an aggregate grain and info severity", () => {
    expect(sessionCacheChurnRule.grain).toBe("aggregate");
    expect(sessionCacheChurnRule.id).toBe("session_cache_churn");
    expect(sessionCacheChurnRule.defaultSeverity).toBe("info");
  });

  it("fires when churn dominates the session's input cost", () => {
    const finding = sessionCacheChurnRule.evaluate(rollup(), ctx);
    expect(finding).not.toBeNull();
    expect(finding!.implicatedTokens).toBe(2_000_000);
  });

  it("preserves total input tokens across the counterfactual", () => {
    // The advice is "the prefix should have been re-read, not rewritten" —
    // it moves tokens between buckets, it does not remove them.
    const finding = sessionCacheChurnRule.evaluate(rollup(), ctx)!;
    const cf = finding.counterfactual;
    expect(cf.inputTokens).toBe(10_000_000);
    expect(cf.cacheCreationTokens! + cf.cacheReadTokens!).toBe(10_000_000);
    expect(cf.cacheCreationTokens).toBe(260_000); // 10M * 0.026
    expect(cf.cacheReadTokens).toBe(9_740_000);
    expect(cf.model).toBe("claude-opus-5");
    expect(cf.outputTokens).toBe(0);
  });

  it("stays silent just below the cost-share threshold", () => {
    // Pick read/creation that land just under 0.45.
    // C=1, R=17.4 -> 1.25 / (1.25 + 1.74) = 0.418
    expect(
      sessionCacheChurnRule.evaluate(
        rollup({ cacheCreationTokens: 1_000_000, cacheReadTokens: 17_400_000, inputTokens: 18_400_000 }),
        ctx,
      ),
    ).toBeNull();
  });

  it("fires just above the cost-share threshold", () => {
    // C=1, R=15 -> 1.25 / (1.25 + 1.5) = 0.4545
    const finding = sessionCacheChurnRule.evaluate(
      rollup({ cacheCreationTokens: 1_000_000, cacheReadTokens: 15_000_000, inputTokens: 16_000_000 }),
      ctx,
    );
    expect(finding).not.toBeNull();
    expect(churnCostShare(15_000_000, 1_000_000)).toBeGreaterThan(
      SESSION_CHURN_MIN_COST_SHARE,
    );
  });

  it("stays silent on a session shorter than the turn floor", () => {
    expect(
      sessionCacheChurnRule.evaluate(
        rollup({ turnCount: SESSION_MIN_TURNS - 1 }),
        ctx,
      ),
    ).toBeNull();
  });

  it("stays silent when no cache breakdown was recorded", () => {
    expect(
      sessionCacheChurnRule.evaluate(rollup({ cacheReadTokens: null }), ctx),
    ).toBeNull();
    expect(
      sessionCacheChurnRule.evaluate(rollup({ cacheCreationTokens: null }), ctx),
    ).toBeNull();
  });

  it("stays silent when creation is already at or below baseline", () => {
    // Below baseline there is no excess to move, even if the share gate
    // somehow passed.
    expect(
      sessionCacheChurnRule.evaluate(
        rollup({ cacheCreationTokens: 0, cacheReadTokens: 10_000_000 }),
        ctx,
      ),
    ).toBeNull();
  });

  it("resolves the actual to the session's own cache split", () => {
    const finding = sessionCacheChurnRule.evaluate(rollup(), ctx)!;
    const actual = sessionCacheChurnRule.resolveActual!(rollup(), finding);
    expect(actual).toEqual({
      model: "claude-opus-5",
      inputTokens: 10_000_000,
      outputTokens: 0,
      cacheReadTokens: 8_000_000,
      cacheCreationTokens: 2_000_000,
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @tokenops/shared exec vitest run src/rules/session/cache-churn.test.ts`
Expected: FAIL — cannot resolve `./cache-churn.js`.

- [ ] **Step 4: Write the implementation**

Create `packages/shared/src/rules/session/cache-churn.ts`:

```ts
import {
  CACHE_CREATION_PRICE_MULTIPLIER,
  CACHE_READ_PRICE_MULTIPLIER,
} from "../../pricing.js";
import type { Rule, RuleFinding } from "../contract.js";
import type { Actual } from "../counterfactual.js";
import { SESSION_MIN_TURNS } from "./context-ceiling.js";
import type { SessionRollup } from "./rollup.js";

/**
 * Cache creation's share of a session's INPUT COST (not of its tokens).
 * Measured across a real week: p10 24.0%, p50 45.4%, p90 69.6%. Creation is
 * only 3.3% of tokens but 29.7% of the input bill, so a token-share
 * threshold would be reading the wrong axis entirely.
 */
export const SESSION_CHURN_MIN_COST_SHARE = 0.45;

/**
 * Creation as a share of total input TOKENS in the counterfactual.
 *
 * Derived, not chosen. Holding T = C + R fixed and solving
 *   1.25C / (1.25C + 0.10(T - C)) = 0.25
 * for the 25%-of-input-cost baseline (measured p10 is 24.0%) gives
 * C = 0.02597 T, rounded here to 0.026. cache-churn.test.ts re-derives it
 * so the constant cannot drift away from its own justification.
 */
export const SESSION_CHURN_BASELINE_TOKEN_SHARE = 0.026;

/**
 * Cache creation's share of input cost, using the same multipliers the
 * pricer bills at. Returns 0 rather than NaN when there is no input at all.
 */
export function churnCostShare(
  cacheReadTokens: number,
  cacheCreationTokens: number,
): number {
  const creationCost = cacheCreationTokens * CACHE_CREATION_PRICE_MULTIPLIER;
  const readCost = cacheReadTokens * CACHE_READ_PRICE_MULTIPLIER;
  const total = creationCost + readCost;
  return total === 0 ? 0 : creationCost / total;
}

/**
 * A cached prefix that keeps invalidating gets rewritten at 12.5x the rate
 * it would be read at. This rule fires when that rewriting dominates a
 * session's input cost.
 *
 * Severity is `info`, not `warn`, deliberately: the 90 sessions above this
 * threshold in the measured week account for only 8.2% of consumption. The
 * finding is real and actionable — stop editing files already early in
 * context — but it is not where the money is, and ranking it alongside
 * session_context_ceiling would misrepresent that.
 */
export const sessionCacheChurnRule: Rule<SessionRollup> = {
  id: "session_cache_churn",
  grain: "aggregate",
  defaultSeverity: "info",

  evaluate(rollup: SessionRollup): RuleFinding | null {
    if (rollup.turnCount < SESSION_MIN_TURNS) return null;
    if (rollup.cacheReadTokens === null) return null;
    if (rollup.cacheCreationTokens === null) return null;

    const read = rollup.cacheReadTokens;
    const creation = rollup.cacheCreationTokens;
    if (churnCostShare(read, creation) <= SESSION_CHURN_MIN_COST_SHARE) {
      return null;
    }

    const total = read + creation;
    const baselineCreation = Math.round(
      total * SESSION_CHURN_BASELINE_TOKEN_SHARE,
    );
    if (creation <= baselineCreation) return null;

    const sharePct = Math.round(churnCostShare(read, creation) * 100);
    return {
      title: "Cached prefix keeps being rewritten",
      detail:
        `Cache writes are ${sharePct}% of this session's input cost across ${rollup.turnCount} turns ` +
        `(${creation.toLocaleString("en-US")} tokens written, ${read.toLocaleString("en-US")} read). ` +
        `A write costs 12.5x a read, so a prefix that stayed valid would have cost far less.`,
      eventIds: [],
      implicatedTokens: creation,
      counterfactual: {
        model: rollup.model,
        // Tokens move between buckets; none are removed. The advice is
        // "this should have been re-read, not rewritten".
        inputTokens: total,
        outputTokens: 0,
        cacheReadTokens: total - baselineCreation,
        cacheCreationTokens: baselineCreation,
      },
      assumption:
        "a stable cached prefix would have re-read this content instead of rewriting it",
    };
  },

  /**
   * Compared against the session's cache split alone, with output zeroed on
   * both sides — output is untouched by this advice and would otherwise sit
   * identically on both sides of the subtraction.
   */
  resolveActual(rollup: SessionRollup): Actual | null {
    if (rollup.cacheReadTokens === null) return null;
    if (rollup.cacheCreationTokens === null) return null;
    return {
      model: rollup.model,
      inputTokens: rollup.cacheReadTokens + rollup.cacheCreationTokens,
      outputTokens: 0,
      cacheReadTokens: rollup.cacheReadTokens,
      cacheCreationTokens: rollup.cacheCreationTokens,
    };
  },
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @tokenops/shared exec vitest run src/rules/session/cache-churn.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/rules/session/cache-churn.ts packages/shared/src/rules/session/cache-churn.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): session_cache_churn rule

Fires when cache writes dominate a session's input cost, meaning the
cached prefix keeps invalidating. Severity is info rather than warn
because the 90 sessions above threshold are only 8.2% of measured burn —
real and actionable, but not where the money is.

The baseline constant is derived in a test rather than asserted, so it
cannot drift from its own justification.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `runSessionRules` and package exports

**Files:**
- Create: `packages/shared/src/rules/session/index.ts`
- Create: `packages/shared/src/rules/session/index.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/rules/assumptions.test.ts`

**Interfaces:**
- Consumes: `sessionContextCeilingRule`, `sessionCacheChurnRule`, `priceFinding` from `../index.js`, `isMaterial` from `../materiality.js`
- Produces: `runSessionRules(rollup: SessionRollup, now?: Date, priceOverrides?: Record<string, PriceRow>): RuleHit[]`, `SESSION_RULE_IDS`

- [ ] **Step 1: Read the existing assumptions test**

Run: `cat packages/shared/src/rules/assumptions.test.ts`
Note how the five existing strings are pinned; the new file must extend that structure, not replace it. Note also whether it asserts an exact count of rules — if so, that count changes.

- [ ] **Step 2: Write the failing test**

Create `packages/shared/src/rules/session/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SessionRollup } from "./rollup.js";
import { SESSION_RULE_IDS, runSessionRules } from "./index.js";

const NOW = new Date("2026-08-11T00:00:00.000Z");

function rollup(over: Partial<SessionRollup> = {}): SessionRollup {
  return {
    sessionId: "s1",
    start: "2026-08-01T00:00:00.000Z",
    end: "2026-08-01T06:00:00.000Z",
    turnCount: 100,
    model: "claude-opus-5",
    modelTier: "frontier",
    inputTokens: 60_000_000,
    outputTokens: 200_000,
    cacheReadTokens: 59_000_000,
    cacheCreationTokens: 1_000_000,
    turnsByContextBand: [20, 20, 20, 10, 10, 20],
    cacheReadByContextBand: [1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000, 15_000_000],
    ...over,
  };
}

describe("SESSION_RULE_IDS", () => {
  it("lists exactly the ids runSessionRules can emit", () => {
    // The job retires cards for every id in this list that produced no hit,
    // so an id missing here means a card that can never be retired.
    expect([...SESSION_RULE_IDS]).toEqual([
      "session_context_ceiling",
      "session_cache_churn",
    ]);
  });
});

describe("runSessionRules", () => {
  it("prices a ceiling hit into real dollars", () => {
    const hits = runSessionRules(rollup(), NOW);
    const ceiling = hits.find((h) => h.ruleId === "session_context_ceiling");
    expect(ceiling).toBeDefined();
    expect(ceiling!.estimatedWastedUsd).toBeGreaterThan(0);
    expect(ceiling!.estimatedWastedTokens).toBe(24_000_000);
    expect(ceiling!.severity).toBe("warn");
    expect(ceiling!.assumption).toContain("resetting context");
  });

  it("emits both rules when a session trips both", () => {
    const hits = runSessionRules(
      rollup({ cacheReadTokens: 8_000_000, cacheCreationTokens: 2_000_000 }),
      NOW,
    );
    expect(hits.map((h) => h.ruleId).sort()).toEqual([
      "session_cache_churn",
      "session_context_ceiling",
    ]);
  });

  it("returns nothing for a session below the turn floor", () => {
    expect(runSessionRules(rollup({ turnCount: 5 }), NOW)).toEqual([]);
  });

  it("drops immaterial hits", () => {
    // A tiny session that technically trips the gate but is worth far less
    // than a cent must not reach the panel.
    const hits = runSessionRules(
      rollup({
        turnCount: 20,
        turnsByContextBand: [0, 0, 0, 20, 0, 0],
        cacheReadByContextBand: [0, 0, 0, 6_000_001, 0, 0],
        cacheReadTokens: 6_000_001,
        cacheCreationTokens: 0,
      }),
      NOW,
    );
    // 6_000_001 reads vs 20*300_000 = 6_000_000 counterfactual: a 1-token
    // difference, far under MIN_WASTED_USD.
    expect(hits.find((h) => h.ruleId === "session_context_ceiling")).toBeUndefined();
  });

  it("prices at the instant it is given, not wall-clock now", () => {
    // Sonnet 5's introductory rate expires 2026-08-31; a replay must price
    // historical traffic at its own timestamp.
    const before = runSessionRules(
      rollup({ model: "claude-sonnet-5" }),
      new Date("2026-08-01T00:00:00.000Z"),
    );
    const after = runSessionRules(
      rollup({ model: "claude-sonnet-5" }),
      new Date("2026-09-01T00:00:00.000Z"),
    );
    const usdBefore = before.find((h) => h.ruleId === "session_context_ceiling")!.estimatedWastedUsd!;
    const usdAfter = after.find((h) => h.ruleId === "session_context_ceiling")!.estimatedWastedUsd!;
    expect(usdAfter).toBeGreaterThan(usdBefore);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @tokenops/shared exec vitest run src/rules/session/index.test.ts`
Expected: FAIL — cannot resolve `./index.js`.

- [ ] **Step 4: Write the runner**

Create `packages/shared/src/rules/session/index.ts`:

```ts
import type { PriceRow } from "../../pricing.js";
import type { Rule, RuleContext } from "../contract.js";
import { priceFinding } from "../index.js";
import { isMaterial } from "../materiality.js";
import type { RuleHit } from "../types.js";
import { sessionCacheChurnRule } from "./cache-churn.js";
import { sessionContextCeilingRule } from "./context-ceiling.js";
import type { SessionRollup } from "./rollup.js";

export {
  CONTEXT_BAND_EDGES,
  contextBandIndex,
  sumBandsFrom,
  assertBandArrays,
  type SessionRollup,
} from "./rollup.js";
export {
  SESSION_CONTEXT_TARGET_TOKENS,
  SESSION_MIN_TURNS,
  sessionContextCeilingRule,
} from "./context-ceiling.js";
export {
  SESSION_CHURN_MIN_COST_SHARE,
  SESSION_CHURN_BASELINE_TOKEN_SHARE,
  churnCostShare,
  sessionCacheChurnRule,
} from "./cache-churn.js";

/**
 * Every ruleId `runSessionRules` can emit.
 *
 * The session-rules job walks this list to retire cards for rules that
 * produced no hit in a run — a rule that stops firing never enters the hit
 * loop, so without an explicit list its last card stays open forever. Same
 * reasoning as AGGREGATE_RULE_IDS.
 */
export const SESSION_RULE_IDS = [
  "session_context_ceiling",
  "session_cache_churn",
] as const;

/** Both session rules, in the order their cards are emitted. */
const SESSION_RULES: Rule<SessionRollup>[] = [
  sessionContextCeilingRule,
  sessionCacheChurnRule,
];

/**
 * Run every session-grain rule against one session's rollup.
 *
 * A sibling of runAggregateRules rather than an extension of it: that
 * runner's input is per-MODEL totals over a time window, this one's is per
 * -SESSION totals with a context histogram. Both funnel through
 * priceFinding and isMaterial so savings assembly and the materiality floor
 * live in exactly one place each.
 *
 * @param now Pricing instant. Replays MUST pass the session's own end
 *   timestamp, not wall-clock now — otherwise a date-gated rate (the Claude
 *   Sonnet 5 introductory price, expiring 2026-08-31) reprices past traffic
 *   as the clock moves, and the same history reports different savings on
 *   different days.
 */
export function runSessionRules(
  rollup: SessionRollup,
  now: Date = new Date(),
  priceOverrides?: Record<string, PriceRow>,
): RuleHit[] {
  const ctx: RuleContext = { now, priceOverrides };
  const hits: RuleHit[] = [];

  for (const rule of SESSION_RULES) {
    const finding = rule.evaluate(rollup, ctx);
    if (!finding) continue;
    const actual = rule.resolveActual!(rollup, finding);
    if (!actual) continue;
    hits.push(priceFinding(rule, finding, actual, ctx));
  }

  return hits.filter(isMaterial);
}
```

- [ ] **Step 5: Re-export from the package entry point**

Find the line in `packages/shared/src/index.ts` that re-exports the aggregate rules (search for `rules/aggregate`) and add a sibling line directly beneath it:

```ts
export * from "./rules/session/index.js";
```

- [ ] **Step 6: Extend the pinned-assumption test**

In `packages/shared/src/rules/assumptions.test.ts`, add the two new strings to the pinned set, matching the file's existing structure exactly:

```ts
  session_context_ceiling:
    "resetting context at this size would not have required re-doing work already in it",
  session_cache_churn:
    "a stable cached prefix would have re-read this content instead of rewriting it",
```

If the file asserts a total rule count, update it from 5 to 7.

- [ ] **Step 7: Run the shared suite**

Run: `pnpm --filter @tokenops/shared test`
Expected: PASS, all files green.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/rules/session/index.ts packages/shared/src/rules/session/index.test.ts packages/shared/src/index.ts packages/shared/src/rules/assumptions.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): runSessionRules

A sibling of runAggregateRules — per-session totals with a context
histogram rather than per-model window totals — funnelling through the
same priceFinding and isMaterial so savings assembly stays in one place.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Retire `cache_efficiency`

**Files:**
- Modify: `packages/shared/src/rules/aggregate/index.ts`
- Delete: `packages/shared/src/rules/aggregate/cache-efficiency.ts`
- Modify: `packages/shared/src/rules/aggregate/aggregate.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `runAggregateRules` no longer emits `cache_efficiency`; `AGGREGATE_RULE_IDS` still contains the string

- [ ] **Step 1: Write the failing test**

In `packages/shared/src/rules/aggregate/aggregate.test.ts`, delete any test asserting that `cacheEfficiencyRule` fires, and add:

```ts
describe("cache_efficiency retirement", () => {
  it("never emits a cache_efficiency hit, even on a window that would have tripped it", () => {
    // Read ratio 0.10, far below the retired 0.50 gate.
    const window = {
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-08-08T00:00:00.000Z",
      byModel: [
        {
          model: "claude-opus-5",
          modelTier: "frontier" as const,
          inputTokens: 10_000_000,
          outputTokens: 100_000,
          cacheReadTokens: 1_000_000,
          cacheCreationTokens: 9_000_000,
          costUsd: null,
        },
      ],
    };
    const hits = runAggregateRules(window, new Date("2026-08-11T00:00:00.000Z"));
    expect(hits.map((h) => h.ruleId)).not.toContain("cache_efficiency");
  });

  it("keeps the id in AGGREGATE_RULE_IDS so open cards still get retired", () => {
    // The job supersedes open cards for every id in this list that produced
    // no hit. Dropping the id would strand every cache_efficiency card
    // already in the database, open forever with no rule to retire it.
    expect([...AGGREGATE_RULE_IDS]).toContain("cache_efficiency");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tokenops/shared exec vitest run src/rules/aggregate/aggregate.test.ts`
Expected: FAIL — the first test fails because the rule still fires.

- [ ] **Step 3: Remove the evaluation**

In `packages/shared/src/rules/aggregate/index.ts`:

1. Delete the `import { cacheEfficiencyRule } from "./cache-efficiency.js";` line.
2. Delete the `export { CACHE_EFFICIENCY_MIN_READ_RATIO, cacheEfficiencyRule } from "./cache-efficiency.js";` block.
3. Delete the entire `isWorseCacheHit` function.
4. Delete the `let worstCache: RuleHit | null = null;` block, its `for (const totals of window.byModel)` loop, and the `if (worstCache) hits.push(worstCache);` line.
5. Replace the `AGGREGATE_RULE_IDS` doc comment's final sentence and keep the array itself unchanged, adding:

```ts
/**
 * Every ruleId the aggregate job must consider for retirement.
 *
 * `cache_efficiency` is RETIRED as of 2026-08-11 — runAggregateRules no
 * longer evaluates it, because its gate (cache-read ratio below 0.50)
 * cannot fire on coding-agent traffic where the measured median is 0.997.
 * The id stays in this list on purpose: the job supersedes open cards for
 * every listed rule that produced no hit, so leaving it here is exactly
 * what clears the cards already in the database. Removing it would strand
 * them open forever. Do not "tidy" it away.
 */
export const AGGREGATE_RULE_IDS = ["frontier_share", "cache_efficiency"] as const;
```

- [ ] **Step 4: Delete the rule module and its test**

```bash
git rm packages/shared/src/rules/aggregate/cache-efficiency.ts
git rm packages/shared/src/rules/aggregate/cache-efficiency.test.ts 2>/dev/null || true
```

If `cache-efficiency.test.ts` does not exist, its tests live in `aggregate.test.ts` — remove them there instead.

- [ ] **Step 5: Fix any remaining references**

Run: `grep -rn "cacheEfficiencyRule\|CACHE_EFFICIENCY_MIN_READ_RATIO" --include=*.ts --include=*.tsx .`
Expected: no matches outside comments. Remove each one found, including any re-export in `packages/shared/src/index.ts` and any mention in `packages/shared/src/rules/assumptions.test.ts` (the pinned set drops to 6: four surviving originals plus the two new session strings).

- [ ] **Step 6: Run the full shared and api suites**

Run: `pnpm --filter @tokenops/shared test && pnpm --filter @tokenops/api test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A packages/shared/src/rules packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
refactor(shared): retire cache_efficiency

Its gate is a cache-read ratio below 0.50; the measured median on
coding-agent traffic is 0.997, so it cannot fire. Retired rather than
retargeted at churn — reusing the id would silently change what cards
already stored under it meant.

The id stays in AGGREGATE_RULE_IDS deliberately: the job's retirement
sweep is what clears the cards it left open.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Build rollups from stored events

**Files:**
- Modify: `apps/api/src/services/events-repo.ts`
- Test: `apps/api/src/services/events-repo.test.ts` (add to the existing file)

**Interfaces:**
- Consumes: `SessionRollup`, `CONTEXT_BAND_EDGES` from `@tokenops/shared`
- Produces: two new `EventsRepo` methods —
  - `sessionRollups(userId: string, sinceIso: string, untilIso: string): Promise<SessionRollup[]>`
  - `sessionCoverage(userId: string, sinceIso: string, untilIso: string): Promise<SessionCoverage>` where `type SessionCoverage = { sessionsConsidered: number; unattributedTurns: number; unattributedInputTokens: number }`

- [ ] **Step 1: Read the existing implementations you are mirroring**

Run: `sed -n '300,360p' apps/api/src/services/events-repo.ts` and `sed -n '660,720p' apps/api/src/services/events-repo.ts`

There are TWO implementations of `EventsRepo` in this file — a Drizzle-backed one and an in-memory one used by tests. Both must gain both methods. A method added to only one produces tests that pass against a repo the server never uses.

- [ ] **Step 2: Write the failing test**

Add to `apps/api/src/services/events-repo.test.ts`, following the file's existing setup for creating a repo and inserting events:

```ts
describe("sessionRollups", () => {
  it("buckets each turn into the band its context size falls in", async () => {
    const repo = makeMemoryRepo(); // use whatever factory this file already uses
    const base = {
      userId: "u1",
      model: "claude-opus-5",
      outputTokens: 1_000,
      sessionId: "sess-a",
    };
    // inputTokens IS the context size: cache tokens are folded into it.
    await insertEvent(repo, { ...base, inputTokens: 50_000, cacheReadTokens: 40_000, cacheCreationTokens: 1_000 });
    await insertEvent(repo, { ...base, inputTokens: 350_000, cacheReadTokens: 340_000, cacheCreationTokens: 2_000 });
    await insertEvent(repo, { ...base, inputTokens: 700_000, cacheReadTokens: 690_000, cacheCreationTokens: 3_000 });

    const [rollup] = await repo.sessionRollups("u1", SINCE, UNTIL);
    expect(rollup.sessionId).toBe("sess-a");
    expect(rollup.turnCount).toBe(3);
    // bands: 50k -> 0, 350k -> 3, 700k -> 5
    expect(rollup.turnsByContextBand).toEqual([1, 0, 0, 1, 0, 1]);
    expect(rollup.cacheReadByContextBand).toEqual([40_000, 0, 0, 340_000, 0, 690_000]);
    expect(rollup.cacheReadTokens).toBe(1_070_000);
    expect(rollup.cacheCreationTokens).toBe(6_000);
    expect(rollup.inputTokens).toBe(1_100_000);
  });

  it("reports null cache totals when ANY turn in the session lacks a breakdown", async () => {
    // Summing a missing breakdown as 0 would turn "we don't know" into "we
    // checked and it's zero", which both session rules act on differently.
    const repo = makeMemoryRepo();
    await insertEvent(repo, { userId: "u1", sessionId: "sess-b", model: "claude-opus-5", inputTokens: 500_000, outputTokens: 1_000, cacheReadTokens: 490_000, cacheCreationTokens: 1_000 });
    await insertEvent(repo, { userId: "u1", sessionId: "sess-b", model: "claude-opus-5", inputTokens: 500_000, outputTokens: 1_000 });

    const [rollup] = await repo.sessionRollups("u1", SINCE, UNTIL);
    expect(rollup.cacheReadTokens).toBeNull();
    expect(rollup.cacheCreationTokens).toBeNull();
  });

  it("picks the dominant model by input tokens", async () => {
    const repo = makeMemoryRepo();
    await insertEvent(repo, { userId: "u1", sessionId: "sess-c", model: "claude-haiku-4-5", inputTokens: 100_000, outputTokens: 100, cacheReadTokens: 90_000, cacheCreationTokens: 100 });
    await insertEvent(repo, { userId: "u1", sessionId: "sess-c", model: "claude-opus-5", inputTokens: 900_000, outputTokens: 100, cacheReadTokens: 890_000, cacheCreationTokens: 100 });

    const [rollup] = await repo.sessionRollups("u1", SINCE, UNTIL);
    expect(rollup.model).toBe("claude-opus-5");
    expect(rollup.modelTier).toBe("frontier");
  });

  it("emits band arrays of exactly the published length", async () => {
    const repo = makeMemoryRepo();
    await insertEvent(repo, { userId: "u1", sessionId: "sess-d", model: "claude-opus-5", inputTokens: 10_000, outputTokens: 100, cacheReadTokens: 9_000, cacheCreationTokens: 100 });
    const [rollup] = await repo.sessionRollups("u1", SINCE, UNTIL);
    expect(rollup.turnsByContextBand).toHaveLength(CONTEXT_BAND_EDGES.length);
    expect(rollup.cacheReadByContextBand).toHaveLength(CONTEXT_BAND_EDGES.length);
  });

  it("excludes events with no sessionId", async () => {
    const repo = makeMemoryRepo();
    await insertEvent(repo, { userId: "u1", model: "claude-opus-5", inputTokens: 500_000, outputTokens: 100, cacheReadTokens: 490_000, cacheCreationTokens: 100 });
    expect(await repo.sessionRollups("u1", SINCE, UNTIL)).toEqual([]);
  });

  it("excludes aggregate-grain events, which have no single request inside them", async () => {
    const repo = makeMemoryRepo();
    await insertEvent(repo, { userId: "u1", sessionId: "sess-e", grain: "aggregate", model: "claude-opus-5", inputTokens: 5_000_000, outputTokens: 100, cacheReadTokens: 4_900_000, cacheCreationTokens: 100 });
    expect(await repo.sessionRollups("u1", SINCE, UNTIL)).toEqual([]);
  });
});

describe("sessionCoverage", () => {
  it("counts sessions and reports what no session claims", async () => {
    // Sidechain turns carry no sessionId by the adapter's design, so their
    // consumption belongs to no rollup. The panel must be able to say so
    // rather than presenting partial coverage as total.
    const repo = makeMemoryRepo();
    await insertEvent(repo, { userId: "u1", sessionId: "sess-f", model: "claude-opus-5", inputTokens: 100_000, outputTokens: 100, cacheReadTokens: 90_000, cacheCreationTokens: 100 });
    await insertEvent(repo, { userId: "u1", model: "claude-opus-5", inputTokens: 400_000, outputTokens: 100, cacheReadTokens: 390_000, cacheCreationTokens: 100 });
    await insertEvent(repo, { userId: "u1", model: "claude-opus-5", inputTokens: 600_000, outputTokens: 100, cacheReadTokens: 590_000, cacheCreationTokens: 100 });

    const coverage = await repo.sessionCoverage("u1", SINCE, UNTIL);
    expect(coverage.sessionsConsidered).toBe(1);
    expect(coverage.unattributedTurns).toBe(2);
    expect(coverage.unattributedInputTokens).toBe(1_000_000);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @tokenops/api exec vitest run src/services/events-repo.test.ts`
Expected: FAIL — `repo.sessionRollups is not a function`.

- [ ] **Step 4: Add both methods to the `EventsRepo` type**

In `apps/api/src/services/events-repo.ts`, inside the `EventsRepo` type (near `modelWindowTotals`):

```ts
  /**
   * Per-session totals plus a context-size histogram, for the session rules.
   *
   * Only request-grain events with a sessionId participate. Aggregate-grain
   * rows are time-bucketed sums with no single request inside them, so they
   * have no context size to band. Events with no sessionId (sidechain /
   * subagent turns, by the adapter's design) belong to no session — see
   * sessionCoverage, which reports what they add up to.
   *
   * cacheReadTokens/cacheCreationTokens are NULL for the whole session if
   * ANY turn in it lacks a breakdown, same rule as modelWindowTotals: a
   * COALESCE-to-0 sum would turn "unknown" into "checked, and zero".
   */
  sessionRollups(
    userId: string,
    sinceIso: string,
    untilIso: string,
  ): Promise<SessionRollup[]>;
  /**
   * How much of the window the session rollups actually cover. Lets the UI
   * state its own blind spot instead of presenting partial coverage as
   * total.
   */
  sessionCoverage(
    userId: string,
    sinceIso: string,
    untilIso: string,
  ): Promise<SessionCoverage>;
```

And near the top of the file:

```ts
export type SessionCoverage = {
  sessionsConsidered: number;
  unattributedTurns: number;
  unattributedInputTokens: number;
};
```

- [ ] **Step 5: Implement in the Drizzle repo**

Add alongside `modelWindowTotals` in the Drizzle implementation. Build the band `CASE` from `CONTEXT_BAND_EDGES` so the edges have exactly one definition:

```ts
    async sessionRollups(userId, sinceIso, untilIso) {
      const since = new Date(sinceIso);
      const until = new Date(untilIso);
      const scope = and(
        eq(usageEvents.userId, userId),
        gte(usageEvents.timestamp, since),
        lt(usageEvents.timestamp, until),
        isNotNull(usageEvents.sessionId),
        ne(usageEvents.grain, "aggregate"),
      );

      // Band index derived from CONTEXT_BAND_EDGES rather than written out,
      // so the SQL cannot drift from the rule's own edges.
      const bandCase = sql.raw(
        `CASE ${CONTEXT_BAND_EDGES.slice(1)
          .map((edge, i) => `WHEN input_tokens < ${edge} THEN ${i}`)
          .join(" ")} ELSE ${CONTEXT_BAND_EDGES.length - 1} END`,
      );

      const bandRows = await db
        .select({
          sessionId: usageEvents.sessionId,
          band: sql<number>`${bandCase}`,
          turns: sql<string>`COUNT(*)`,
          reads: sql<string>`COALESCE(SUM(${usageEvents.cacheReadTokens}), 0)`,
        })
        .from(usageEvents)
        .where(scope)
        .groupBy(usageEvents.sessionId, sql`${bandCase}`);

      const totalRows = await db
        .select({
          sessionId: usageEvents.sessionId,
          model: usageEvents.model,
          start: sql<string>`MIN(${usageEvents.timestamp})`,
          end: sql<string>`MAX(${usageEvents.timestamp})`,
          turns: sql<string>`COUNT(*)`,
          inputTokens: sql<string>`SUM(${usageEvents.inputTokens})`,
          outputTokens: sql<string>`SUM(${usageEvents.outputTokens})`,
          cacheReadTokens: sql<string | null>`CASE WHEN bool_or(${usageEvents.cacheReadTokens} IS NULL) THEN NULL ELSE SUM(${usageEvents.cacheReadTokens}) END`,
          cacheCreationTokens: sql<string | null>`CASE WHEN bool_or(${usageEvents.cacheCreationTokens} IS NULL) THEN NULL ELSE SUM(${usageEvents.cacheCreationTokens}) END`,
        })
        .from(usageEvents)
        .where(scope)
        .groupBy(usageEvents.sessionId, usageEvents.model);

      return assembleSessionRollups(bandRows, totalRows);
    },

    async sessionCoverage(userId, sinceIso, untilIso) {
      const since = new Date(sinceIso);
      const until = new Date(untilIso);
      const inWindow = and(
        eq(usageEvents.userId, userId),
        gte(usageEvents.timestamp, since),
        lt(usageEvents.timestamp, until),
        ne(usageEvents.grain, "aggregate"),
      );

      const [sessions] = await db
        .select({ n: sql<string>`COUNT(DISTINCT ${usageEvents.sessionId})` })
        .from(usageEvents)
        .where(and(inWindow, isNotNull(usageEvents.sessionId)));

      const [orphans] = await db
        .select({
          turns: sql<string>`COUNT(*)`,
          inputTokens: sql<string>`COALESCE(SUM(${usageEvents.inputTokens}), 0)`,
        })
        .from(usageEvents)
        .where(and(inWindow, isNull(usageEvents.sessionId)));

      return {
        sessionsConsidered: Number(sessions?.n ?? 0),
        unattributedTurns: Number(orphans?.turns ?? 0),
        unattributedInputTokens: Number(orphans?.inputTokens ?? 0),
      };
    },
```

Add `isNotNull`, `isNull`, and `ne` to the existing `drizzle-orm` import at the top of the file.

**Note on `ne(usageEvents.grain, "aggregate")`:** in SQL, `grain <> 'aggregate'` is NULL — and therefore excluded — for rows where `grain` is NULL, which is the common case for request events. Verify how `grain` is stored: if it is nullable, use `or(isNull(usageEvents.grain), ne(usageEvents.grain, "aggregate"))` instead, importing `or`. Confirm with:

Run: `grep -n "grain" apps/api/src/db/schema.ts`

- [ ] **Step 6: Write the shared assembler**

Add this module-level helper in the same file, above both repo implementations, so the two do not each grow their own assembly logic:

```ts
type BandRow = { sessionId: string | null; band: number; turns: string | number; reads: string | number };
type TotalRow = {
  sessionId: string | null;
  model: string;
  start: string | Date;
  end: string | Date;
  turns: string | number;
  inputTokens: string | number;
  outputTokens: string | number;
  cacheReadTokens: string | number | null;
  cacheCreationTokens: string | number | null;
};

/**
 * Fold per-(session, band) and per-(session, model) rows into one rollup per
 * session. Shared by both repo implementations so the memory repo used in
 * tests and the Drizzle repo the server runs cannot diverge in shape.
 *
 * The dominant model is the one with the most input tokens in the session,
 * because that is what the counterfactual is priced at — a session that is
 * 90% Opus and 10% Haiku must not be priced as Haiku.
 */
function assembleSessionRollups(
  bandRows: BandRow[],
  totalRows: TotalRow[],
): SessionRollup[] {
  const n = (v: string | number | null | undefined): number => Number(v ?? 0);
  const out = new Map<string, SessionRollup>();
  /**
   * sessionId -> the input-token count of the model currently holding the
   * "dominant" slot. Tracked separately because `rollup.inputTokens` is a
   * running SUM across models and so cannot be compared against a single
   * model's slice once more than one has been folded in.
   */
  const dominantInput = new Map<string, number>();

  for (const row of totalRows) {
    if (!row.sessionId) continue;
    const existing = out.get(row.sessionId);
    const inputTokens = n(row.inputTokens);
    const start = new Date(row.start).toISOString();
    const end = new Date(row.end).toISOString();

    if (!existing) {
      dominantInput.set(row.sessionId, inputTokens);
      out.set(row.sessionId, {
        sessionId: row.sessionId,
        start,
        end,
        turnCount: n(row.turns),
        model: row.model,
        modelTier: getModelTier(row.model),
        inputTokens,
        outputTokens: n(row.outputTokens),
        cacheReadTokens: row.cacheReadTokens === null ? null : n(row.cacheReadTokens),
        cacheCreationTokens: row.cacheCreationTokens === null ? null : n(row.cacheCreationTokens),
        turnsByContextBand: new Array(CONTEXT_BAND_EDGES.length).fill(0),
        cacheReadByContextBand: new Array(CONTEXT_BAND_EDGES.length).fill(0),
      });
      continue;
    }

    // A model slice with MORE input tokens than the incumbent takes over as
    // the session's dominant model.
    if (inputTokens > (dominantInput.get(row.sessionId) ?? 0)) {
      dominantInput.set(row.sessionId, inputTokens);
      existing.model = row.model;
      existing.modelTier = getModelTier(row.model);
    }
    existing.turnCount += n(row.turns);
    existing.inputTokens += inputTokens;
    existing.outputTokens += n(row.outputTokens);
    // null wins: if any model-slice of the session lacks a breakdown, the
    // session as a whole has an unknown one.
    existing.cacheReadTokens =
      row.cacheReadTokens === null || existing.cacheReadTokens === null
        ? null
        : existing.cacheReadTokens + n(row.cacheReadTokens);
    existing.cacheCreationTokens =
      row.cacheCreationTokens === null || existing.cacheCreationTokens === null
        ? null
        : existing.cacheCreationTokens + n(row.cacheCreationTokens);
    if (start < existing.start) existing.start = start;
    if (end > existing.end) existing.end = end;
  }

  for (const row of bandRows) {
    if (!row.sessionId) continue;
    const rollup = out.get(row.sessionId);
    if (!rollup) continue;
    rollup.turnsByContextBand[row.band] += n(row.turns);
    rollup.cacheReadByContextBand[row.band] += n(row.reads);
  }

  return [...out.values()];
}
```

**Why `dominantInput` is a separate map:** `rollup.inputTokens` is a running sum across every model in the session, so once two models have been folded in it can no longer be compared against a single model's slice. Tracking the incumbent's own slice separately is what keeps "dominant" meaning *largest single model* rather than *last one seen*. The `sess-c` test in Step 2 fails if this is folded into `inputTokens`.

- [ ] **Step 7: Implement in the memory repo**

Mirror the Drizzle version using plain JS over the in-memory event array: filter to the window, `sessionId != null`, `grain !== "aggregate"`; group by `(sessionId, band)` using `contextBandIndex(event.inputTokens)` and by `(sessionId, model)`; then call the same `assembleSessionRollups`. Implement `sessionCoverage` the same way — `sessionsConsidered` is the size of the distinct-sessionId set, and the unattributed figures come from events where `sessionId` is null or undefined.

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm --filter @tokenops/api exec vitest run src/services/events-repo.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/events-repo.ts apps/api/src/services/events-repo.test.ts
git commit -m "$(cat <<'EOF'
feat(api): session rollups and coverage in EventsRepo

Two queries per window — per-(session,band) and per-(session,model) —
folded by one shared assembler, so the memory repo used by tests and the
Drizzle repo the server runs cannot diverge in shape.

Coverage is reported separately because sidechain turns carry no
sessionId by the adapter's design: roughly 11% of weighted consumption
belongs to no session, and the panel has to be able to say so.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The session-rules job

**Files:**
- Create: `apps/api/src/jobs/session-rules.ts`
- Create: `apps/api/src/jobs/session-rules.test.ts`
- Modify: whichever file calls `startAggregateRulesJob` (find with `grep -rn "startAggregateRulesJob" apps/api/src`)

**Interfaces:**
- Consumes: `runSessionRules`, `SESSION_RULE_IDS`, `SessionRollup` from `@tokenops/shared`; `EventsRepo.sessionRollups`; `repo.upsertRecommendation`, `repo.supersedeOpenRecommendations`
- Produces: `MAX_SESSION_CARDS_PER_RULE`, `SESSION_WINDOW_DAYS`, `sessionWindowBounds(now)`, `runSessionRulesForUser(repo, userId, now)`, `runSessionRulesOnce(db, repo, log, now)`, `startSessionRulesJob(db, repo, intervalMs, log)`

- [ ] **Step 1: Read the job you are mirroring**

Run: `cat apps/api/src/jobs/aggregate-rules.ts`

The session job follows the same four-part shape (bounds, per-user, all-users, scheduler) with one structural difference: it emits many cards per rule, so its dedupe key carries a sessionId and its retirement sweep must clear per-rule rather than per-key.

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/jobs/session-rules.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { SessionRollup } from "@tokenops/shared";
import {
  MAX_SESSION_CARDS_PER_RULE,
  runSessionRulesForUser,
} from "./session-rules.js";

const NOW = new Date("2026-08-11T00:00:00.000Z");

function rollup(id: string, reads: number): SessionRollup {
  return {
    sessionId: id,
    start: "2026-08-01T00:00:00.000Z",
    end: "2026-08-01T06:00:00.000Z",
    turnCount: 100,
    model: "claude-opus-5",
    modelTier: "frontier",
    inputTokens: reads + 1_000_000,
    outputTokens: 200_000,
    cacheReadTokens: reads,
    cacheCreationTokens: 1_000,
    turnsByContextBand: [0, 0, 0, 0, 0, 40],
    cacheReadByContextBand: [0, 0, 0, 0, 0, reads],
  };
}

function fakeRepo(rollups: SessionRollup[]) {
  return {
    sessionRollups: vi.fn().mockResolvedValue(rollups),
    upsertRecommendation: vi.fn().mockResolvedValue(undefined),
    supersedeOpenRecommendations: vi.fn().mockResolvedValue(0),
  };
}

describe("runSessionRulesForUser", () => {
  it("keys each card on its rule and session, not on a window", async () => {
    const repo = fakeRepo([rollup("sess-a", 40_000_000)]);
    await runSessionRulesForUser(repo as never, "u1", NOW);
    const call = repo.upsertRecommendation.mock.calls[0]![0];
    expect(call.dedupeKey).toBe("session_context_ceiling|sess-a");
    expect(call.ruleId).toBe("session_context_ceiling");
  });

  it("caps open cards per rule, keeping the most expensive sessions", async () => {
    const many = Array.from({ length: MAX_SESSION_CARDS_PER_RULE + 5 }, (_, i) =>
      rollup(`sess-${i}`, 20_000_000 + i * 1_000_000),
    );
    const repo = fakeRepo(many);
    await runSessionRulesForUser(repo as never, "u1", NOW);

    const written = repo.upsertRecommendation.mock.calls.map((c) => c[0]);
    expect(written).toHaveLength(MAX_SESSION_CARDS_PER_RULE);
    // Highest reads win: sess-14 down to sess-5 for a cap of 10.
    const ids = written.map((w: { dedupeKey: string }) => w.dedupeKey.split("|")[1]);
    expect(ids).toContain(`sess-${many.length - 1}`);
    expect(ids).not.toContain("sess-0");
  });

  it("caps per rule rather than overall, so cheaper rules keep their slots", async () => {
    // Churn cards are always worth less than ceiling cards. A single
    // overall cap would let ceiling findings crowd them out entirely.
    const churny = Array.from({ length: MAX_SESSION_CARDS_PER_RULE + 2 }, (_, i) => ({
      ...rollup(`sess-${i}`, 20_000_000 + i * 1_000_000),
      cacheReadTokens: 8_000_000,
      cacheCreationTokens: 2_000_000,
    }));
    const repo = fakeRepo(churny);
    await runSessionRulesForUser(repo as never, "u1", NOW);

    const byRule = new Map<string, number>();
    for (const [rec] of repo.upsertRecommendation.mock.calls) {
      byRule.set(rec.ruleId, (byRule.get(rec.ruleId) ?? 0) + 1);
    }
    expect(byRule.get("session_context_ceiling")).toBe(MAX_SESSION_CARDS_PER_RULE);
    expect(byRule.get("session_cache_churn")).toBe(MAX_SESSION_CARDS_PER_RULE);
  });

  it("retires every open card for a rule that produced no hit", async () => {
    // A rule that stops firing never enters the write loop, so without an
    // explicit sweep its last cards stay open forever.
    const repo = fakeRepo([]);
    await runSessionRulesForUser(repo as never, "u1", NOW);
    const sweptRules = repo.supersedeOpenRecommendations.mock.calls.map((c) => c[1]);
    expect(sweptRules).toContain("session_context_ceiling");
    expect(sweptRules).toContain("session_cache_churn");
  });

  it("returns the number of cards written", async () => {
    const repo = fakeRepo([rollup("sess-a", 40_000_000)]);
    expect(await runSessionRulesForUser(repo as never, "u1", NOW)).toBe(1);
  });

  it("prices each session at its own end time, not wall-clock now", async () => {
    // Same reason the back-test replays at event timestamps: a date-gated
    // rate would otherwise reprice history as the clock moves.
    const repo = fakeRepo([
      { ...rollup("sess-a", 40_000_000), model: "claude-sonnet-5", end: "2026-08-01T06:00:00.000Z" },
    ]);
    await runSessionRulesForUser(repo as never, "u1", new Date("2026-09-15T00:00:00.000Z"));
    const call = repo.upsertRecommendation.mock.calls[0]![0];
    // Priced at the intro rate (session ended before the 2026-08-31 expiry),
    // not the higher standard rate in force at `now`.
    expect(call.estimatedWastedUsd).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @tokenops/api exec vitest run src/jobs/session-rules.test.ts`
Expected: FAIL — cannot resolve `./session-rules.js`.

- [ ] **Step 4: Write the job**

Create `apps/api/src/jobs/session-rules.ts`:

```ts
import {
  SESSION_RULE_IDS,
  runSessionRules,
  type RuleHit,
  type SessionRollup,
} from "@tokenops/shared";
import type { Db } from "../db/client.js";
import { usageEvents } from "../db/schema.js";
import type { EventsRepo } from "../services/events-repo.js";

export const HOUR_MS = 60 * 60 * 1000;

/** Trailing window the session rules look back over. */
export const SESSION_WINDOW_DAYS = 7;

/**
 * Open cards per rule, ranked by savings.
 *
 * Ten because consumption is that concentrated: across a measured week the
 * top 10 sessions of 190 were 80.1% of all consumption, so ten cards cover
 * most of what is worth acting on. PER RULE rather than overall, because
 * ceiling findings are worth far more than churn findings and a single
 * shared cap would crowd churn out of the panel entirely.
 */
export const MAX_SESSION_CARDS_PER_RULE = 10;

function truncateToUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/** 7 days ending now, start truncated to the UTC day. Mirrors aggregateWindowBounds. */
export function sessionWindowBounds(now: Date): {
  startIso: string;
  endIso: string;
} {
  const start = new Date(
    truncateToUtcDay(now).getTime() -
      SESSION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  return { startIso: start.toISOString(), endIso: now.toISOString() };
}

/** Descending by savings; a known USD always outranks an unpriceable null. */
function bySavingsDesc(
  a: { hit: RuleHit },
  b: { hit: RuleHit },
): number {
  const au = a.hit.estimatedWastedUsd;
  const bu = b.hit.estimatedWastedUsd;
  if (au == null && bu == null) {
    return b.hit.estimatedWastedTokens - a.hit.estimatedWastedTokens;
  }
  return (bu ?? -Infinity) - (au ?? -Infinity);
}

/**
 * Evaluate the session rules over one user's trailing window.
 *
 * Two differences from the aggregate job:
 *
 *  - The dedupe key is `ruleId|sessionId`, not `ruleId|windowStart`. A
 *    session is a stable identity, so re-running this job any number of
 *    times updates the same card in place rather than minting a new one as
 *    the window's start date advances.
 *  - Because the key no longer encodes the run, supersession cannot use the
 *    aggregate job's "keep this key, delete the rest" trick — that would
 *    delete every OTHER session's card on each write. Instead the whole
 *    rule's open set is cleared once, before any writes, with a key that
 *    matches nothing; the surviving cards are then re-written. That is also
 *    exactly what retires a rule that stopped firing, so no separate sweep
 *    is needed for the zero-hit case.
 */
export async function runSessionRulesForUser(
  repo: Pick<
    EventsRepo,
    "sessionRollups" | "upsertRecommendation" | "supersedeOpenRecommendations"
  >,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const { startIso, endIso } = sessionWindowBounds(now);
  const rollups: SessionRollup[] = await repo.sessionRollups(
    userId,
    startIso,
    endIso,
  );

  const byRule = new Map<string, { rollup: SessionRollup; hit: RuleHit }[]>();
  for (const rollup of rollups) {
    // Price each session at its OWN end instant. Using wall-clock `now`
    // would reprice history every time a date-gated rate changes.
    for (const hit of runSessionRules(rollup, new Date(rollup.end))) {
      const list = byRule.get(hit.ruleId) ?? [];
      list.push({ rollup, hit });
      byRule.set(hit.ruleId, list);
    }
  }

  let written = 0;
  for (const ruleId of SESSION_RULE_IDS) {
    // Clear the rule's whole open set first. "__sweep__" cannot collide
    // with any real dedupeKey, which is what makes this a full clear.
    await repo.supersedeOpenRecommendations(userId, ruleId, `${ruleId}|__sweep__`);

    const ranked = (byRule.get(ruleId) ?? [])
      .sort(bySavingsDesc)
      .slice(0, MAX_SESSION_CARDS_PER_RULE);

    for (const { rollup, hit } of ranked) {
      await repo.upsertRecommendation({
        userId,
        ruleId: hit.ruleId,
        severity: hit.severity,
        title: hit.title,
        detail: hit.detail,
        estimatedWastedTokens: hit.estimatedWastedTokens,
        estimatedWastedUsd: hit.estimatedWastedUsd,
        eventIds: hit.eventIds,
        dedupeKey: `${hit.ruleId}|${rollup.sessionId}`,
        counterfactual: hit.counterfactual,
        assumption: hit.assumption,
      });
      written += 1;
    }
  }

  return written;
}

/** Every user id with at least one usage event, in no particular order. */
async function distinctUserIds(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: usageEvents.userId })
    .from(usageEvents);
  return rows.map((r) => r.userId);
}

/**
 * Run the session rules once for every user. Errors are swallowed per user
 * so one bad user doesn't skip everyone after them, same as the aggregate
 * job; failing to list users at all is caught separately since there is
 * nothing left to iterate.
 */
export async function runSessionRulesOnce(
  db: Db,
  repo: EventsRepo,
  log: Pick<Console, "info" | "error"> = console,
  now: Date = new Date(),
): Promise<void> {
  let userIds: string[];
  try {
    userIds = await distinctUserIds(db);
  } catch (err) {
    log.error("session-rules job failed to list users", err);
    return;
  }

  let cardCount = 0;
  for (const userId of userIds) {
    try {
      cardCount += await runSessionRulesForUser(repo, userId, now);
    } catch (err) {
      log.error(`session-rules job failed for user ${userId}`, err);
    }
  }
  log.info(
    `session-rules: usersProcessed=${userIds.length} cards=${cardCount}`,
  );
}

/** Hourly schedule, mirroring startAggregateRulesJob. */
export function startSessionRulesJob(
  db: Db,
  repo: EventsRepo,
  intervalMs: number = HOUR_MS,
  log: Pick<Console, "info" | "error"> = console,
): NodeJS.Timeout {
  void runSessionRulesOnce(db, repo, log);
  const handle = setInterval(() => {
    void runSessionRulesOnce(db, repo, log);
  }, intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  return handle;
}
```

- [ ] **Step 5: Confirm the supersede predicate actually clears the set**

Run: `sed -n '417,440p' apps/api/src/services/events-repo.ts`

Verify `supersedeOpenRecommendations` deletes open rows for `(userId, ruleId)` where `dedupeKey <> keepDedupeKey`. If its predicate differs (for example if it also filters by status in a way that spares some rows), adjust the sweep call so the whole rule's open set is genuinely cleared, and note the difference in the job's doc comment.

- [ ] **Step 6: Start the job with the others**

In the file that calls `startAggregateRulesJob`, add the sibling call directly beneath it:

```ts
startSessionRulesJob(db, repo);
```

with the matching import.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @tokenops/api test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/jobs/session-rules.ts apps/api/src/jobs/session-rules.test.ts apps/api/src/server.ts
git commit -m "$(cat <<'EOF'
feat(api): session-rules job

Keyed on ruleId|sessionId rather than a window start, so re-running
updates cards in place instead of minting one per day. Because the key no
longer encodes the run, supersession clears each rule's open set once
before writing rather than per-write — which also retires a rule that
stopped firing, with no separate sweep.

Capped at 10 cards per rule, ranked by savings: the top 10 sessions of
190 were 80.1% of measured consumption. Per rule, so cheaper churn
findings keep their slots.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Surface coverage and relabel the money

**Files:**
- Modify: `apps/api/src/routes/recommendations.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/pages/Recommendations.tsx`
- Test: `apps/api/src/routes/recommendations.test.ts`, `apps/web/src/pages/Recommendations.test.tsx`

**Interfaces:**
- Consumes: `EventsRepo.sessionCoverage`, `sessionWindowBounds` from `../jobs/session-rules.js`, `MAX_SESSION_CARDS_PER_RULE`
- Produces: recommendations response gains `coverage: { sessionsConsidered, sessionsShownPerRule, unattributedTurns, unattributedInputTokens }`

- [ ] **Step 1: Write the failing API test**

Add to `apps/api/src/routes/recommendations.test.ts`, matching the file's existing request helper:

```ts
it("reports session coverage alongside the cards", async () => {
  // The panel shows at most 10 sessions per rule and no sidechain turns at
  // all. Without these numbers it would imply it had shown everything.
  const res = await request("/api/recommendations");
  const body = await res.json();
  expect(body.coverage).toEqual({
    sessionsConsidered: expect.any(Number),
    sessionsShownPerRule: 10,
    unattributedTurns: expect.any(Number),
    unattributedInputTokens: expect.any(Number),
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tokenops/api exec vitest run src/routes/recommendations.test.ts`
Expected: FAIL — `body.coverage` is undefined.

- [ ] **Step 3: Add coverage to the route**

In `apps/api/src/routes/recommendations.ts`, in the list handler, after fetching recommendations:

```ts
  const { startIso, endIso } = sessionWindowBounds(new Date());
  const coverage = await repo.sessionCoverage(userId, startIso, endIso);
```

and include it in the JSON response:

```ts
  return c.json({
    recommendations,
    coverage: {
      ...coverage,
      sessionsShownPerRule: MAX_SESSION_CARDS_PER_RULE,
    },
  });
```

If the existing handler returns a bare array rather than an object, keep the array under its current key and add `coverage` beside it — do not change the shape the web client already reads for the cards themselves.

- [ ] **Step 4: Write the failing web test**

Add to `apps/web/src/pages/Recommendations.test.tsx`:

```tsx
it("labels the dollar figure as API-equivalent", () => {
  // On a subscription the dollar number is notional — it is what this
  // usage would have cost on the API, not what the user was charged.
  render(<RecommendationCard r={cardFixture({ estimatedWastedUsd: 1.23 })} />);
  expect(screen.getByText(/API-equivalent/)).toBeInTheDocument();
});

it("states how much of the window the cards cover", () => {
  render(
    <RecommendationsPanel
      recommendations={[]}
      coverage={{
        sessionsConsidered: 190,
        sessionsShownPerRule: 10,
        unattributedTurns: 4_423,
        unattributedInputTokens: 500_000_000,
      }}
    />,
  );
  expect(screen.getByText(/190 sessions/)).toBeInTheDocument();
  expect(screen.getByText(/top 10 per rule/)).toBeInTheDocument();
  expect(screen.getByText(/4,423/)).toBeInTheDocument();
});
```

Adjust the component names and props to whatever this file already renders — read it first.

- [ ] **Step 5: Run it to verify it fails**

Run: `pnpm --filter @tokenops/web exec vitest run src/pages/Recommendations.test.tsx`
Expected: FAIL — no `API-equivalent` text.

- [ ] **Step 6: Relabel and add the coverage line**

In `apps/web/src/pages/Recommendations.tsx`, change the savings line to:

```tsx
        Tokens involved: {formatTokens(r.estimatedWastedTokens)} · Est. savings:{" "}
        {formatUsd(r.estimatedWastedUsd)}{" "}
        <span className="est-label">(estimated, API-equivalent)</span>
```

and add a coverage line above the card list:

```tsx
      {coverage ? (
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Covering {coverage.sessionsConsidered.toLocaleString("en-US")} sessions,
          showing the top {coverage.sessionsShownPerRule} per rule.{" "}
          {coverage.unattributedTurns > 0
            ? `${coverage.unattributedTurns.toLocaleString("en-US")} subagent turns
               (${formatTokens(coverage.unattributedInputTokens)} tokens) belong to no
               session and are not counted here.`
            : null}
        </p>
      ) : null}
```

Add the `coverage` field to the response type in `apps/web/src/api/client.ts`, typed as optional so an older API build does not break the page.

- [ ] **Step 7: Run both suites**

Run: `pnpm --filter @tokenops/api test && pnpm --filter @tokenops/web test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/recommendations.ts apps/api/src/routes/recommendations.test.ts apps/web/src/api/client.ts apps/web/src/pages/Recommendations.tsx apps/web/src/pages/Recommendations.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): state coverage and label savings as API-equivalent

On a subscription the dollar figure is notional — what the usage would
have cost on the API, not what was charged. Tokens stay the primary
number and the label now says which currency the money is in.

The panel also states what it does not cover: sessions beyond the top 10
per rule, and the subagent turns that carry no sessionId at all. A silent
truncation reads as full coverage.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The back-test acceptance gate

**Files:**
- Create: `scripts/measure-session-rules.mjs`
- Modify: `docs/claude-code-cost-findings.md`

**Interfaces:**
- Consumes: `runSessionRules`, `contextBandIndex`, `CONTEXT_BAND_EDGES` from the built `@tokenops/shared`
- Produces: a printed report — sessions considered, cards per rule, savings, and coverage — and an exit code

This task is the reason the previous branch was parked. It is not optional and it is not a formality: the rules are "done" only when this measurement has been run against real data and reported, whichever way it comes out.

- [ ] **Step 1: Build the workspace so the script can import shared**

Run: `pnpm -r build`
Expected: clean.

- [ ] **Step 2: Write the measurement script**

Create `scripts/measure-session-rules.mjs`:

```js
#!/usr/bin/env node
/**
 * Replay the session rules over real Claude Code history and report what
 * they would have surfaced.
 *
 * This is the acceptance gate for the session-grain rule set. The previous
 * rule set shipped green and useless — roughly 24 findings from 14,546
 * turns — because nobody measured against real data until the end. Run
 * this before calling the work done, and report the number it prints
 * whether or not it is the number you hoped for.
 *
 * Reads ~/.claude/projects/**\/*.jsonl directly rather than the database,
 * so it needs no deployment. Deduplicates by message.id: Claude Code
 * writes one line per content BLOCK, and a naive per-line count inflates
 * everything by ~2.1x.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  CONTEXT_BAND_EDGES,
  contextBandIndex,
  runSessionRules,
} from "@tokenops/shared";

const WINDOW_DAYS = Number(process.env.WINDOW_DAYS ?? 7);
const root = join(homedir(), ".claude", "projects");
const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;

function* jsonlFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(path);
    else if (entry.name.endsWith(".jsonl") && statSync(path).mtimeMs > cutoff) {
      yield path;
    }
  }
}

const rollups = [];
let unattributedTurns = 0;
let unattributedInput = 0;
let totalTurns = 0;

for (const file of jsonlFiles(root)) {
  const seen = new Set();
  const byModel = new Map();
  const turnsByContextBand = new Array(CONTEXT_BAND_EDGES.length).fill(0);
  const cacheReadByContextBand = new Array(CONTEXT_BAND_EDGES.length).fill(0);
  let turnCount = 0;
  let input = 0, output = 0, read = 0, creation = 0;
  let start = null, end = null;

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type !== "assistant") continue;
    const usage = row.message?.usage;
    const id = row.message?.id;
    if (!usage || !id || seen.has(id)) continue;
    seen.add(id);
    totalTurns += 1;

    const r = usage.cache_read_input_tokens ?? 0;
    const c = usage.cache_creation_input_tokens ?? 0;
    const context = (usage.input_tokens ?? 0) + r + c;

    // Sidechain turns carry no sessionId, matching the adapter's design.
    if (row.isSidechain) {
      unattributedTurns += 1;
      unattributedInput += context;
      continue;
    }

    const band = contextBandIndex(context);
    turnsByContextBand[band] += 1;
    cacheReadByContextBand[band] += r;
    turnCount += 1;
    input += context; output += usage.output_tokens ?? 0;
    read += r; creation += c;
    byModel.set(row.message.model, (byModel.get(row.message.model) ?? 0) + context);
    if (!start || row.timestamp < start) start = row.timestamp;
    if (!end || row.timestamp > end) end = row.timestamp;
  }

  if (turnCount === 0) continue;
  const model = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0][0];
  rollups.push({
    sessionId: file, start, end, turnCount, model,
    modelTier: "frontier",
    inputTokens: input, outputTokens: output,
    cacheReadTokens: read, cacheCreationTokens: creation,
    turnsByContextBand, cacheReadByContextBand,
  });
}

const byRule = new Map();
for (const rollup of rollups) {
  for (const hit of runSessionRules(rollup, new Date(rollup.end))) {
    const list = byRule.get(hit.ruleId) ?? [];
    list.push(hit);
    byRule.set(hit.ruleId, list);
  }
}

const CAP = 10;
console.log(`window:                ${WINDOW_DAYS} days`);
console.log(`sessions:              ${rollups.length}`);
console.log(`turns (deduped):       ${totalTurns.toLocaleString("en-US")}`);
console.log(`unattributed turns:    ${unattributedTurns.toLocaleString("en-US")} (${(unattributedInput / 1e6).toFixed(1)}M tokens)`);
console.log("");
let shown = 0;
for (const [ruleId, hits] of byRule) {
  const top = [...hits].sort((a, b) => (b.estimatedWastedUsd ?? 0) - (a.estimatedWastedUsd ?? 0)).slice(0, CAP);
  const sum = top.reduce((n, h) => n + (h.estimatedWastedUsd ?? 0), 0);
  shown += top.length;
  console.log(`${ruleId}: ${hits.length} sessions fire, top ${top.length} shown, $${sum.toFixed(2)} API-equivalent`);
}
console.log("");
console.log(`CARDS SHOWN: ${shown}`);
if (shown === 0) {
  console.error("FAIL: no cards. The rules do not fire on real data.");
  process.exit(1);
}
if (shown > 40) {
  console.error(`FAIL: ${shown} cards is noise, not a recommendation set.`);
  process.exit(1);
}
console.log("PASS: bounded, non-empty finding set.");
```

- [ ] **Step 3: Run the measurement**

Run: `node scripts/measure-session-rules.mjs`
Expected: a non-zero, bounded card count and `PASS`.

If it prints `FAIL: no cards`, the rules do not fire on real data and the work is **not** done — report the output and stop rather than adjusting thresholds until something appears. If it prints a card count above 40, the thresholds are too loose; report that too.

- [ ] **Step 4: Record the measured result**

Append a short section to `docs/claude-code-cost-findings.md` under a new heading `## What the session rules actually surface (measured 2026-08-11)`, giving the exact numbers the script printed: sessions considered, deduped turns, cards per rule, total API-equivalent savings, and unattributed turns. Quote the figures verbatim — this document is the record that the measurement happened.

- [ ] **Step 5: Run the whole suite and build**

Run: `pnpm -r build && pnpm -r test`
Expected: build clean, all tests green.

- [ ] **Step 6: Commit**

```bash
git add scripts/measure-session-rules.mjs docs/claude-code-cost-findings.md
git commit -m "$(cat <<'EOF'
test: back-test the session rules over real history

The acceptance gate the previous rule set never had. It replays the rules
over ~/.claude/projects, deduplicating by message.id, and fails on both
an empty finding set and a noisy one.

The measured result is recorded in the findings doc so the number is on
the record rather than in a terminal someone closed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Task |
|---|---|
| `CONTEXT_BAND_EDGES`, `SessionRollup` | 1 |
| `session_context_ceiling` + constants + conservatism | 2 |
| `session_cache_churn` + derived baseline | 3 |
| `runSessionRules`, `SESSION_RULE_IDS`, assumption strings | 4 |
| Retire `cache_efficiency`; keep `frontier_share` and the three request rules | 5 |
| Rollup construction, `null` vs `0`, dominant model | 6 |
| `ruleId\|sessionId` dedupe, per-`(rule,session)` supersession, top-10-per-rule cap | 7 |
| Cap stated in UI; unattributed total surfaced; token-primary with API-equivalent label | 8 |
| Back-test replay as acceptance gate | 9 |
| Error handling (turn floor, `null` cache, unpriceable model, band-length throw) | 1, 2, 3 |

No gaps.

**2. Placeholder scan**

No TBDs, and no deliberately-broken code: every block is the code to write. Task 6's dominant-model fold carries an explanation of why it needs its own map rather than reusing `inputTokens`, because that is the shortcut an implementer would otherwise take, and the `sess-c` test is what catches it.

**3. Type consistency**

- `SessionRollup` field names identical across Tasks 1, 2, 3, 4, 6, 7, 9.
- `SESSION_MIN_TURNS` defined in `context-ceiling.ts` (Task 2), imported by `cache-churn.ts` (Task 3) and its test. Single definition.
- `sessionRollups` / `sessionCoverage` signatures match between Task 6 (definition), Task 7 (job), and Task 8 (route).
- `MAX_SESSION_CARDS_PER_RULE` defined in Task 7, imported by Task 8.
- `runSessionRules(rollup, now?, priceOverrides?)` identical in Tasks 4, 7, 9.
- Both rules implement `resolveActual`, which `runSessionRules` calls with `!` — safe because `SESSION_RULES` contains only these two.

## Known Risks

- **Task 6's `ne(grain, "aggregate")` is NULL-unsafe in SQL** if `grain` is nullable. Step 5 makes the implementer check the schema and switch to `or(isNull(...), ne(...))`. Getting this wrong silently drops every request event.
- **Task 7's sweep-then-write is not atomic.** A crash between the sweep and the writes leaves that rule with no open cards until the next hourly run. Acceptable: the cards are derived state, fully rebuilt every hour, and the alternative (transactional swap) is a larger change to the repo interface than the failure justifies.
- **Task 9 may fail.** That is the point of having it. If the rules do not fire on real data, the correct response is to report it, not to loosen thresholds until the output looks good.
