# Recommendation credibility — design

**Date:** 2026-08-05
**Status:** Approved, not yet implemented

## Problem

The recommendation engine is TokenOps' only genuinely differentiated component.
Every open-source alternative — Langfuse, Helicone, Phoenix, OpenLIT — shows
cost breakdowns and stops there; none ships a prescriptive rules layer. The
closest comparables are commercial (Revenium's AI Insights, launched June 2026,
is a detector pipeline ranked by monthly savings) or noncommercially licensed
(NadirClaw, PolyForm, which *acts* on the same signals rather than reporting
them).

That lead is worth defending, and today it rests on numbers a careful user
would not trust.

### Every rule invents its own money math

Each of the five rules computes `estimatedWastedUsd` its own way. The results
are not comparable to each other, and two of them are built on undeclared
assumptions:

- `full_document_io` multiplies by a bare `0.5` — `Math.floor(inputTokens *
  fileDumpScore * 0.5)`. Nothing states what that factor represents, so the
  dollar figure it produces cannot be checked.
- `context_bloat` prorates total cost by a token ratio, which is not the same
  thing as the cost of the extra tokens.

### `cache_efficiency` cannot quote dollars at all

It hardcodes `estimatedWastedUsd: null`, and its comment explains why: "There's
no per-token cache-read price in the pricing table."

**That comment is stale.** Commit `6e90aab` added
`CACHE_READ_PRICE_MULTIPLIER = 0.1` and `CACHE_CREATION_PRICE_MULTIPLIER = 1.25`
to `estimateCostUsd` via the `CacheTokenBreakdown` option. The price exists; the
rule never picked it up. So the highest-value rule reports in tokens while
cheaper rules report in dollars — and because `isMaterial` falls back to
`MIN_WASTED_TOKENS` when USD is null, it is also being filtered by a different
standard than everything else.

### Nothing establishes that a rule is worth following

A card asserts a number for a single event or window. There is no way to ask
"what would this rule have saved me last month?", and no way to see the dollar
impact of changing a threshold. `CACHE_EFFICIENCY_MIN_READ_RATIO = 0.5` is a
guess that has never been measured against real traffic.

### Severity is decorative

`severity` is stored and rendered as a CSS class. It gates nothing and sorts
nothing, so a $0.94 finding can appear above a $23 one.

## Decision

**Rules stop computing money. They declare a counterfactual — what the request
or window would have looked like had the advice been followed — and a single
pricer turns that into dollars.**

```ts
savings = estimateCostUsd(actual) − estimateCostUsd(counterfactual)
```

Both sides go through the existing `estimateCostUsd`, including its
`CacheTokenBreakdown` option. This one change resolves all four items:
`cache_efficiency` gets USD as a consequence rather than a special case, the
back-test is the same pricer run over history, the contract becomes small enough
to publish, and ranking has a comparable number to sort on.

This is not a new idea in this codebase so much as a generalization of one.
`frontier_share` already prices its dominant model and its suggested sibling
against **the same cache breakdown**, with a comment explaining that failing to
do so inflates the sibling estimate, clamps savings to zero through
`Math.max(0, ...)`, and silently drops the only card an OTEL-only user would
see. A shared pricer makes that class of bug structurally impossible instead of
a comment future rules must remember to read.

### Capture paths

The recommendation-evidence spec decided that Claude Code capture moves from
OTEL to session JSONL, and that "OTEL is replaced, not supplemented." That is
revised here: **the OTLP receiver stays.**

The split is by source, so no request is ever captured twice:

| Source | Path | Grain |
|--------|------|-------|
| Claude Code | session JSONL adapter | request |
| Any other OTLP emitter (Codex/Gemini via a collector, custom apps) | OTLP receiver on `:4318` | aggregate |

The reasoning: reading `~/.claude/projects/**/*.jsonl` is exactly what ccusage
does, so it is the price of parity on Claude Code — but the OTLP receiver
accepts telemetry from anything that speaks OTLP, which ccusage cannot do at
all. Keeping both makes the two capture paths complementary rather than
redundant. Since they never observe the same traffic, the double-counting risk
that motivated the original "replace, not supplement" decision does not arise.

## Non-goals

- **The session-JSONL adapter itself.** It has its own approved spec
  (`2026-08-05-recommendation-evidence-design.md`), including the redaction
  design that spec calls its highest-risk component. This work is built and
  tested independently of it.
- **Shadow replay.** Re-running flagged requests against the cheaper model and
  scoring output quality would be a stronger claim, but it needs stored content,
  provider keys on the API server, and a judge model. Not now.
- **Declarative (YAML) rules.** The existing rules need session lookback and
  tri-state cache logic; a DSL expressive enough for them is a programming
  language. The typed interface is the contract.
- **New rules.** No new detector classes here. This work makes the existing five
  credible; it does not add a sixth.
- **Acting on a recommendation.** TokenOps reports; it does not route.

## Architecture

### The counterfactual

```ts
/** What this request or window would have looked like had the advice been taken. */
export type Counterfactual = {
  /** Same model when the advice concerns tokens rather than routing. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
};
```

`cacheReadTokens` / `cacheCreationTokens` keep the `number | null` semantics
established in `ModelWindowTotals`: `null` means no breakdown was recorded, `0`
means recorded and genuinely zero. The pricer must preserve that distinction —
collapsing `null` to `0` reintroduces exactly the confidently-wrong-finding
problem that branch existed to fix.

What each rule declares:

| Rule | Counterfactual | Stated assumption |
|------|----------------|-------------------|
| `frontier_trivial` | `{ model: cheaperSibling, tokens unchanged }` | A cheaper in-vendor sibling handles calls at or under 200 tokens |
| `frontier_share` | `{ model: cheaperSibling, dominant model's own tokens and cache breakdown }` | Routine work moves to the sibling; other vendors' tokens are not repriced |
| `context_bloat` | `{ same model, inputTokens: first.inputTokens }` | Context could have stayed flat across the session |
| `full_document_io` | `{ same model, inputTokens − excerpted }` | Excerpting removes half the dumped content |
| `cache_efficiency` | `{ same model, cacheReadTokens: inputTokens × MIN_READ_RATIO }` | A 50% cache-read ratio is achievable for this workload |

The `full_document_io` row is the point of the exercise. The `0.5` does not
disappear — it stops being an unexplained multiplier inside a dollar figure and
becomes a named assumption rendered on the card, where a user can disagree with
it.

`cache_efficiency` is likewise not a special case. Its counterfactual moves
tokens from the full input rate into the 0.1× cache-read rate, and the existing
multipliers price the difference. That is the whole of item 1.

### The rule contract

```ts
export interface Rule<TInput> {
  readonly id: RuleId;
  readonly grain: "request" | "aggregate";
  readonly defaultSeverity: Severity;
  evaluate(input: TInput, ctx: RuleContext): RuleFinding | null;
}

export type RuleFinding = {
  title: string;
  detail: string;
  eventIds: string[];
  counterfactual: Counterfactual;
  /** The assumption the counterfactual rests on. Shown to the user, not buried. */
  assumption?: string;
};

export type RuleContext = {
  /** Pricing instant. Callers pass the EVENT's timestamp, not wall-clock now. */
  now: Date;
  priceOverrides?: Record<string, PriceRow>;
  /** Request-grain rules only; prior events in the same session. */
  sessionContext?: UsageEvent[];
};
```

`Severity` is the existing `"info" | "warn" | "high"` union, extracted from its
current inline declaration on `RuleHit` into a named exported type — the
contract cannot be published while one of its field types is anonymous.

The runner owns pricing, materiality, and severity. A contributor writes a
predicate and a counterfactual and nothing else. `RuleHit` remains the runner's
**output** type, so the database schema and the API response shape do not move.

`grain` on the rule replaces the `isAggregate` gate currently enforced inside
`runRules`. That gate exists because every per-request rule reads features an
aggregate cannot have; making it a declared property means a new rule states its
grain rather than remembering to opt out of the wrong one.

Ships with `docs/rules/authoring.md`: the interface, a worked example rule, the
fixture-driven test harness, and an explicit statement of which types are stable
and which are internal.

### The back-test

A pure function in `packages/shared`, exposed as
`GET /v1/recommendations/backtest?window=<7d|30d|90d>`. `window` defaults to
`30d`; any other value is a 400 rather than a silent fallback, matching how the
existing recommendations route rejects an unknown `status`.

```
rule                hits   would have saved   assumption
──────────────────────────────────────────────────────────────────────
cache_efficiency       3             $23.10   50% cache-read ratio achievable
frontier_share         1             $18.30   routine work moves to sonnet-5
frontier_trivial      41              $0.94   cheaper sibling handles ≤200-token calls
```

The defining property: it **re-runs the current rules over historical events**.
It does not sum the `recommendations` table. That is what makes it a back-test
rather than a rollup, and it yields something beyond the user-facing claim —
change `CACHE_EFFICIENCY_MIN_READ_RATIO` from 0.5 to 0.6 and the dollar impact
on 30 days of real traffic is immediately visible. Threshold tuning stops being
a guess.

Aggregate-grain rules rebuild their windows through the same path the
`aggregate-rules` job already uses. Request-grain rules replay stored events
with their session context, and inherit the existing aggregate gate rather than
reimplementing it — replaying them over the OTEL-derived history would otherwise
evaluate fabricated features (`promptChars: 54`, the length of the synthetic
string `[otel] claude_code.token.usage model=...`).

**Each event is priced at its own timestamp.** `estimateCostUsd` takes `now` for
date-gated pricing, and the Claude Sonnet 5 introductory rate expires
2026-08-31. A back-test that passed wall-clock `now` would reprice August
traffic at September rates, so the same historical window would report different
savings depending on when it ran. Historical numbers must not move; this is what
makes the result reproducible.

On current production data — 712 aggregate events — the two aggregate rules
produce real figures immediately. The three request-grain rules are
fixture-covered and populate when the JSONL adapter lands.

### Ranking

`listRecommendations` orders by `estimated_wasted_usd DESC NULLS LAST,
created_at DESC`. `frontier_trivial.defaultSeverity` becomes `info`.

Severity stays declared per rule rather than derived from savings. The two are
different axes: a cheap finding can be urgent, and a threshold that maps dollars
onto severity would just be a fresh set of magic numbers. Ordering carries the
weight; severity remains a label.

One migration: add a nullable `counterfactual jsonb` column to
`recommendations`, so a card can show *"would have been `claude-haiku-4-5`,
1,200 in / 350 out"* as evidence rather than an unsourced number.

## Migration

Existing recommendation rows have no counterfactual and keep `NULL` in the new
column. The UI renders evidence when present and omits it otherwise; it must not
imply a counterfactual was computed and came back empty.

All five rules move to the new contract in one change. The pricing *inputs* do
not change — only where the arithmetic lives — so existing tests are the
regression net. The single deliberate behavior change is `cache_efficiency`
gaining USD.

## Testing

- **Per-rule counterfactual tests.** Each rule's declared counterfactual
  asserted directly, separately from its pricing.
- **`cache_efficiency` quotes USD**, with the figure pinned. This is the
  headline behavior change. The `null`-versus-`0` cache distinction is
  re-asserted; that invariant must survive the refactor.
- **Materiality boundary.** Findings just above and just below
  `MIN_WASTED_USD`, including the case described under Risks below.
- **Back-test determinism.** Identical events and rules produce identical
  output, including across the 2026-08-31 Sonnet 5 cutoff, run from both sides
  of it.
- **Grain routing.** A request-grain rule is never evaluated against an
  aggregate event, asserted through the back-test rather than only through
  `runRules`.
- **Regression net.** Existing rule suites from `#24` / `#25` pass unchanged
  wherever behavior should not move. Any suite that needs *changing* rather than
  passing is a signal to stop and re-examine, not to update the assertion.

## Risks

1. **Cards will disappear on deploy.** Today `cache_efficiency` returns `null`
   USD, so materiality falls back to `MIN_WASTED_TOKENS = 5_000`. Once it quotes
   dollars, the `MIN_WASTED_USD = 0.01` floor governs — and roughly 10k wasted
   tokens on a cheap model prices near $0.009, which passes today and fails
   after. That is the correct outcome, since such a finding is genuinely worth
   under a cent, but a live production card may vanish. Recorded here so it
   reads as intended behavior rather than a regression.
2. **Refactoring recently-stabilized code.** All five rules move at once,
   against work merged days ago. Mitigated by the regression net above and by
   keeping pricing inputs unchanged.
3. **`context_bloat` assumes the session's first request was not itself
   bloated.** If it was, savings are understated. Surfaced through `assumption`
   on the card rather than silently absorbed.
4. **Back-test cost at scale.** Trivial at 712 events, unbounded later.
   Mitigated by a window cap and on-demand computation. Not optimized further
   until there is data saying to.
5. **A counterfactual is still a model, not a measurement.** It prices real
   token counts at published rates, which is a substantially stronger claim than
   a bare multiplier, but it does not prove the cheaper path would have produced
   an acceptable answer. Only shadow replay would, and that is a non-goal here.
   The UI must keep saying **estimated**.

## Follow-ups

- Session-JSONL adapter, per its own spec — lights up the three request-grain
  rules on real data.
- Shadow replay behind an opt-in, once content capture and its 2-hour window
  exist.
- New detector classes suggested by the competitive review: `max_tokens`
  truncation (paying for answers cut mid-thought) and dormant spend.
- Once `docs/rules/authoring.md` is published, revisit whether the rule corpus
  should accept outside contributions formally — a closed competitor cannot
  match a contributed rule set, which is a more durable advantage than any
  individual rule.
