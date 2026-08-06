# Recommendation Credibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make TokenOps' five efficiency rules produce defensible dollar figures by having each rule declare a counterfactual that one shared pricer converts to savings, then rank findings by that number and back-test the rules over history.

**Architecture:** Rules stop computing money. Each returns a `RuleFinding` carrying a `Counterfactual` — the model and token counts the call would have used had the advice been followed. A single `priceCounterfactual()` estimates both sides through the existing `estimateCostUsd` and subtracts. The runners (`runRules`, `runAggregateRules`) own pricing, materiality, and severity. A back-test replays the current rules over stored history, pricing each event at its own timestamp.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod, Vitest, Hono, Drizzle ORM + Postgres, React + Vite, pnpm workspaces.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-05-recommendation-credibility-design.md`. Read it before Task 1.
- **Branch:** `docs/recs-credibility-spec` (already checked out, spec already committed).
- **Never mix a measured cost with an estimated one across a subtraction.** `priceCounterfactual` estimates *both* sides. It must never read `event.costUsd` or `ModelWindowTotals.costUsd`. This is the bug `frontier_share` fixed by hand in `6e90aab`; the shared pricer makes it structurally impossible.
- **`cacheReadTokens` / `cacheCreationTokens` are `number | null`.** `null` = no breakdown recorded; `0` = recorded and genuinely zero. Never default `null` to `0` in rule logic. (`estimateCostUsd` does coerce `null` → `0` internally, meaning "no discount known, charge full rate" — that is correct and unchanged.)
- **Money in the UI stays labeled "estimated".** A counterfactual is a model, not a measurement.
- **No new rules.** Five rules exist; five rules remain.
- **ESM imports use explicit `.js` extensions**, matching every existing file in `packages/shared/src`.
- **Test command:** `pnpm --filter @tokenops/shared test` (shared), `pnpm --filter @tokenops/api test` (api). Single file: `pnpm --filter @tokenops/shared exec vitest run <path>`.

## File Structure

**Create — `packages/shared/src/rules/`**
| File | Responsibility |
|---|---|
| `counterfactual.ts` | `Counterfactual`, `Actual`, `PricedSavings`, `priceCounterfactual()`. The only place savings arithmetic lives. |
| `counterfactual.test.ts` | Pricer unit tests, incl. the both-sides-estimated invariant. |
| `contract.ts` | `Severity`, `Rule`, `RuleFinding`, `RuleContext`. The published contract. |
| `backtest.ts` | `backtest()` — replays rules over history, prices each event at its own timestamp. |
| `backtest.test.ts` | Determinism, Sonnet 5 cutoff, grain routing. |

**Create — docs**
| File | Responsibility |
|---|---|
| `docs/rules/authoring.md` | The contract, a worked example, the fixture harness, stability guarantees. |

**Modify**
| File | Change |
|---|---|
| `packages/shared/src/rules/types.ts` | Extract `Severity`; keep `RuleHit` as runner output. |
| `packages/shared/src/rules/frontier-trivial.ts` | Return `RuleFinding`, declare counterfactual. |
| `packages/shared/src/rules/full-document-io.ts` | Same, plus `assumption`. |
| `packages/shared/src/rules/context-bloat.ts` | Same, plus `assumption`. |
| `packages/shared/src/rules/aggregate/cache-efficiency.ts` | Same. Gains USD. Delete the stale "no cache price" comment. |
| `packages/shared/src/rules/aggregate/frontier-share.ts` | Same. Delete its hand-rolled both-sides pricing. |
| `packages/shared/src/rules/index.ts` | `runRules` prices findings into hits. |
| `packages/shared/src/rules/aggregate/index.ts` | `runAggregateRules` prices findings into hits. |
| `packages/shared/src/index.ts` | Export the new public surface. |
| `apps/api/src/db/schema.ts` | Add `counterfactual jsonb` to `recommendations`. |
| `apps/api/drizzle/000N_*.sql` | Generated migration. |
| `apps/api/src/services/events-repo.ts` | `RecommendationInsert.counterfactual`; order `listRecommendations` by savings. |
| `apps/api/src/services/rules-runner.ts` | Persist counterfactual. |
| `apps/api/src/jobs/aggregate-rules.ts` | Persist counterfactual. |
| `apps/api/src/routes/recommendations.ts` | `GET /backtest`; DTO gains `counterfactual` + `assumption`. |
| `apps/web/src/api/client.ts` | DTO types. |
| `apps/web/src/pages/Recommendations.tsx` | Render assumption + counterfactual evidence. |

---

### Task 1: Counterfactual type and shared pricer

**Files:**
- Create: `packages/shared/src/rules/counterfactual.ts`
- Test: `packages/shared/src/rules/counterfactual.test.ts`

**Interfaces:**
- Consumes: `estimateCostUsd`, `PriceRow` from `../pricing.js`.
- Produces: `Counterfactual`, `Actual`, `PricedSavings`, `PricingContext`, `priceCounterfactual(actual, counterfactual, ctx): PricedSavings`. Every rule in Tasks 3–6 and the back-test in Task 7 depend on these exact names.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/rules/counterfactual.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { priceCounterfactual } from "./counterfactual.js";
import type { Actual, Counterfactual } from "./counterfactual.js";

const NOW = new Date("2026-09-15T00:00:00Z"); // after the Sonnet 5 intro expiry

const actual = (over: Partial<Actual> = {}): Actual => ({
  model: "claude-opus-5",
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  ...over,
});

const cf = (over: Partial<Counterfactual> = {}): Counterfactual => ({
  model: "claude-opus-5",
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  ...over,
});

describe("priceCounterfactual", () => {
  it("prices a model swap as the rate difference", () => {
    // opus-5 in = $5/MTok, sonnet-5 standard in = $3/MTok -> $2 on 1M tokens
    const res = priceCounterfactual(
      actual(),
      cf({ model: "claude-sonnet-5" }),
      { now: NOW },
    );
    expect(res.estimatedWastedUsd).toBeCloseTo(2, 6);
  });

  it("prices a cache-reuse counterfactual through the read multiplier", () => {
    // 1M input at full $5 = $5. Counterfactual: half served from cache at
    // 0.1x -> 500k * $5 + 500k * $5 * 0.1 = $2.50 + $0.25 = $2.75. Saves $2.25.
    const res = priceCounterfactual(
      actual({ cacheReadTokens: 0, cacheCreationTokens: 0 }),
      cf({ cacheReadTokens: 500_000, cacheCreationTokens: 0 }),
      { now: NOW },
    );
    expect(res.estimatedWastedUsd).toBeCloseTo(2.25, 6);
  });

  it("returns null savings when either side cannot be priced", () => {
    const res = priceCounterfactual(
      actual({ model: "some-unknown-model" }),
      cf({ model: "some-unknown-model" }),
      { now: NOW },
    );
    expect(res.estimatedWastedUsd).toBeNull();
  });

  it("never returns negative savings", () => {
    const res = priceCounterfactual(
      actual({ model: "claude-sonnet-5" }),
      cf({ model: "claude-opus-5" }), // "counterfactual" is more expensive
      { now: NOW },
    );
    expect(res.estimatedWastedUsd).toBe(0);
  });

  it("prices both sides at the same instant across the Sonnet 5 cutoff", () => {
    const during = new Date("2026-08-15T00:00:00Z"); // intro active: $2/MTok
    const after = new Date("2026-09-15T00:00:00Z"); // standard: $3/MTok
    const swap = () => cf({ model: "claude-sonnet-5" });
    const a = priceCounterfactual(actual(), swap(), { now: during });
    const b = priceCounterfactual(actual(), swap(), { now: after });
    expect(a.estimatedWastedUsd).toBeCloseTo(3, 6); // $5 - $2
    expect(b.estimatedWastedUsd).toBeCloseTo(2, 6); // $5 - $3
  });

  it("passes implicated tokens through unchanged", () => {
    const res = priceCounterfactual(actual(), cf(), {
      now: NOW,
      implicatedTokens: 4321,
    });
    expect(res.estimatedWastedTokens).toBe(4321);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tokenops/shared exec vitest run src/rules/counterfactual.test.ts`
Expected: FAIL — `Failed to resolve import "./counterfactual.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/rules/counterfactual.ts`:

```ts
import { estimateCostUsd, type PriceRow } from "../pricing.js";

/**
 * What a request or window would have looked like had a rule's advice been
 * followed. `model` equals the actual model when the advice concerns tokens
 * rather than routing.
 *
 * cacheReadTokens/cacheCreationTokens keep the `number | null` semantics
 * established on ModelWindowTotals: `null` means no breakdown was recorded,
 * `0` means recorded and genuinely zero. Both are subsets of inputTokens.
 */
export type Counterfactual = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
};

/** The observed side of the comparison. Deliberately carries no costUsd — see below. */
export type Actual = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
};

export type PricingContext = {
  /**
   * Pricing instant. Callers replaying history pass the EVENT's timestamp,
   * not wall-clock now — otherwise a date-gated rate (the Claude Sonnet 5
   * introductory price, expiring 2026-08-31) would reprice past traffic as
   * the clock moves, and the same historical window would report different
   * savings on different days.
   */
  now: Date;
  priceOverrides?: Record<string, PriceRow>;
  /**
   * Tokens this finding implicates, for display and for the materiality
   * fallback when USD is unknown. This is NOT the token delta between the
   * two sides: a model-swap finding implicates every token in the call while
   * changing none of them.
   */
  implicatedTokens?: number;
};

export type PricedSavings = {
  estimatedWastedTokens: number;
  estimatedWastedUsd: number | null;
};

/**
 * Savings = cost(actual) − cost(counterfactual), with BOTH sides estimated
 * through the same price table at the same instant.
 *
 * It is deliberately impossible to pass a provider-reported cost here.
 * Preferring a real, cache-discounted costUsd on the actual side while
 * estimating the counterfactual at full price inflates the counterfactual,
 * clamps the difference to 0 through the Math.max below, and silently drops
 * the card. frontier-share.ts hit exactly that and fixed it inline in
 * 6e90aab; keeping costUsd out of this signature means no future rule can
 * reintroduce it.
 *
 * Returns null USD when either side is unpriceable — a more honest answer
 * than charging the whole call as waste, which is what frontier-trivial did
 * before this existed.
 */
export function priceCounterfactual(
  actual: Actual,
  counterfactual: Counterfactual,
  ctx: PricingContext,
): PricedSavings {
  const actualCost = estimateCostUsd(
    actual.model,
    actual.inputTokens,
    actual.outputTokens,
    ctx.priceOverrides,
    ctx.now,
    {
      cacheReadTokens: actual.cacheReadTokens,
      cacheCreationTokens: actual.cacheCreationTokens,
    },
  );
  const counterfactualCost = estimateCostUsd(
    counterfactual.model,
    counterfactual.inputTokens,
    counterfactual.outputTokens,
    ctx.priceOverrides,
    ctx.now,
    {
      cacheReadTokens: counterfactual.cacheReadTokens,
      cacheCreationTokens: counterfactual.cacheCreationTokens,
    },
  );

  const estimatedWastedUsd =
    actualCost == null || counterfactualCost == null
      ? null
      : Math.max(0, actualCost - counterfactualCost);

  return {
    estimatedWastedTokens: ctx.implicatedTokens ?? 0,
    estimatedWastedUsd,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tokenops/shared exec vitest run src/rules/counterfactual.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/rules/counterfactual.ts packages/shared/src/rules/counterfactual.test.ts
git commit -m "feat(shared): one pricer for rule savings, both sides estimated"
```

---

### Task 2: Rule contract types

**Files:**
- Create: `packages/shared/src/rules/contract.ts`
- Modify: `packages/shared/src/rules/types.ts`

**Interfaces:**
- Consumes: `Counterfactual` from Task 1.
- Produces: `Severity`, `RuleFinding`, `RuleContext`, `Rule<TInput>`. Tasks 3–6 implement `Rule`; Task 7 consumes `RuleFinding.assumption`.

No test of its own — types are exercised by Tasks 3–6. This task is a compile gate.

- [ ] **Step 1: Extract `Severity` in `types.ts`**

In `packages/shared/src/rules/types.ts`, replace the inline union on `RuleHit`:

```ts
import type { Counterfactual } from "./counterfactual.js";

export type RuleId =
  | "frontier_trivial"
  | "full_document_io"
  | "context_bloat"
  | "frontier_share"
  | "cache_efficiency";

/**
 * Named so the published contract has no anonymous field types. Declared per
 * rule and NOT derived from savings: a cheap finding can still be urgent, and
 * mapping dollars onto severity would just be a fresh set of magic numbers.
 * Ordering by savings, not severity, is what keeps low-value cards down.
 */
export type Severity = "info" | "warn" | "high";

/** Runner OUTPUT. Rules return RuleFinding (see contract.ts); the runner prices it into this. */
export interface RuleHit {
  ruleId: RuleId;
  severity: Severity;
  title: string;
  detail: string;
  estimatedWastedTokens: number;
  estimatedWastedUsd: number | null;
  eventIds: string[];
  /** What the runner priced against. Null only for legacy rows read back from the DB. */
  counterfactual: Counterfactual | null;
  /** The assumption the counterfactual rests on, surfaced to the user. */
  assumption: string | null;
}
```

- [ ] **Step 2: Create the contract**

Create `packages/shared/src/rules/contract.ts`:

```ts
import type { PriceRow } from "../pricing.js";
import type { UsageEvent } from "../schema/event.js";
import type { Counterfactual } from "./counterfactual.js";
import type { RuleId, Severity } from "./types.js";

/**
 * What a rule returns when it fires. It states WHAT is wrong and WHAT would
 * have happened instead; it never computes money. The runner turns the
 * counterfactual into dollars via priceCounterfactual.
 */
export type RuleFinding = {
  title: string;
  detail: string;
  eventIds: string[];
  counterfactual: Counterfactual;
  /**
   * Tokens implicated by this finding — for display and for the materiality
   * fallback when USD is unknown. Not the token delta: a model-swap finding
   * implicates every token in the call while changing none of them.
   */
  implicatedTokens: number;
  /**
   * The assumption the counterfactual rests on, in plain language, rendered
   * on the card. Required whenever the counterfactual embeds a judgement the
   * user might reasonably dispute (e.g. "excerpting removes half the dumped
   * content"). Omit only when the counterfactual is self-evident.
   */
  assumption?: string;
};

export type RuleContext = {
  /** Pricing instant. Replays pass the event's own timestamp — see PricingContext. */
  now: Date;
  priceOverrides?: Record<string, PriceRow>;
  /** Request-grain rules only: prior events in the same session, oldest first. */
  sessionContext?: UsageEvent[];
};

/**
 * The published rule contract. `grain` declares which shape of input a rule
 * consumes, replacing the isAggregate() gate that used to live inside
 * runRules — a new rule now STATES its grain rather than remembering to opt
 * out of the wrong one.
 *
 * See docs/rules/authoring.md.
 */
export interface Rule<TInput> {
  readonly id: RuleId;
  readonly grain: "request" | "aggregate";
  readonly defaultSeverity: Severity;
  evaluate(input: TInput, ctx: RuleContext): RuleFinding | null;
}
```

- [ ] **Step 3: Verify it compiles**

Run: `pnpm --filter @tokenops/shared exec tsc --noEmit`
Expected: errors ONLY in the five rule files and the two runners (they still return the old `RuleHit` shape without `counterfactual`/`assumption`). No errors in `contract.ts`, `types.ts`, or `counterfactual.ts`. Tasks 3–6 clear the rest.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/rules/contract.ts packages/shared/src/rules/types.ts
git commit -m "feat(shared): publishable rule contract, named Severity"
```

---

### Task 3: Migrate `frontier_trivial` and the request-grain runner

First rule through the contract, so it carries the runner change with it. After this task `runRules` prices findings and the other two request rules are temporarily adapted in place.

**Files:**
- Modify: `packages/shared/src/rules/frontier-trivial.ts`
- Modify: `packages/shared/src/rules/index.ts`
- Test: `packages/shared/src/rules/rules.test.ts` (existing — must keep passing)

**Interfaces:**
- Consumes: `Rule`, `RuleFinding`, `RuleContext` (Task 2); `priceCounterfactual` (Task 1).
- Produces: `frontierTrivialRule: Rule<UsageEvent>`, and `runRules(event, sessionContext?, ctx?)` returning `RuleHit[]` with `counterfactual` populated. Tasks 4–6 follow this exact shape.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/rules/rules.test.ts`:

```ts
import { frontierTrivialRule } from "./frontier-trivial.js";

describe("frontier_trivial counterfactual", () => {
  it("declares the cheaper in-vendor sibling at unchanged token counts", () => {
    const event = ev({
      eventId: "cf-1",
      model: "claude-opus-5",
      inputTokens: 120,
      outputTokens: 40,
      costUsd: null,
      features: {
        promptChars: 40,
        responseChars: 20,
        messageCount: 1,
        codeFenceCount: 0,
        largePasteScore: 0,
        fileDumpScore: 0,
        modelTier: "frontier",
      },
    });
    const finding = frontierTrivialRule.evaluate(event, {
      now: new Date("2026-09-15T00:00:00Z"),
    });
    expect(finding).not.toBeNull();
    expect(finding!.counterfactual).toEqual({
      model: "claude-sonnet-5",
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
    expect(finding!.implicatedTokens).toBe(160);
  });

  it("is declared info severity — its findings are worth cents", () => {
    expect(frontierTrivialRule.defaultSeverity).toBe("info");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tokenops/shared exec vitest run src/rules/rules.test.ts`
Expected: FAIL — `frontierTrivialRule` is not exported.

- [ ] **Step 3: Rewrite the rule**

Replace the body of `packages/shared/src/rules/frontier-trivial.ts`:

```ts
import { cheaperSiblingModel } from "../pricing.js";
import type { UsageEvent } from "../schema/event.js";
import type { Rule, RuleContext, RuleFinding } from "./contract.js";

/** Max total tokens for a call to be considered "trivial". */
export const FRONTIER_TRIVIAL_MAX_TOTAL_TOKENS = 200;

/**
 * Frontier model used for a trivial request (few tokens, few messages, no
 * large paste). Counterfactual: the same call served by the cheapest sibling
 * in the SAME vendor family — cross-vendor advice isn't actionable, since a
 * user can't switch one call from Claude Opus to GPT-4o-mini.
 *
 * Declared `info`: capped at 200 tokens, the most this can ever save on one
 * call is a fraction of a cent, and in a coding agent the user does not pick
 * a model per request at all. Ordering by savings keeps it below rules that
 * carry real money.
 */
export const frontierTrivialRule: Rule<UsageEvent> = {
  id: "frontier_trivial",
  grain: "request",
  defaultSeverity: "info",

  evaluate(event: UsageEvent, _ctx: RuleContext): RuleFinding | null {
    const { features, inputTokens, outputTokens } = event;
    const totalTokens = inputTokens + outputTokens;

    if (features.modelTier !== "frontier") return null;
    if (totalTokens > FRONTIER_TRIVIAL_MAX_TOTAL_TOKENS) return null;
    if (features.messageCount == null) return null;
    if (features.largePasteScore == null) return null;
    if (features.messageCount > 2) return null;
    if (features.largePasteScore >= 0.3) return null;

    const suggestedModel = cheaperSiblingModel(event.model);
    if (!suggestedModel) return null;

    return {
      title: "Frontier model for trivial task",
      detail:
        `This request used a frontier-tier model for a small prompt/response. ` +
        `Consider switching to ${suggestedModel} for simple tasks like this.`,
      eventIds: [event.eventId],
      implicatedTokens: totalTokens,
      counterfactual: {
        model: suggestedModel,
        inputTokens,
        outputTokens,
        cacheReadTokens: event.cacheReadTokens ?? null,
        cacheCreationTokens: event.cacheCreationTokens ?? null,
      },
      assumption: `${suggestedModel} handles requests at or under ${FRONTIER_TRIVIAL_MAX_TOTAL_TOKENS} tokens as well as ${event.model}`,
    };
  },
};
```

- [ ] **Step 4: Teach the runner to price findings**

Replace `runRules` in `packages/shared/src/rules/index.ts`:

```ts
import type { UsageEvent } from "../schema/event.js";
import { checkContextBloat } from "./context-bloat.js";
import type { Rule, RuleContext, RuleFinding } from "./contract.js";
import { priceCounterfactual } from "./counterfactual.js";
import { frontierTrivialRule } from "./frontier-trivial.js";
import { checkFullDocumentIo } from "./full-document-io.js";
import { isMaterial } from "./materiality.js";
import type { RuleHit } from "./types.js";

export type { RuleHit, RuleId, Severity } from "./types.js";
export type { Rule, RuleContext, RuleFinding } from "./contract.js";
export type {
  Counterfactual,
  Actual,
  PricedSavings,
  PricingContext,
} from "./counterfactual.js";
export { priceCounterfactual } from "./counterfactual.js";
export {
  FRONTIER_TRIVIAL_MAX_TOTAL_TOKENS,
  frontierTrivialRule,
} from "./frontier-trivial.js";
export {
  FULL_DOC_MIN_PROMPT_CHARS,
  FULL_DOC_MIN_DUMP_SCORE,
  checkFullDocumentIo,
} from "./full-document-io.js";
export {
  BLOAT_MIN_EVENTS,
  BLOAT_INPUT_GROWTH_RATIO,
  BLOAT_MAX_NEW_CONTENT_RATIO,
  checkContextBloat,
} from "./context-bloat.js";
export { MIN_WASTED_USD, MIN_WASTED_TOKENS, isMaterial } from "./materiality.js";

/** Aggregate events are time-bucketed sums, not requests. */
export function isAggregate(event: UsageEvent): boolean {
  return event.grain === "aggregate";
}

/** Every request-grain rule, in the order their cards were historically emitted. */
export const REQUEST_RULES: Rule<UsageEvent>[] = [frontierTrivialRule];

/**
 * Turn a rule's finding into a priced hit. The single place per-request
 * savings are computed — rules no longer do money at all.
 */
export function priceFinding(
  rule: Rule<unknown>,
  finding: RuleFinding,
  actualModel: string,
  actualInputTokens: number,
  actualOutputTokens: number,
  actualCacheRead: number | null,
  actualCacheCreation: number | null,
  ctx: RuleContext,
): RuleHit {
  const priced = priceCounterfactual(
    {
      model: actualModel,
      inputTokens: actualInputTokens,
      outputTokens: actualOutputTokens,
      cacheReadTokens: actualCacheRead,
      cacheCreationTokens: actualCacheCreation,
    },
    finding.counterfactual,
    {
      now: ctx.now,
      priceOverrides: ctx.priceOverrides,
      implicatedTokens: finding.implicatedTokens,
    },
  );

  return {
    ruleId: rule.id,
    severity: rule.defaultSeverity,
    title: finding.title,
    detail: finding.detail,
    estimatedWastedTokens: priced.estimatedWastedTokens,
    estimatedWastedUsd: priced.estimatedWastedUsd,
    eventIds: finding.eventIds,
    counterfactual: finding.counterfactual,
    assumption: finding.assumption ?? null,
  };
}

/**
 * Run all efficiency rules against an event (and optional same-session history).
 *
 * Aggregates are gated here, not in each rule: a new per-request rule must opt
 * in to aggregates deliberately rather than remember to opt out. Every
 * request-grain rule reads features an aggregate cannot have.
 */
export function runRules(
  event: UsageEvent,
  sessionContext?: UsageEvent[],
  ctx?: Partial<RuleContext>,
): RuleHit[] {
  if (isAggregate(event)) return [];

  const fullCtx: RuleContext = {
    now: ctx?.now ?? new Date(event.timestamp),
    priceOverrides: ctx?.priceOverrides,
    sessionContext,
  };

  const hits: RuleHit[] = [];

  for (const rule of REQUEST_RULES) {
    const finding = rule.evaluate(event, fullCtx);
    if (!finding) continue;
    hits.push(
      priceFinding(
        rule,
        finding,
        event.model,
        event.inputTokens,
        event.outputTokens,
        event.cacheReadTokens ?? null,
        event.cacheCreationTokens ?? null,
        fullCtx,
      ),
    );
  }

  // Not yet migrated — Task 4 moves these into REQUEST_RULES.
  const fullDoc = checkFullDocumentIo(event);
  if (fullDoc) hits.push(fullDoc);

  const bloat = checkContextBloat(event, sessionContext);
  if (bloat) hits.push(bloat);

  return hits.filter(isMaterial);
}
```

Then add `counterfactual: null, assumption: null` to the object literals returned by `full-document-io.ts` and `context-bloat.ts` so they satisfy the updated `RuleHit`. Task 4 removes both.

- [ ] **Step 5: Run the full shared suite**

Run: `pnpm --filter @tokenops/shared test`
Expected: PASS. The existing `runRules` tests still pass — `frontier_trivial` prices the same way, now via the shared pricer.

If the first `runRules` test fails on materiality: it uses `costUsd: 0.05` with `gpt-4o`, and savings no longer read `costUsd`. `gpt-4o` (in $2.50) vs `gpt-4o-mini` (in $0.15) on 20 in / 10 out is well under `MIN_WASTED_USD`, so this finding now correctly drops below the floor. Update that test to use token counts that clear $0.01 — e.g. `inputTokens: 180, outputTokens: 20` on `claude-opus-5` — and add a comment saying savings come from the rate delta, not from `costUsd`.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/rules/
git commit -m "feat(shared): frontier_trivial declares a counterfactual, runner prices it"
```

---

### Task 4: Migrate `full_document_io` and `context_bloat`

**Files:**
- Modify: `packages/shared/src/rules/full-document-io.ts`
- Modify: `packages/shared/src/rules/context-bloat.ts`
- Modify: `packages/shared/src/rules/index.ts`
- Test: `packages/shared/src/rules/rules.test.ts`

**Interfaces:**
- Consumes: `Rule`, `RuleFinding`, `RuleContext`, `priceFinding`, `REQUEST_RULES`.
- Produces: `fullDocumentIoRule`, `contextBloatRule`, both `Rule<UsageEvent>`. `FULL_DOC_EXCERPT_FRACTION` becomes an exported, named constant.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/rules/rules.test.ts`:

```ts
import { fullDocumentIoRule, FULL_DOC_EXCERPT_FRACTION } from "./full-document-io.js";
import { contextBloatRule } from "./context-bloat.js";

describe("full_document_io counterfactual", () => {
  it("removes the excerptable share of input and states the assumption", () => {
    const event = ev({
      eventId: "fd-1",
      model: "claude-sonnet-5",
      inputTokens: 10_000,
      outputTokens: 200,
      costUsd: null,
      features: {
        promptChars: 40_000,
        responseChars: 400,
        messageCount: 1,
        codeFenceCount: 3,
        largePasteScore: 0.9,
        fileDumpScore: 0.8,
        modelTier: "mid",
      },
    });
    const finding = fullDocumentIoRule.evaluate(event, {
      now: new Date("2026-09-15T00:00:00Z"),
    });
    expect(finding).not.toBeNull();
    // 10_000 * 0.8 * 0.5 = 4_000 excerptable
    const removed = Math.floor(10_000 * 0.8 * FULL_DOC_EXCERPT_FRACTION);
    expect(finding!.counterfactual.inputTokens).toBe(10_000 - removed);
    expect(finding!.counterfactual.model).toBe("claude-sonnet-5");
    expect(finding!.implicatedTokens).toBe(removed);
    expect(finding!.assumption).toMatch(/half/i);
  });
});

describe("context_bloat counterfactual", () => {
  it("holds input flat at the session's first request", () => {
    const base = {
      model: "claude-sonnet-5",
      costUsd: null,
      sessionId: "s1",
      features: {
        promptChars: 1_000,
        responseChars: 100,
        messageCount: 4,
        codeFenceCount: 0,
        largePasteScore: 0,
        fileDumpScore: 0,
        modelTier: "mid" as const,
        newContentRatio: 0.05,
      },
    };
    const prior = [
      ev({ ...base, eventId: "b1", inputTokens: 5_000, outputTokens: 100 }),
      ev({ ...base, eventId: "b2", inputTokens: 9_000, outputTokens: 100 }),
    ];
    const current = ev({
      ...base,
      eventId: "b3",
      inputTokens: 40_000,
      outputTokens: 100,
    });
    const finding = contextBloatRule.evaluate(current, {
      now: new Date("2026-09-15T00:00:00Z"),
      sessionContext: prior,
    });
    expect(finding).not.toBeNull();
    expect(finding!.counterfactual.inputTokens).toBe(5_000);
    expect(finding!.implicatedTokens).toBe(35_000);
    expect(finding!.eventIds).toEqual(["b1", "b2", "b3"]);
    expect(finding!.assumption).toMatch(/first request/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tokenops/shared exec vitest run src/rules/rules.test.ts`
Expected: FAIL — `fullDocumentIoRule` / `contextBloatRule` not exported.

- [ ] **Step 3: Rewrite `full-document-io.ts`**

```ts
import type { UsageEvent } from "../schema/event.js";
import type { Rule, RuleContext, RuleFinding } from "./contract.js";

/** Minimum prompt size (chars) to consider full-document I/O. */
export const FULL_DOC_MIN_PROMPT_CHARS = 20_000;

/** Minimum file-dump score to flag bulk document paste. */
export const FULL_DOC_MIN_DUMP_SCORE = 0.55;

/**
 * Share of the dumped content excerpting is assumed to remove.
 *
 * This used to be a bare `* 0.5` inside the savings arithmetic, where nothing
 * stated what it represented and the dollar figure it produced could not be
 * checked. It is now a named constant feeding a counterfactual, and the
 * finding carries the assumption in words so a user can disagree with it.
 */
export const FULL_DOC_EXCERPT_FRACTION = 0.5;

/**
 * Large prompt with a high file-dump signal — whole documents pasted instead
 * of excerpts. Counterfactual: the same model with the excerptable share of
 * input removed.
 */
export const fullDocumentIoRule: Rule<UsageEvent> = {
  id: "full_document_io",
  grain: "request",
  defaultSeverity: "warn",

  evaluate(event: UsageEvent, _ctx: RuleContext): RuleFinding | null {
    const { features, inputTokens, outputTokens } = event;

    if (features.promptChars == null) return null;
    if (features.fileDumpScore == null) return null;
    if (features.promptChars < FULL_DOC_MIN_PROMPT_CHARS) return null;
    if (features.fileDumpScore < FULL_DOC_MIN_DUMP_SCORE) return null;

    const removedTokens = Math.floor(
      inputTokens * features.fileDumpScore * FULL_DOC_EXCERPT_FRACTION,
    );
    if (removedTokens <= 0) return null;

    return {
      title: "Full-document I/O",
      detail:
        "Prompt looks like a large file dump. Send diffs, excerpts, or retrieved " +
        "chunks instead of whole documents every turn.",
      eventIds: [event.eventId],
      implicatedTokens: removedTokens,
      counterfactual: {
        model: event.model,
        inputTokens: Math.max(0, inputTokens - removedTokens),
        outputTokens,
        cacheReadTokens: event.cacheReadTokens ?? null,
        cacheCreationTokens: event.cacheCreationTokens ?? null,
      },
      assumption:
        "Assumes excerpting removes half the dumped content, leaving the rest of the prompt unchanged",
    };
  },
};
```

- [ ] **Step 4: Rewrite `context-bloat.ts`**

```ts
import type { UsageEvent } from "../schema/event.js";
import type { Rule, RuleContext, RuleFinding } from "./contract.js";

/** Minimum events in session (including current) before bloat is evaluated. */
export const BLOAT_MIN_EVENTS = 3;

/** Current inputTokens / first inputTokens must be at least this ratio. */
export const BLOAT_INPUT_GROWTH_RATIO = 1.8;

/** Max new-content ratio — low values mean mostly repeated context. */
export const BLOAT_MAX_NEW_CONTENT_RATIO = 0.25;

/**
 * Session context growing with little new content. Counterfactual: input held
 * flat at the session's first request.
 *
 * That counterfactual assumes the first request was not itself already
 * bloated. When it was, savings are understated — surfaced through
 * `assumption` rather than silently absorbed.
 */
export const contextBloatRule: Rule<UsageEvent> = {
  id: "context_bloat",
  grain: "request",
  defaultSeverity: "warn",

  evaluate(event: UsageEvent, ctx: RuleContext): RuleFinding | null {
    const sessionContext = ctx.sessionContext;
    if (!event.sessionId) return null;
    if (!sessionContext || sessionContext.length < 2) return null;
    if (sessionContext.length + 1 < BLOAT_MIN_EVENTS) return null;

    const first = sessionContext[0]!;
    if (first.inputTokens <= 0) return null;

    const growth = event.inputTokens / first.inputTokens;
    if (growth < BLOAT_INPUT_GROWTH_RATIO) return null;

    const newContentRatio = event.features.newContentRatio;
    if (newContentRatio === undefined) return null;
    if (newContentRatio > BLOAT_MAX_NEW_CONTENT_RATIO) return null;

    const excessTokens = Math.max(0, event.inputTokens - first.inputTokens);
    if (excessTokens === 0) return null;

    return {
      title: "Context bloat",
      detail:
        "Input tokens grew substantially across this session while little new content " +
        "was added. Trim history, summarize, or drop stale files from context.",
      eventIds: [...sessionContext.map((e) => e.eventId), event.eventId],
      implicatedTokens: excessTokens,
      counterfactual: {
        model: event.model,
        inputTokens: first.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens ?? null,
        cacheCreationTokens: event.cacheCreationTokens ?? null,
      },
      assumption:
        "Assumes context could have stayed at the size of the session's first request",
    };
  },
};
```

- [ ] **Step 5: Finish the runner**

In `packages/shared/src/rules/index.ts`: add both rules to `REQUEST_RULES`, delete the two temporary `checkFullDocumentIo` / `checkContextBloat` calls at the bottom of `runRules`, and update the re-exports to name `fullDocumentIoRule`, `contextBloatRule`, and `FULL_DOC_EXCERPT_FRACTION` instead of the removed `check*` functions.

```ts
export const REQUEST_RULES: Rule<UsageEvent>[] = [
  frontierTrivialRule,
  fullDocumentIoRule,
  contextBloatRule,
];
```

- [ ] **Step 6: Run the full shared suite**

Run: `pnpm --filter @tokenops/shared test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/rules/
git commit -m "feat(shared): full_document_io and context_bloat declare counterfactuals

The bare * 0.5 becomes FULL_DOC_EXCERPT_FRACTION feeding a counterfactual,
with the assumption stated on the card instead of hidden in a dollar figure."
```

---

### Task 5: Migrate `cache_efficiency` — the headline change

**Files:**
- Modify: `packages/shared/src/rules/aggregate/cache-efficiency.ts`
- Modify: `packages/shared/src/rules/aggregate/index.ts`
- Test: `packages/shared/src/rules/aggregate/aggregate.test.ts`

**Interfaces:**
- Consumes: `Rule`, `RuleFinding`, `priceCounterfactual`, `ModelWindowTotals`.
- Produces: `cacheEfficiencyRule: Rule<ModelWindowTotals>`; `runAggregateRules(window, now?)` unchanged in signature, now pricing findings.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/rules/aggregate/aggregate.test.ts`:

```ts
import { cacheEfficiencyRule, CACHE_EFFICIENCY_MIN_READ_RATIO } from "./index.js";
import { MIN_WASTED_USD } from "../materiality.js";

const NOW = new Date("2026-09-15T00:00:00Z");

describe("cache_efficiency counterfactual", () => {
  const totals = (over: Partial<ModelWindowTotals> = {}): ModelWindowTotals => ({
    model: "claude-opus-5",
    modelTier: "frontier",
    inputTokens: 10_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: null,
    ...over,
  });

  it("targets the minimum healthy read ratio", () => {
    const finding = cacheEfficiencyRule.evaluate(totals(), { now: NOW });
    expect(finding).not.toBeNull();
    expect(finding!.counterfactual.cacheReadTokens).toBe(
      10_000_000 * CACHE_EFFICIENCY_MIN_READ_RATIO,
    );
    expect(finding!.counterfactual.model).toBe("claude-opus-5");
  });

  it("now quotes USD instead of null", () => {
    // opus-5 in = $5/MTok. Actual: 10M at full rate = $50.
    // Counterfactual: 5M full ($25) + 5M at 0.1x ($2.50) = $27.50. Saves $22.50.
    const hits = runAggregateRules(window([totals()]), NOW);
    const hit = hits.find((h) => h.ruleId === "cache_efficiency");
    expect(hit).toBeDefined();
    expect(hit!.estimatedWastedUsd).toBeCloseTo(22.5, 4);
  });

  it("stays silent when no cache breakdown was ever recorded", () => {
    const finding = cacheEfficiencyRule.evaluate(
      totals({ cacheReadTokens: null }),
      { now: NOW },
    );
    expect(finding).toBeNull();
  });

  it("drops a finding worth under a cent, which the token floor used to pass", () => {
    // haiku in = $1/MTok. 20k input, 0 reads -> counterfactual moves 10k to
    // 0.1x: saves 10k * $1/1M * 0.9 = $0.009, under MIN_WASTED_USD.
    // The old token fallback (MIN_WASTED_TOKENS = 5_000) passed this at 10k.
    const hits = runAggregateRules(
      window([
        totals({
          model: "claude-haiku-4-5",
          modelTier: "small",
          inputTokens: 20_000,
        }),
      ]),
      NOW,
    );
    expect(hits.some((h) => h.ruleId === "cache_efficiency")).toBe(false);
    expect(MIN_WASTED_USD).toBe(0.01); // pins the floor this depends on
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tokenops/shared exec vitest run src/rules/aggregate/aggregate.test.ts`
Expected: FAIL — `cacheEfficiencyRule` not exported.

- [ ] **Step 3: Rewrite the rule**

Replace `packages/shared/src/rules/aggregate/cache-efficiency.ts` entirely:

```ts
import type { Rule, RuleContext, RuleFinding } from "../contract.js";
import type { ModelWindowTotals } from "./index.js";

/** Below this cache-read/input ratio, cache reuse is considered poor. */
export const CACHE_EFFICIENCY_MIN_READ_RATIO = 0.5;

/**
 * Poor cache reuse for a model with material input volume.
 *
 * `null` vs `0` on cacheReadTokens is load-bearing and unchanged: `null`
 * means no cache breakdown was ever recorded for this slice of the window
 * (pre-migration events fold cache into inputTokens and report nothing
 * separately), so the rule stays silent — summing "don't know" as 0 would
 * either silence a user genuinely paying full price for context on every
 * call, or produce a confidently wrong low-reuse card on a window straddling
 * the migration. `0` means recorded and genuinely zero, and is a finding like
 * any other ratio.
 *
 * This rule used to report `estimatedWastedUsd: null`, with a comment saying
 * no per-token cache-read price existed. That stopped being true in 6e90aab,
 * which added the 0.1x read and 1.25x creation multipliers to
 * estimateCostUsd. The counterfactual below moves tokens from the full input
 * rate into the read rate, and the shared pricer values the difference — so
 * the rule now quotes dollars with no special case.
 *
 * Consequence worth knowing: materiality switches from the token fallback
 * (MIN_WASTED_TOKENS) to MIN_WASTED_USD, so small findings on cheap models
 * that used to surface now correctly drop below the floor.
 */
export const cacheEfficiencyRule: Rule<ModelWindowTotals> = {
  id: "cache_efficiency",
  grain: "aggregate",
  defaultSeverity: "warn",

  evaluate(totals: ModelWindowTotals, _ctx: RuleContext): RuleFinding | null {
    if (totals.cacheReadTokens === null) return null;
    if (totals.inputTokens <= 0) return null;

    const cacheReadTokens = totals.cacheReadTokens;
    const readRatio = cacheReadTokens / totals.inputTokens;
    if (readRatio >= CACHE_EFFICIENCY_MIN_READ_RATIO) return null;

    const targetReads = totals.inputTokens * CACHE_EFFICIENCY_MIN_READ_RATIO;
    const shortfall = Math.max(0, Math.round(targetReads - cacheReadTokens));
    if (shortfall === 0) return null;

    const pct = Math.round(readRatio * 100);

    return {
      title: "Low cache reuse",
      detail:
        `Only ${pct}% of ${totals.model}'s input tokens were served from ` +
        `cache in this window. Reusing more context (stable system prompts, ` +
        `repeated documents) can cut cost without changing model or output.`,
      eventIds: [],
      implicatedTokens: shortfall,
      counterfactual: {
        model: totals.model,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: targetReads,
        cacheCreationTokens: totals.cacheCreationTokens,
      },
      assumption: `Assumes a ${Math.round(
        CACHE_EFFICIENCY_MIN_READ_RATIO * 100,
      )}% cache-read ratio is achievable for this workload`,
    };
  },
};
```

- [ ] **Step 4: Price aggregate findings in the runner**

In `packages/shared/src/rules/aggregate/index.ts`, replace the `checkCacheEfficiency` call inside `runAggregateRules` with a `priceFinding`-style path. Aggregate rules evaluate per-model, so the actual side is that model's own totals:

```ts
import { priceCounterfactual } from "../counterfactual.js";
import type { RuleContext } from "../contract.js";
import { cacheEfficiencyRule } from "./cache-efficiency.js";

// inside runAggregateRules, replacing the old checkCacheEfficiency loop:
const ctx: RuleContext = { now };
for (const totals of window.byModel) {
  const finding = cacheEfficiencyRule.evaluate(totals, ctx);
  if (!finding) continue;
  const priced = priceCounterfactual(
    {
      model: totals.model,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheCreationTokens: totals.cacheCreationTokens,
    },
    finding.counterfactual,
    { now, implicatedTokens: finding.implicatedTokens },
  );
  hits.push({
    ruleId: cacheEfficiencyRule.id,
    severity: cacheEfficiencyRule.defaultSeverity,
    title: finding.title,
    detail: finding.detail,
    estimatedWastedTokens: priced.estimatedWastedTokens,
    estimatedWastedUsd: priced.estimatedWastedUsd,
    eventIds: finding.eventIds,
    counterfactual: finding.counterfactual,
    assumption: finding.assumption ?? null,
  });
}
```

Keep the existing "only the worst-offending model's `cache_efficiency` hit survives" behavior from `03ae001` — apply it after this loop, selecting by highest `estimatedWastedUsd` with `estimatedWastedTokens` as the tiebreak when USD is null on both.

Update the `export { CACHE_EFFICIENCY_MIN_READ_RATIO, checkCacheEfficiency }` block to export `cacheEfficiencyRule` instead.

- [ ] **Step 5: Run the aggregate suite**

Run: `pnpm --filter @tokenops/shared test`
Expected: PASS. If an existing `cache_efficiency` test asserted `estimatedWastedUsd === null`, update it to the new dollar figure and add a comment pointing at `6e90aab` — that assertion encoded the stale comment, and this is the deliberate change.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/rules/aggregate/
git commit -m "feat(shared): cache_efficiency quotes USD via the cache-read multiplier

6e90aab added the 0.1x read rate; the rule never picked it up and kept
returning null. Its counterfactual now moves tokens into the read rate and
the shared pricer values the difference. Materiality moves from the token
fallback to the USD floor as a result, so sub-cent findings stop surfacing."
```

---

### Task 6: Migrate `frontier_share`

**Files:**
- Modify: `packages/shared/src/rules/aggregate/frontier-share.ts`
- Modify: `packages/shared/src/rules/aggregate/index.ts`
- Test: `packages/shared/src/rules/aggregate/aggregate.test.ts`

**Interfaces:**
- Consumes: `Rule`, `RuleFinding`, `AggregateWindow`.
- Produces: `frontierShareRule: Rule<AggregateWindow>`.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/rules/aggregate/aggregate.test.ts`:

```ts
import { frontierShareRule } from "./index.js";

describe("frontier_share counterfactual", () => {
  it("swaps only the dominant model, carrying its own cache breakdown", () => {
    const w = window([
      {
        model: "claude-opus-5",
        modelTier: "frontier",
        inputTokens: 100_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 90_000_000,
        cacheCreationTokens: 1_000_000,
        costUsd: 900,
      },
      {
        model: "claude-haiku-4-5",
        modelTier: "small",
        inputTokens: 10_000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.1,
      },
    ]);
    const finding = frontierShareRule.evaluate(w, {
      now: new Date("2026-09-15T00:00:00Z"),
    });
    expect(finding).not.toBeNull();
    expect(finding!.counterfactual).toEqual({
      model: "claude-sonnet-5",
      inputTokens: 100_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 90_000_000,
      cacheCreationTokens: 1_000_000,
    });
  });

  it("still produces a positive saving at a realistic 90% cache-read ratio", () => {
    // Regression guard for 9b1257b: pricing the sibling at full rate while
    // the dominant side got its cache discount clamped savings to 0 and
    // dropped the only card an OTEL-only user would see.
    const hits = runAggregateRules(
      window([
        {
          model: "claude-opus-5",
          modelTier: "frontier",
          inputTokens: 100_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 90_000_000,
          cacheCreationTokens: 0,
          costUsd: 900,
        },
      ]),
      new Date("2026-09-15T00:00:00Z"),
    );
    const hit = hits.find((h) => h.ruleId === "frontier_share");
    expect(hit).toBeDefined();
    expect(hit!.estimatedWastedUsd).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tokenops/shared exec vitest run src/rules/aggregate/aggregate.test.ts`
Expected: FAIL — `frontierShareRule` not exported.

- [ ] **Step 3: Rewrite the rule**

Rewrite `packages/shared/src/rules/aggregate/frontier-share.ts` as a `Rule<AggregateWindow>`. Keep every existing selection rule verbatim — the threshold, the total/frontier token math, sorting frontier models by volume descending, and walking to the next-largest when the largest has no in-vendor sibling. Keep the `multipleFrontierModels` detail wording.

Delete the hand-rolled pricing block (`dominantCost`, `siblingCost`, `Math.max(0, ...)`) and its long comment; that concern now lives in `priceCounterfactual`, and a shortened note should point there. Return instead:

```ts
    return {
      title: "Frontier-heavy token mix",
      detail,
      eventIds: [],
      implicatedTokens: frontierTokens,
      counterfactual: {
        model: suggestedModel,
        inputTokens: dominant.inputTokens,
        outputTokens: dominant.outputTokens,
        cacheReadTokens: dominant.cacheReadTokens,
        cacheCreationTokens: dominant.cacheCreationTokens,
      },
      assumption:
        `Assumes routine work moves from ${dominant.model} to ${suggestedModel}. ` +
        `Other vendors' frontier tokens are counted in the share but not repriced.`,
    };
```

Declare `defaultSeverity: "warn"`, `grain: "aggregate"`, `id: "frontier_share"`.

- [ ] **Step 4: Wire it into the runner**

In `aggregate/index.ts`, replace the `checkFrontierShare(window, now)` call with `frontierShareRule.evaluate(window, { now })` followed by the same `priceCounterfactual` + push used in Task 5 — the actual side being the dominant model's own totals. Since the rule no longer returns the dominant totals, have `evaluate` also set `eventIds: []` and derive the actual side inside the runner by matching `finding.counterfactual` against `window.byModel`; simpler and less fragile is to price inside a small local helper that takes the dominant `ModelWindowTotals` the rule already selected — so return it on the finding via a non-exported field is *not* allowed by the contract. Instead: give `frontierShareRule` the counterfactual only, and in the runner locate the dominant totals with

```ts
const dominant = window.byModel.find(
  (m) =>
    m.inputTokens === finding.counterfactual.inputTokens &&
    m.outputTokens === finding.counterfactual.outputTokens &&
    m.modelTier === "frontier",
);
if (!dominant) continue;
```

Update the export block to name `frontierShareRule` instead of `checkFrontierShare`.

- [ ] **Step 5: Run the full shared suite**

Run: `pnpm --filter @tokenops/shared test`
Expected: PASS, including the pre-existing 90%-cache-ratio test from `9b1257b`.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/rules/aggregate/
git commit -m "refactor(shared): frontier_share declares a counterfactual

Deletes its hand-rolled both-sides pricing — that invariant now lives in
priceCounterfactual, where no future rule can forget it."
```

---

### Task 7: Back-test engine

**Files:**
- Create: `packages/shared/src/rules/backtest.ts`
- Create: `packages/shared/src/rules/backtest.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `runRules`, `runAggregateRules`, `AggregateWindow`, `UsageEvent`, `RuleId`.
- Produces: `backtest(input): BacktestResult`, `BacktestRow`, `BacktestResult`, `BacktestInput`. Task 10 exposes these over HTTP.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/rules/backtest.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { backtest } from "./backtest.js";
import type { UsageEvent } from "../schema/event.js";
import type { AggregateWindow } from "./aggregate/index.js";

const ev = (over: Partial<UsageEvent> & Pick<UsageEvent, "eventId">): UsageEvent => ({
  timestamp: "2026-08-15T00:00:00.000Z",
  machineId: "m",
  machineName: "n",
  app: "openai-proxy",
  provider: "anthropic",
  model: "claude-opus-5",
  inputTokens: 180,
  outputTokens: 20,
  costUsd: null,
  hasContent: false,
  features: {
    promptChars: 40,
    responseChars: 20,
    messageCount: 1,
    codeFenceCount: 0,
    largePasteScore: 0,
    fileDumpScore: 0,
    modelTier: "frontier",
  },
  ...over,
});

const emptyWindow: AggregateWindow[] = [];

describe("backtest", () => {
  it("rolls hits up per rule", () => {
    const res = backtest({
      events: [ev({ eventId: "a" }), ev({ eventId: "b" })],
      windows: emptyWindow,
      windowStart: "2026-08-01T00:00:00.000Z",
      windowEnd: "2026-08-31T00:00:00.000Z",
    });
    const row = res.rows.find((r) => r.ruleId === "frontier_trivial");
    expect(row).toBeDefined();
    expect(row!.hits).toBe(2);
    expect(row!.wouldHaveSavedUsd).toBeGreaterThan(0);
    expect(row!.assumption).toMatch(/claude-sonnet-5/);
  });

  it("orders rows by savings, highest first", () => {
    const res = backtest({
      events: [ev({ eventId: "a" })],
      windows: [
        {
          start: "2026-08-01T00:00:00.000Z",
          end: "2026-08-08T00:00:00.000Z",
          byModel: [
            {
              model: "claude-opus-5",
              modelTier: "frontier",
              inputTokens: 10_000_000,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              costUsd: null,
            },
          ],
        },
      ],
      windowStart: "2026-08-01T00:00:00.000Z",
      windowEnd: "2026-08-31T00:00:00.000Z",
    });
    const saved = res.rows.map((r) => r.wouldHaveSavedUsd);
    expect(saved).toEqual([...saved].sort((a, b) => b - a));
  });

  it("prices each event at its own timestamp, not wall-clock now", () => {
    // Sonnet 5's intro rate ($2/MTok) expires 2026-08-31. An August event
    // must price at the intro rate no matter when the back-test runs, or the
    // same historical window would report different savings on different days.
    const august = ev({ eventId: "aug", timestamp: "2026-08-15T00:00:00.000Z" });
    const september = ev({ eventId: "sep", timestamp: "2026-09-15T00:00:00.000Z" });
    const run = (events: UsageEvent[]) =>
      backtest({
        events,
        windows: emptyWindow,
        windowStart: "2026-08-01T00:00:00.000Z",
        windowEnd: "2026-09-30T00:00:00.000Z",
      }).rows.find((r) => r.ruleId === "frontier_trivial")!.wouldHaveSavedUsd;

    // opus-5 in $5 vs sonnet-5: intro $2 (saves more) / standard $3 (saves less)
    expect(run([august])).toBeGreaterThan(run([september]));
  });

  it("is deterministic — same input, same output", () => {
    const input = {
      events: [ev({ eventId: "a" }), ev({ eventId: "b" })],
      windows: emptyWindow,
      windowStart: "2026-08-01T00:00:00.000Z",
      windowEnd: "2026-08-31T00:00:00.000Z",
    };
    expect(backtest(input)).toEqual(backtest(input));
  });

  it("never evaluates request rules against aggregate events", () => {
    const res = backtest({
      events: [ev({ eventId: "agg", grain: "aggregate" })],
      windows: emptyWindow,
      windowStart: "2026-08-01T00:00:00.000Z",
      windowEnd: "2026-08-31T00:00:00.000Z",
    });
    expect(res.rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tokenops/shared exec vitest run src/rules/backtest.test.ts`
Expected: FAIL — cannot resolve `./backtest.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/rules/backtest.ts`:

```ts
import type { PriceRow } from "../pricing.js";
import type { UsageEvent } from "../schema/event.js";
import { runAggregateRules, type AggregateWindow } from "./aggregate/index.js";
import { runRules } from "./index.js";
import type { RuleId } from "./types.js";

export type BacktestRow = {
  ruleId: RuleId;
  hits: number;
  wouldHaveSavedUsd: number;
  /** The assumption behind the savings, taken from the first hit for the rule. */
  assumption: string | null;
};

export type BacktestResult = {
  windowStart: string;
  windowEnd: string;
  rows: BacktestRow[];
};

export type BacktestInput = {
  /** Stored events, chronological (oldest first). Aggregates are skipped by runRules. */
  events: UsageEvent[];
  /** Pre-built per-model windows for the aggregate rules. */
  windows: AggregateWindow[];
  windowStart: string;
  windowEnd: string;
  priceOverrides?: Record<string, PriceRow>;
};

/**
 * Replay the CURRENT rules over historical data and report, per rule, what
 * following them would have saved.
 *
 * It re-evaluates rules rather than summing the recommendations table. That
 * is what makes it a back-test rather than a rollup, and it means changing a
 * threshold shows its dollar impact on real history immediately.
 *
 * Every event is priced at its OWN timestamp, and every window at its own
 * end — never wall-clock now. The Claude Sonnet 5 introductory rate expires
 * 2026-08-31, so a back-test that used the current time would reprice August
 * traffic at September rates and report different savings for the same
 * historical window depending on the day it ran.
 */
export function backtest(input: BacktestInput): BacktestResult {
  const byRule = new Map<RuleId, BacktestRow>();

  const record = (
    ruleId: RuleId,
    usd: number | null,
    assumption: string | null,
  ) => {
    const existing = byRule.get(ruleId);
    if (existing) {
      existing.hits += 1;
      existing.wouldHaveSavedUsd += usd ?? 0;
      existing.assumption ??= assumption;
      return;
    }
    byRule.set(ruleId, {
      ruleId,
      hits: 1,
      wouldHaveSavedUsd: usd ?? 0,
      assumption,
    });
  };

  // Request-grain rules. Session context is the prior events of the same
  // session, oldest first — the same shape applyRulesForEvent passes live.
  const bySession = new Map<string, UsageEvent[]>();
  for (const event of input.events) {
    const priorSameSession = event.sessionId
      ? (bySession.get(event.sessionId) ?? [])
      : [];
    const hits = runRules(event, priorSameSession, {
      now: new Date(event.timestamp),
      priceOverrides: input.priceOverrides,
    });
    for (const hit of hits) {
      record(hit.ruleId, hit.estimatedWastedUsd, hit.assumption);
    }
    if (event.sessionId) {
      bySession.set(event.sessionId, [...priorSameSession, event]);
    }
  }

  // Aggregate-grain rules, each window priced at its own end instant.
  for (const window of input.windows) {
    const hits = runAggregateRules(window, new Date(window.end));
    for (const hit of hits) {
      record(hit.ruleId, hit.estimatedWastedUsd, hit.assumption);
    }
  }

  const rows = [...byRule.values()].sort(
    (a, b) => b.wouldHaveSavedUsd - a.wouldHaveSavedUsd,
  );

  return {
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    rows,
  };
}
```

- [ ] **Step 4: Export the public surface**

In `packages/shared/src/index.ts`, extend the rules export block:

```ts
export {
  runRules,
  priceCounterfactual,
  priceFinding,
  REQUEST_RULES,
  frontierTrivialRule,
  fullDocumentIoRule,
  contextBloatRule,
  FRONTIER_TRIVIAL_MAX_TOTAL_TOKENS,
  FULL_DOC_MIN_PROMPT_CHARS,
  FULL_DOC_MIN_DUMP_SCORE,
  FULL_DOC_EXCERPT_FRACTION,
  BLOAT_MIN_EVENTS,
  BLOAT_INPUT_GROWTH_RATIO,
  BLOAT_MAX_NEW_CONTENT_RATIO,
  MIN_WASTED_USD,
  MIN_WASTED_TOKENS,
  type RuleHit,
  type RuleId,
  type Severity,
  type Rule,
  type RuleFinding,
  type RuleContext,
  type Counterfactual,
  type Actual,
  type PricedSavings,
  type PricingContext,
} from "./rules/index.js";
export {
  backtest,
  type BacktestInput,
  type BacktestResult,
  type BacktestRow,
} from "./rules/backtest.js";
export {
  runAggregateRules,
  frontierShareRule,
  cacheEfficiencyRule,
  FRONTIER_SHARE_THRESHOLD,
  CACHE_EFFICIENCY_MIN_READ_RATIO,
  AGGREGATE_RULE_IDS,
  type ModelWindowTotals,
  type AggregateWindow,
} from "./rules/aggregate/index.js";
```

- [ ] **Step 5: Run tests and build**

Run: `pnpm --filter @tokenops/shared test && pnpm --filter @tokenops/shared build`
Expected: PASS, clean build.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/
git commit -m "feat(shared): back-test rules over history at each event's own price date"
```

---

### Task 8: Persist the counterfactual

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/000N_<generated>.sql`
- Modify: `apps/api/src/services/events-repo.ts`
- Modify: `apps/api/src/services/rules-runner.ts`
- Modify: `apps/api/src/jobs/aggregate-rules.ts`
- Test: `apps/api/src/services/events-repo.test.ts`

**Interfaces:**
- Consumes: `Counterfactual` from `@tokenops/shared`.
- Produces: `RecommendationInsert` gains `counterfactual: Counterfactual | null` and `assumption: string | null`; the `recommendations` row gains both columns.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/events-repo.test.ts`:

```ts
it("round-trips a counterfactual and assumption on a recommendation", async () => {
  const repo = createMemoryEventsRepo();
  await repo.upsertRecommendation({
    userId: "u1",
    ruleId: "frontier_trivial",
    severity: "info",
    title: "t",
    detail: "d",
    estimatedWastedTokens: 160,
    estimatedWastedUsd: 0.02,
    eventIds: ["e1"],
    dedupeKey: "e1",
    counterfactual: {
      model: "claude-sonnet-5",
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    },
    assumption: "claude-sonnet-5 handles small requests as well",
  });
  const [row] = await repo.listRecommendations("u1", "open");
  expect(row!.counterfactual).toEqual({
    model: "claude-sonnet-5",
    inputTokens: 120,
    outputTokens: 40,
    cacheReadTokens: null,
    cacheCreationTokens: null,
  });
  expect(row!.assumption).toBe("claude-sonnet-5 handles small requests as well");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tokenops/api exec vitest run src/services/events-repo.test.ts`
Expected: FAIL — `counterfactual` not assignable to `RecommendationInsert`.

- [ ] **Step 3: Add the columns**

In `apps/api/src/db/schema.ts`, inside the `recommendations` table, after `eventIds`:

```ts
    /**
     * What the rule priced against. Null on rows written before this column
     * existed — the UI must distinguish "no counterfactual recorded" from
     * "counterfactual computed and empty", the same absent-vs-zero care the
     * cache fields take.
     */
    counterfactual: jsonb("counterfactual").$type<Counterfactual | null>(),
    /** Plain-language assumption behind the counterfactual. */
    assumption: text("assumption"),
```

Add `import type { Counterfactual } from "@tokenops/shared";` at the top.

- [ ] **Step 4: Generate and inspect the migration**

Run: `pnpm --filter @tokenops/api exec drizzle-kit generate`
Expected: a new `apps/api/drizzle/000N_<random-name>.sql` containing exactly:

```sql
ALTER TABLE "recommendations" ADD COLUMN "counterfactual" jsonb;
ALTER TABLE "recommendations" ADD COLUMN "assumption" text;
```

Both nullable with no default — existing rows keep `NULL`, which is the intended "not recorded" state. If the generated SQL contains anything else (a table rewrite, a NOT NULL, a drop), stop and re-check the schema edit.

- [ ] **Step 5: Thread the fields through**

- `RecommendationInsert` (`events-repo.ts`): add `counterfactual: Counterfactual | null;` and `assumption: string | null;`.
- Both `upsertRecommendation` implementations (drizzle at ~line 348, memory at ~line 681): persist both fields, including in the `onConflictDoUpdate` set so a re-fired rule refreshes its evidence.
- `rules-runner.ts` `applyRulesForEvent`: pass `counterfactual: hit.counterfactual, assumption: hit.assumption`.
- `aggregate-rules.ts` `runAggregateRulesForUser`: same, in the `for (const hit of hits)` loop.

- [ ] **Step 6: Run the API suite**

Run: `pnpm --filter @tokenops/api test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/
git commit -m "feat(api): persist the counterfactual behind each recommendation"
```

---

### Task 9: Rank by savings

**Files:**
- Modify: `apps/api/src/services/events-repo.ts`
- Test: `apps/api/src/services/events-repo.test.ts`

**Interfaces:**
- Consumes: `estimatedWastedUsd` on the recommendations row.
- Produces: `listRecommendations` ordered by savings descending, nulls last.

- [ ] **Step 1: Write the failing test**

```ts
it("orders recommendations by savings, nulls last", async () => {
  const repo = createMemoryEventsRepo();
  const base = {
    userId: "u1",
    severity: "warn",
    title: "t",
    detail: "d",
    estimatedWastedTokens: 1,
    eventIds: [],
    counterfactual: null,
    assumption: null,
  };
  await repo.upsertRecommendation({
    ...base, ruleId: "frontier_trivial", estimatedWastedUsd: 0.94, dedupeKey: "a",
  });
  await repo.upsertRecommendation({
    ...base, ruleId: "cache_efficiency", estimatedWastedUsd: 23.1, dedupeKey: "b",
  });
  await repo.upsertRecommendation({
    ...base, ruleId: "context_bloat", estimatedWastedUsd: null, dedupeKey: "c",
  });

  const rows = await repo.listRecommendations("u1", "open");
  expect(rows.map((r) => r.ruleId)).toEqual([
    "cache_efficiency",
    "frontier_trivial",
    "context_bloat",
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tokenops/api exec vitest run src/services/events-repo.test.ts`
Expected: FAIL — order is by `createdAt` descending.

- [ ] **Step 3: Change both implementations**

Drizzle version — replace the `orderBy`:

```ts
      // Savings first, so a $0.94 finding can never sit above a $23 one.
      // NULLS LAST: an unpriceable finding is not a large one.
      .orderBy(
        sql`${recommendations.estimatedWastedUsd} DESC NULLS LAST`,
        desc(recommendations.createdAt),
      );
```

Add `sql` to the drizzle-orm import. `estimated_wasted_usd` is `numeric`, so Postgres orders it numerically — not lexically — which is why the raw column is used rather than a cast.

Memory version — replace the `.sort(...)`:

```ts
        .sort((a, b) => {
          const au = a.estimatedWastedUsd == null ? null : Number(a.estimatedWastedUsd);
          const bu = b.estimatedWastedUsd == null ? null : Number(b.estimatedWastedUsd);
          if (au == null && bu != null) return 1;
          if (bu == null && au != null) return -1;
          if (au != null && bu != null && au !== bu) return bu - au;
          return b.createdAt.getTime() - a.createdAt.getTime();
        });
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @tokenops/api test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/events-repo.ts apps/api/src/services/events-repo.test.ts
git commit -m "feat(api): rank recommendations by estimated savings, nulls last"
```

---

### Task 10: Back-test endpoint

**Files:**
- Modify: `apps/api/src/routes/recommendations.ts`
- Test: `apps/api/src/routes/recommendations.test.ts` (create if absent)

**Interfaces:**
- Consumes: `backtest`, `BacktestResult` from `@tokenops/shared`; `EventsRepo.listEvents`, `EventsRepo.modelWindowTotals`.
- Produces: `GET /v1/recommendations/backtest?window=<7d|30d|90d>` → `{ windowStart, windowEnd, rows: BacktestRow[] }`.

- [ ] **Step 1: Write the failing test**

```ts
it("rejects an unknown window rather than silently falling back", async () => {
  const res = await app.request("/v1/recommendations/backtest?window=42d", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid_window" });
});

it("defaults to 30d and returns rule rows", async () => {
  const res = await app.request("/v1/recommendations/backtest", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.rows)).toBe(true);
  expect(typeof body.windowStart).toBe("string");
});
```

Mirror the auth setup used by the existing recommendations route tests; if none exists, copy the harness from `apps/api/src/routes/tenant-isolation.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tokenops/api exec vitest run src/routes/recommendations.test.ts`
Expected: FAIL — 404 on the backtest path.

- [ ] **Step 3: Add the route**

In `apps/api/src/routes/recommendations.ts`:

```ts
import { backtest, type UsageEvent } from "@tokenops/shared";

const WINDOW_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

/**
 * Replay the current rules over stored history. Rejects an unknown window
 * rather than falling back silently, matching how the list route rejects an
 * unknown `status` — a typo'd window must not quietly return a different
 * period than the caller asked for.
 */
recommendationsRoutes.get("/backtest", requireUser, async (c) => {
  const repo = c.get("eventsRepo");
  const userId = c.get("userId");

  const windowParam = c.req.query("window") ?? "30d";
  const days = WINDOW_DAYS[windowParam];
  if (days === undefined) {
    return c.json({ error: "invalid_window" }, 400);
  }

  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const rows = await repo.listEvents(userId, { from: startIso, to: endIso });
  const events = rows
    .map(rowToUsageEvent)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const byModel = await repo.modelWindowTotals(userId, startIso, endIso);

  const result = backtest({
    events,
    windows: [{ start: startIso, end: endIso, byModel }],
    windowStart: startIso,
    windowEnd: endIso,
  });

  return c.json(result);
});
```

`rowToUsageEvent` maps a `UsageEventRow` to a `UsageEvent`. If the module already has such a mapper (the events route builds the same shape), import and reuse it rather than writing a second one. It must carry `grain`, `sessionId`, `cacheReadTokens`, `cacheCreationTokens`, and `features` through unchanged — dropping `grain` would let request rules evaluate aggregate rows and produce findings from fabricated features.

**Register `/backtest` before any `/:id` route** so Hono does not match it as an id.

- [ ] **Step 4: Extend the DTO**

Add `counterfactual: row.counterfactual ?? null` and `assumption: row.assumption ?? null` to `recToDto`.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @tokenops/api test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/
git commit -m "feat(api): GET /v1/recommendations/backtest"
```

---

### Task 11: Show the evidence in the dashboard

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/pages/Recommendations.tsx`

**Interfaces:**
- Consumes: the extended recommendation DTO from Task 10.
- Produces: cards rendering assumption and counterfactual.

- [ ] **Step 1: Extend the client types**

In `apps/web/src/api/client.ts`, add to `RecommendationDto`:

```ts
  counterfactual: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
  } | null;
  assumption: string | null;
```

- [ ] **Step 2: Render them**

In `Recommendations.tsx`, after the existing est-waste line inside `<article>`:

```tsx
              {r.counterfactual ? (
                <div className="muted mono" style={{ fontSize: "0.8rem", marginTop: "0.35rem" }}>
                  Would have been: {r.counterfactual.model} ·{" "}
                  {formatTokens(r.counterfactual.inputTokens)} in /{" "}
                  {formatTokens(r.counterfactual.outputTokens)} out
                </div>
              ) : null}
              {r.assumption ? (
                <div className="muted" style={{ fontSize: "0.8rem", marginTop: "0.35rem" }}>
                  Assumes: {r.assumption}
                </div>
              ) : null}
```

Render nothing when `counterfactual` is null — that means the row predates the column, which is different from a counterfactual that came back empty. Do not substitute a dash or "n/a"; an absent evidence block is the honest rendering.

- [ ] **Step 3: Update the ordering note**

Change the page subtitle so it states the new ordering:

```tsx
      <p className="muted" style={{ marginTop: "-0.5rem" }}>
        Efficiency findings, highest estimated savings first. Savings figures are{" "}
        <strong>estimated</strong> — each is a real token count priced at
        published rates under the stated assumption, not a measurement.
      </p>
```

- [ ] **Step 4: Verify the build**

Run: `pnpm --filter @tokenops/web build`
Expected: clean build, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/
git commit -m "feat(web): show the counterfactual and its assumption on each card"
```

---

### Task 12: Publish the rule-authoring guide

**Files:**
- Create: `docs/rules/authoring.md`
- Create: `docs/rules/authoring.html`

**Interfaces:**
- Consumes: everything above. No code.

- [ ] **Step 1: Write the guide**

Create `docs/rules/authoring.md` covering, in this order:

1. **What a rule is** — a predicate plus a counterfactual. It never computes money. Show the `Rule`, `RuleFinding`, `RuleContext`, and `Counterfactual` types verbatim from `contract.ts` and `counterfactual.ts`.
2. **A worked example** — reproduce `frontierTrivialRule` in full, annotated: why it returns null early, why the counterfactual keeps token counts unchanged, why `implicatedTokens` is the total rather than the delta, why `assumption` is phrased for a user rather than a developer.
3. **Choosing a counterfactual** — the table from the spec, plus the rule of thumb: it must be something the user could actually have done. Cross-vendor swaps are not actionable and must not be proposed.
4. **The invariants a rule must not break** — `null` vs `0` on cache fields; never reading `costUsd` for savings; declaring `grain` honestly; keeping `id` in the `RuleId` union.
5. **Testing a rule** — the fixture pattern from `rules.test.ts` (the `ev()` helper), one test asserting the counterfactual directly and one asserting the priced hit through the runner, and a note that materiality (`MIN_WASTED_USD`) can hide an otherwise-correct rule in tests.
6. **Stability guarantees** — `Rule`, `RuleFinding`, `RuleContext`, `Counterfactual`, `Severity`, `RuleId` are the published surface. `priceFinding`, `REQUEST_RULES`, and the runners are internal and may change. `RuleHit` is output-only; do not construct one in a rule.
7. **Submitting a rule** — open a PR against `main`; include at least one fixture-driven test per branch of the predicate and a stated assumption for any judgement embedded in the counterfactual.

- [ ] **Step 2: Render the HTML**

Run:
```bash
node scripts/build-doc-html.mjs docs/rules/authoring.md docs/rules/authoring.html
```
Expected: `Wrote docs/rules/authoring.html`.

- [ ] **Step 3: Link it from the README**

In `README.md`, in the Recommendation rules section, add a line pointing at `docs/rules/authoring.md` and stating that outside rule contributions are accepted. Re-render:

```bash
node scripts/build-doc-html.mjs README.md README.html
```

- [ ] **Step 4: Full verification**

Run:
```bash
pnpm -r build && pnpm -r test
```
Expected: all packages build, all suites pass.

- [ ] **Step 5: Commit**

```bash
git add docs/rules/ README.md README.html
git commit -m "docs: publish the rule-authoring contract"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Counterfactual type + shared pricer | 1 |
| Rule contract, named `Severity` | 2 |
| `frontier_trivial` counterfactual | 3 |
| `context_bloat`, `full_document_io` + stated assumption | 4 |
| `cache_efficiency` gains USD (item 1) | 5 |
| `frontier_share` counterfactual | 6 |
| Back-test, per-event pricing instant | 7 |
| `counterfactual jsonb` migration | 8 |
| Ranking + `frontier_trivial` → `info` (item 4) | 3 (severity), 9 (ordering) |
| Back-test endpoint, window validation | 10 |
| Evidence in UI, absent ≠ empty | 11 |
| `docs/rules/authoring.md` (item 3) | 12 |
| Risk 1: cards disappear on the materiality flip | 5, Step 1 test |
| Risk 3: `context_bloat` first-request assumption | 4, via `assumption` |
| Testing: determinism across the Sonnet 5 cutoff | 1, 7 |
| Testing: grain routing | 7 |

No spec requirement is unassigned. The OTEL/JSONL capture split is stated in the spec as context but is explicitly a non-goal for this plan — no task implements the JSONL adapter, by design.

**Placeholder scan:** No TBD/TODO. Every code step carries real code. Task 12's steps specify the required content of each section rather than reproducing prose that belongs in the doc itself — the section list is prescriptive enough to execute without invention.

**Type consistency:** `Counterfactual`, `Actual`, `PricedSavings`, `PricingContext` (Task 1) are used unchanged in Tasks 3–8. `RuleFinding.implicatedTokens` (Task 2) is the field every rule sets and `priceCounterfactual`'s `ctx.implicatedTokens` consumes. `Severity` (Task 2) is used by `Rule.defaultSeverity` and `RuleHit.severity`. `frontierTrivialRule` / `fullDocumentIoRule` / `contextBloatRule` / `cacheEfficiencyRule` / `frontierShareRule` are named identically at definition, in `REQUEST_RULES`, in the runners, and in the `index.ts` exports. `BacktestRow.wouldHaveSavedUsd` is the same name in the engine (Task 7), the route (Task 10), and the tests.

One known wrinkle, flagged rather than hidden: Task 6 Step 4 recovers the dominant `ModelWindowTotals` by matching token counts, because the contract deliberately gives a rule no channel to hand the runner an intermediate value. If two frontier models in one window share identical input *and* output token counts, the match is ambiguous. This is vanishingly unlikely with real totals, and the `find` picks the first, which is deterministic. If the implementer would rather not rely on that, the clean alternative is to widen `Rule` with an optional `resolveActual(input, finding)` method — raise it at review rather than improvising.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-06-recommendation-credibility.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
