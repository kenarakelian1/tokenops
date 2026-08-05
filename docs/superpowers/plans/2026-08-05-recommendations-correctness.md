# Recommendations Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Recommendations panel reporting on OTLP export windows as if they were requests, and give OTEL users rules that are actually answerable from their data.

**Architecture:** Events gain a `grain` discriminator (`request` vs `aggregate`). `runRules` refuses to run per-request rules on aggregates, enforced once rather than per rule. The OTEL adapter stops fabricating features and stops folding cache tokens into input. Two new window-scoped rules evaluate per model over 7 days and emit one card each.

**Tech Stack:** TypeScript, Zod, Drizzle, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-05-recommendations-correctness-design.md`

## Global Constraints

- Package manager is **pnpm 9.15.0**; Node **22**. Use `pnpm --filter <pkg>` per package.
- `pnpm test` from the repo root must be GREEN at every commit.
- Tests must never make network calls.
- Migrations are generated with `pnpm --filter @tokenops/api db:generate`, never hand-written into `drizzle/`.
- Conventional Commits. End every commit body with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Relative TypeScript imports carry `.js` extensions.
- **Ledger totals must not change.** Un-folding cache tokens is additive detail, never a redefinition of `inputTokens + outputTokens`. This is the one silent-failure risk in the plan.

## Reference: current shapes (verified, do not re-derive)

```ts
// packages/shared/src/schema/event.ts
UsageFeaturesSchema = z.object({
  promptChars: z.number(), responseChars: z.number(), messageCount: z.number(),
  codeFenceCount: z.number(), largePasteScore: z.number(), fileDumpScore: z.number(),
  modelTier: ModelTierSchema, newContentRatio: z.number().optional(),
});
UsageEventSchema = z.object({
  eventId, timestamp, machineId, machineName, app, provider, model,
  inputTokens, outputTokens, costUsd: z.number().nullable(),
  latencyMs?, sessionId?, features, hasContent, content?,
});

// packages/shared/src/rules/index.ts
export function runRules(event: UsageEvent, sessionContext?: UsageEvent[]): RuleHit[]
// calls checkFrontierTrivial(event), checkFullDocumentIo(event), checkContextBloat(event, sessionContext)

// apps/api/src/services/rules-runner.ts:56
dedupeKey: event.eventId   // ← one recommendation row per event
```

---

### Task 1: Event grain, optional features, and the rule gate

**Files:**
- Modify: `packages/shared/src/schema/event.ts`
- Modify: `packages/shared/src/rules/index.ts`
- Test: `packages/shared/src/rules/rules.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const EventGrainSchema = z.enum(["request", "aggregate"]);
  export type EventGrain = z.infer<typeof EventGrainSchema>;
  // UsageEventSchema gains: grain: EventGrainSchema.optional()  (absent ⇒ "request")
  // UsageFeaturesSchema: promptChars, responseChars, messageCount, codeFenceCount,
  //   largePasteScore, fileDumpScore all become .optional()
  export function isAggregate(event: UsageEvent): boolean;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/rules/rules.test.ts`:

```ts
describe("grain gating", () => {
  const trivialFrontier = {
    eventId: "e1", timestamp: "2026-08-05T12:00:00.000Z",
    machineId: "m1", machineName: "desktop", app: "claude-code",
    provider: "anthropic", model: "claude-opus-5[1m]",
    inputTokens: 86, outputTokens: 0, costUsd: null, hasContent: false,
    features: { modelTier: "frontier" as const, messageCount: 1, largePasteScore: 0,
                promptChars: 0, responseChars: 0, codeFenceCount: 0, fileDumpScore: 0 },
  };

  it("runs per-request rules on a request event", () => {
    const hits = runRules({ ...trivialFrontier, grain: "request" } as never);
    expect(hits.map((h) => h.ruleId)).toContain("frontier_trivial");
  });

  it("treats a missing grain as request, for pre-existing producers", () => {
    const hits = runRules(trivialFrontier as never);
    expect(hits.map((h) => h.ruleId)).toContain("frontier_trivial");
  });

  it("runs NO per-request rule on an aggregate event with identical numbers", () => {
    const hits = runRules({ ...trivialFrontier, grain: "aggregate" } as never);
    expect(hits).toEqual([]);
  });

  it("accepts an event whose per-request features are absent", () => {
    const { features, ...rest } = trivialFrontier;
    const parsed = UsageEventSchema.safeParse({
      ...rest, grain: "aggregate", features: { modelTier: "frontier" },
    });
    expect(parsed.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm --filter @tokenops/shared test -- rules`

Expected: the aggregate test FAILS (a hit is returned), and the absent-features parse FAILS (required fields).

- [ ] **Step 3: Add grain and relax features**

In `packages/shared/src/schema/event.ts`:

```ts
export const EventGrainSchema = z.enum(["request", "aggregate"]);
export type EventGrain = z.infer<typeof EventGrainSchema>;
```

Add to `UsageEventSchema`:

```ts
  /**
   * How this event was derived. Absent means "request" — every producer except
   * the OTEL receiver emits per-request records.
   */
  grain: EventGrainSchema.optional(),
```

Make `promptChars`, `responseChars`, `messageCount`, `codeFenceCount`,
`largePasteScore`, and `fileDumpScore` `.optional()`. Leave `modelTier`
required — it derives from the model name, which every producer has.

- [ ] **Step 4: Gate the rules in one place**

In `packages/shared/src/rules/index.ts`:

```ts
/** Aggregate events are time-bucketed sums, not requests. */
export function isAggregate(event: UsageEvent): boolean {
  return event.grain === "aggregate";
}

export function runRules(event: UsageEvent, sessionContext?: UsageEvent[]): RuleHit[] {
  // Enforced HERE, not in each rule: a new per-request rule must opt in to
  // aggregates deliberately rather than remember to opt out. Every existing
  // rule reads features that an aggregate cannot have.
  if (isAggregate(event)) return [];

  const hits: RuleHit[] = [];
  const frontier = checkFrontierTrivial(event);
  if (frontier) hits.push(frontier);
  const fullDoc = checkFullDocumentIo(event);
  if (fullDoc) hits.push(fullDoc);
  const bloat = checkContextBloat(event, sessionContext);
  if (bloat) hits.push(bloat);
  return hits;
}
```

Then fix the three rules to tolerate absent features — each currently reads
fields that are now optional. Use explicit guards (`if (features.messageCount
== null) return null;`) rather than `?? 0`: a missing value must not be read as
a satisfying zero, which is the exact bug this plan exists to fix.

- [ ] **Step 5: Run tests and the full suite**

Run: `pnpm --filter @tokenops/shared test -- rules` then `pnpm test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/schema/event.ts packages/shared/src/rules/index.ts packages/shared/src/rules/rules.test.ts packages/shared/src/rules/*.ts
git commit -m "feat(shared): gate per-request rules on event grain

An OTEL-derived event is a time-bucketed aggregate: claude_code.token.usage
carries only type and model, so no request exists in that stream. Every
existing rule reads per-request features, so all three now refuse aggregates —
enforced in runRules so a future rule opts out by default.

Per-request features become optional so producers can omit rather than
fabricate them. Rules guard on absence explicitly: a missing value read as
zero is precisely the bug this fixes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: OTEL adapter stops fabricating, preserves cache

The highest-risk task: it touches how every Claude Code event is built.

**Files:**
- Modify: `apps/agent/src/adapters/claude-otel.ts` (~lines 213-260)
- Modify: `packages/shared/src/schema/event.ts` (cache fields)
- Test: `apps/agent/src/adapters/claude-otel.test.ts`

**Interfaces:**
- Consumes: `EventGrain` (Task 1)
- Produces: `UsageEventSchema` gains `cacheReadTokens: z.number().nonnegative().optional()` and `cacheCreationTokens: z.number().nonnegative().optional()`

- [ ] **Step 1: Write the failing tests**

Add to `apps/agent/src/adapters/claude-otel.test.ts`:

```ts
it("marks OTEL-derived events as aggregate", () => {
  const events = emitFromFixture();   // existing helper in this file
  expect(events.every((e) => e.grain === "aggregate")).toBe(true);
});

it("does not fabricate per-request features", () => {
  const [e] = emitFromFixture();
  expect(e!.features.promptChars).toBeUndefined();
  expect(e!.features.messageCount).toBeUndefined();
  expect(e!.features.largePasteScore).toBeUndefined();
  expect(e!.features.modelTier).toBeDefined();   // derivable from the model name
});

it("reports cache tokens separately", () => {
  const [e] = emitFromFixtureWithCache({ input: 10, cacheRead: 90, cacheCreation: 5, output: 20 });
  expect(e!.cacheReadTokens).toBe(90);
  expect(e!.cacheCreationTokens).toBe(5);
});

it("keeps ledger totals identical after un-folding cache", () => {
  // inputTokens must still include cache, so no historical spend figure moves.
  const [e] = emitFromFixtureWithCache({ input: 10, cacheRead: 90, cacheCreation: 5, output: 20 });
  expect(e!.inputTokens).toBe(105);        // 10 + 90 + 5, exactly as before
  expect(e!.inputTokens + e!.outputTokens).toBe(125);
});
```

> Read the existing test file first and reuse its fixture helpers rather than
> inventing new ones; adapt these names to what is actually there.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm --filter @tokenops/agent test -- claude-otel`

Expected: FAIL — no `grain`, features present, no cache fields.

- [ ] **Step 3: Add cache fields to the schema**

In `packages/shared/src/schema/event.ts`, add to `UsageEventSchema`:

```ts
  /** Cache tokens, reported separately. Still counted inside inputTokens. */
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheCreationTokens: z.number().nonnegative().optional(),
```

- [ ] **Step 4: Rewrite the emit block**

In `claude-otel.ts`, in the per-model loop: keep `inputTokens` summing
`bucket.input + bucket.cacheRead + bucket.cacheCreation` **unchanged** — that
is what preserves the ledger — and additionally set `cacheReadTokens` and
`cacheCreationTokens`. Then delete the synthetic `requestMessages` and the
`extractFeatures` call, replacing features with:

```ts
      // No requestMessages: OTEL gives token counters, not prompts. Deriving
      // promptChars/messageCount/largePasteScore from a placeholder string is
      // what made frontier_trivial fire on export windows. modelTier is real —
      // it comes from the model name.
      const features = { modelTier: modelTierFor(model) };
```

Use whatever the existing tier helper is named in `packages/shared/src/model-tier.ts`.

Set `grain: "aggregate"` on the emitted event.

- [ ] **Step 5: Run tests and the full suite**

Run: `pnpm --filter @tokenops/agent test -- claude-otel` then `pnpm test`

Expected: PASS. If any other test asserted on the fabricated features, it was
asserting on fiction — update it and say so in your report.

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/adapters/claude-otel.ts packages/shared/src/schema/event.ts apps/agent/src/adapters/claude-otel.test.ts
git commit -m "fix(agent): stop fabricating features in the OTEL adapter

extractFeatures was fed a synthetic message, so promptChars, messageCount and
largePasteScore described a placeholder string — and frontier_trivial's
conditions were satisfied by that fiction rather than by real usage.

Cache tokens are now reported separately instead of only being folded away.
inputTokens still includes them, so no ledger total moves.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Pricing for the models actually in use

**Files:**
- Modify: `packages/shared/src/pricing.ts`
- Modify: `packages/shared/src/rules/frontier-trivial.ts`
- Test: `packages/shared/src/pricing.test.ts`

**Interfaces:**
- Produces: `export function cheaperSiblingModel(model: string): string | null;`

- [ ] **Step 1: Write the failing tests**

```ts
it("prices the Claude 5 family, including the 1m-context variant", () => {
  expect(estimateCostUsd("claude-opus-5[1m]", 1_000_000, 0)).toBeGreaterThan(0);
  expect(estimateCostUsd("claude-sonnet-5", 1_000_000, 0)).toBeGreaterThan(0);
});

it("suggests a cheaper model from the SAME vendor", () => {
  expect(cheaperSiblingModel("claude-opus-5[1m]")).toMatch(/claude/);
  expect(cheaperSiblingModel("gpt-4o")).toMatch(/gpt/);
});

it("returns null rather than a wrong number for an unknown model", () => {
  expect(estimateCostUsd("totally-made-up-model", 1000, 1000)).toBeNull();
  expect(cheaperSiblingModel("totally-made-up-model")).toBeNull();
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm --filter @tokenops/shared test -- pricing`

Expected: FAIL — `claude-opus-5[1m]` prices to null; `cheaperSiblingModel` undefined.

- [ ] **Step 3: Add prices and the sibling helper**

Add Claude 5 entries to the price table. Match the existing matching strategy in
`pricing.ts` (read it — entries like `claude-opus-4` suggest prefix matching, so
`claude-opus-5[1m]` must resolve). Then add `cheaperSiblingModel`, mapping
within a family: Opus → Sonnet, Sonnet → Haiku, GPT-4o → GPT-4o-mini. Return
null when the vendor is unknown.

- [ ] **Step 4: Use it in the rule**

In `frontier-trivial.ts:26`, replace the hardcoded `"gpt-4o-mini"` with
`cheaperSiblingModel(event.model)`, and return `null` from the rule when there
is no sibling — cross-vendor advice is not actionable and must not be emitted.
Name the suggested model in the `detail` string so the card says what to switch to.

- [ ] **Step 5: Run and commit**

Run: `pnpm test`

```bash
git add packages/shared/src/pricing.ts packages/shared/src/pricing.test.ts packages/shared/src/rules/frontier-trivial.ts
git commit -m "fix(shared): price the Claude 5 family and compare in-vendor

Every recommendation card showed a blank cost because claude-opus-5[1m] was
not in the price table. Savings also compared against a hardcoded gpt-4o-mini,
which a Claude Code user cannot switch a call to.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Materiality floor

**Files:**
- Create: `packages/shared/src/rules/materiality.ts`
- Modify: `packages/shared/src/rules/index.ts`
- Test: `packages/shared/src/rules/materiality.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MIN_WASTED_USD = 0.01;
  export const MIN_WASTED_TOKENS = 5_000;
  export function isMaterial(hit: RuleHit): boolean;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("drops a finding worth 89 tokens and no known cost", () => {
  expect(isMaterial({ ...base, estimatedWastedTokens: 89, estimatedWastedUsd: null })).toBe(false);
});
it("keeps a finding above the token floor when cost is unknown", () => {
  expect(isMaterial({ ...base, estimatedWastedTokens: 50_000, estimatedWastedUsd: null })).toBe(true);
});
it("prefers cost when it is known", () => {
  expect(isMaterial({ ...base, estimatedWastedTokens: 10, estimatedWastedUsd: 5 })).toBe(true);
  expect(isMaterial({ ...base, estimatedWastedTokens: 999_999, estimatedWastedUsd: 0.0001 })).toBe(false);
});
```

> The last case is the important one: once cost is known it governs, so a huge
> token count that is genuinely cheap does not surface.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm --filter @tokenops/shared test -- materiality`

- [ ] **Step 3: Implement, and filter in `runRules`**

Implement `isMaterial` per the tests, then filter in `runRules` before
returning: `return hits.filter(isMaterial);`

- [ ] **Step 4: Run and commit**

Run: `pnpm test`

```bash
git add packages/shared/src/rules/materiality.ts packages/shared/src/rules/materiality.test.ts packages/shared/src/rules/index.ts
git commit -m "feat(shared): drop immaterial findings

An 89-token finding is noise. Cost governs when known, tokens otherwise.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Aggregate rules

The rules that make the panel useful for OTEL users. These evaluate over a
window per model, not per event.

**Files:**
- Create: `packages/shared/src/rules/aggregate/frontier-share.ts`
- Create: `packages/shared/src/rules/aggregate/cache-efficiency.ts`
- Create: `packages/shared/src/rules/aggregate/index.ts`
- Create: `packages/shared/src/rules/aggregate/aggregate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ModelWindowTotals = {
    model: string; modelTier: ModelTier;
    inputTokens: number; outputTokens: number;
    cacheReadTokens: number | null; cacheCreationTokens: number | null;  // null = never recorded
    costUsd: number | null;
  };
  export type AggregateWindow = { start: string; end: string; byModel: ModelWindowTotals[] };
  export function runAggregateRules(w: AggregateWindow): RuleHit[];
  export const FRONTIER_SHARE_THRESHOLD = 0.8;
  export const CACHE_EFFICIENCY_MIN_READ_RATIO = 0.5;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
const window = (byModel: ModelWindowTotals[]): AggregateWindow => ({
  start: "2026-07-29T00:00:00.000Z", end: "2026-08-05T00:00:00.000Z", byModel,
});

it("flags a token mix dominated by frontier models", () => {
  const hits = runAggregateRules(window([
    { model: "claude-opus-5[1m]", modelTier: "frontier", inputTokens: 120_000_000,
      outputTokens: 2_000_000, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 900 },
    { model: "claude-haiku-4-5", modelTier: "small", inputTokens: 28_000,
      outputTokens: 800, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.1 },
  ]));
  const hit = hits.find((h) => h.ruleId === "frontier_share");
  expect(hit).toBeDefined();
  expect(hit!.detail).toMatch(/9\d%/);          // states the actual share
  expect(hit!.detail).toMatch(/claude/i);       // names an in-vendor alternative
});

it("stays silent on a balanced mix", () => {
  const hits = runAggregateRules(window([
    { model: "claude-opus-5[1m]", modelTier: "frontier", inputTokens: 10_000, outputTokens: 1_000,
      cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 1 },
    { model: "claude-sonnet-5", modelTier: "mid", inputTokens: 90_000, outputTokens: 9_000,
      cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 1 },
  ]));
  expect(hits.find((h) => h.ruleId === "frontier_share")).toBeUndefined();
});

it("flags poor cache reuse", () => {
  const hits = runAggregateRules(window([
    { model: "claude-opus-5[1m]", modelTier: "frontier", inputTokens: 1_000_000, outputTokens: 50_000,
      cacheReadTokens: 10_000, cacheCreationTokens: 5_000, costUsd: 90 },
  ]));
  expect(hits.find((h) => h.ruleId === "cache_efficiency")).toBeDefined();
});

it("is silent about cache when the fields are absent, not reporting 0%", () => {
  // Pre-migration events have no cache breakdown. Silence, not a false finding.
  const hits = runAggregateRules(window([
    { model: "claude-opus-5[1m]", modelTier: "frontier", inputTokens: 1_000_000, outputTokens: 50_000,
      cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 90 },
  ]));
  expect(hits.find((h) => h.ruleId === "cache_efficiency")).toBeUndefined();
});
```

> The last test is the subtle one. Zero cache tokens is indistinguishable from
> "this event predates cache reporting", so the rule must not fire on all-zero
> cache data. Distinguish absent from zero however the totals are built —
> summing `undefined` as 0 destroys that distinction, so carry an explicit
> "cache data present" signal.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm --filter @tokenops/shared test -- aggregate`

- [ ] **Step 3: Implement both rules**

`frontier_share`: sum tokens across models, compute the frontier fraction, fire
above `FRONTIER_SHARE_THRESHOLD`. `detail` must state the actual percentage and
name a cheaper in-vendor sibling via `cheaperSiblingModel` from Task 3.
`estimatedWastedTokens` is the frontier token count; `estimatedWastedUsd` is
frontier cost minus the same tokens priced at the sibling, when both price.

`cache_efficiency`: fire when cache data is present and
`cacheReadTokens / inputTokens < CACHE_EFFICIENCY_MIN_READ_RATIO` on a model
whose input volume clears the materiality floor.

Add `"frontier_share"` and `"cache_efficiency"` to `RuleId` in `rules/types.ts`.

- [ ] **Step 4: Run and commit**

Run: `pnpm test`

```bash
git add packages/shared/src/rules/aggregate packages/shared/src/rules/types.ts
git commit -m "feat(shared): add rules answerable from aggregates

Per-request rules cannot run on OTEL data, which would leave OTEL-only users
with an empty panel. These evaluate a window per model instead.

cache_efficiency stays silent when cache fields are absent rather than
reporting 0% — pre-migration events have no breakdown, and a false finding is
what this whole change is fixing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Run aggregate rules in the API, and clear the bogus rows

**Files:**
- Create: `apps/api/src/jobs/aggregate-rules.ts`
- Create: `apps/api/src/jobs/aggregate-rules.test.ts`
- Modify: `apps/api/src/services/events-repo.ts` (window totals query)
- Modify: `apps/api/src/index.ts` (schedule)

**Interfaces:**
- Consumes: `runAggregateRules`, `AggregateWindow` (Task 5)
- Produces: `export async function runAggregateRulesForUser(repo, userId, now): Promise<number>`; `EventsRepo` gains `modelWindowTotals(userId, sinceIso, untilIso): Promise<ModelWindowTotals[]>`

- [ ] **Step 1: Write the failing test**

Using the in-memory events repo, seed events across two models, run
`runAggregateRulesForUser`, and assert exactly one `frontier_share`
recommendation exists. Run it twice and assert it is still exactly one — the
dedupe key must be stable per window.

```ts
it("emits one card per rule per window, not one per run", async () => {
  const repo = createMemoryEventsRepo();
  await seedSkewedUsage(repo, "user-a");
  await runAggregateRulesForUser(repo, "user-a", new Date("2026-08-05T12:00:00Z"));
  await runAggregateRulesForUser(repo, "user-a", new Date("2026-08-05T13:00:00Z"));
  const recs = await repo.listRecommendations("user-a", "open");
  expect(recs.filter((r) => r.ruleId === "frontier_share")).toHaveLength(1);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm --filter @tokenops/api test -- aggregate-rules`

- [ ] **Step 3: Implement**

Add `modelWindowTotals` to both repo implementations, summing per model over
the window and returning whether cache fields were present. Then the job:
compute the window (7 days ending now, truncated to the day so the dedupe key
is stable within a day), call `runAggregateRules`, and upsert each hit with
`dedupeKey = \`${hit.ruleId}|${windowStart}\`` — **not** an event id.

Schedule it alongside the existing hourly `expire-content` job in
`apps/api/src/index.ts`; follow that job's pattern exactly.

- [ ] **Step 4: Clear the bogus recommendations**

Write `apps/api/scripts/clear-stale-recommendations.mjs`, following the shape
of the existing `apps/api/scripts/` tooling: delete `recommendations` rows
whose `rule_id` is a per-request rule and whose linked event has
`grain = 'aggregate'` — or, simpler and sufficient here, all currently-open
`frontier_trivial` rows, since every one of them is known bogus.

**Delete, do not dismiss.** Dismissal records a user judgement that never happened.

Print the count before and after. Do not run it against production in this
task — that is a deploy step.

- [ ] **Step 5: Run and commit**

Run: `pnpm test`

```bash
git add apps/api/src/jobs apps/api/src/services/events-repo.ts apps/api/src/index.ts apps/api/scripts/clear-stale-recommendations.mjs
git commit -m "feat(api): evaluate aggregate rules on a schedule

Dedupe key is rule+window, so a card is emitted once per window rather than
once per run — the per-event dedupe key is what produced 25 identical cards.

Adds a script to delete the bogus frontier_trivial rows. Delete, not dismiss:
dismissal records a user judgement that never happened.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md`, then regenerate `README.html`

- [ ] **Step 1: Correct the recommendations documentation**

The README describes "three rule-based recommendations". There are now five, in
two classes. Document which rules need per-request capture (the proxy or the
Claude Code JSONL adapter) and which work from OTEL aggregates — a user whose
only path is OTEL should understand why the per-request rules never fire for
them, rather than assuming the feature is broken.

- [ ] **Step 2: Document the cache fields**

`cacheReadTokens` / `cacheCreationTokens` are new in the event schema. Note
that they are additionally counted inside `inputTokens`, so ledger totals are
unchanged.

- [ ] **Step 3: Regenerate and commit**

Run: `node scripts/build-doc-html.mjs README.md README.html` then `pnpm test`

```bash
git add README.md README.html
git commit -m "docs: two classes of recommendation rule, and cache token fields

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Deploy steps

Not part of the plan's tasks; do these after merge.

1. Deploy API and agent together — the agent emits `grain`, the API gates on it.
2. Run `clear-stale-recommendations.mjs` against production. Expect 25 deleted.
3. **Verify ledger totals are unchanged**: compare `sum(input_tokens + output_tokens)` before and after the agent update. Any movement means the cache un-folding changed a total, and must be investigated before it propagates into daily aggregates.
4. Wait one window, then confirm `frontier_share` appears with a real percentage and a real dollar figure.

## Post-merge follow-ups

- Aggregate recommendation cards once real findings accumulate
- Prune sent outbox rows; add an indexed timestamp column for `local-stats`
- Per-request Claude Code capture via the JSONL adapter, for users who want the per-request rules
