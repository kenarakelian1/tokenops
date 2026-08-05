# Recommendations correctness — design

**Date:** 2026-08-05
**Status:** Approved, not yet implemented

## Problem

The Recommendations panel shows 25 open cards. All are the same rule. Together
they claim 1,910 tokens of waste, and **not one carries a cost estimate**:

```
frontier_trivial | claude-code | claude-opus-5[1m] | in=0  out=86  | usd=NULL
frontier_trivial | claude-code | claude-opus-5[1m] | in=86 out=0   | usd=NULL
frontier_trivial | claude-code | claude-opus-5[1m] | in=1  out=7   | usd=NULL
```

`in=0, out=86` is not a request. It is one OTLP export window in which only the
output counter moved. The same is true of `in=86, out=0`.

Meanwhile the account's real usage is **122,758,978 tokens on
`claude-opus-5[1m]` across 261 events**. Nothing about that is trivial. The
panel is reporting on metric plumbing.

Three defects stack, and only the first is fundamental.

### The OTEL stream contains no requests

`claude_code.token.usage` carries exactly two attributes — `type`
(`input`/`output`/`cacheRead`/`cacheCreation`) and `model`
(`apps/agent/src/adapters/claude-otel.ts:5`). There is no session id, no
request id, nothing identifying a turn. The adapter buckets by model and sums
the four types (`:163-200`), then emits one event per model per export window.

So an OTEL-derived event is a **time-bucketed aggregate by construction**.
"Was this request small?" is not a question the data can answer, and no amount
of better bucketing changes that.

### The adapter fabricates the features rules depend on

Worse than absent data: the adapter *manufactures* it. `extractFeatures` is
called with a synthetic message (`claude-otel.ts:~245`):

```ts
requestMessages: [
  { role: "user", content: `[otel] claude_code.token.usage model=${model}` },
]
```

So `promptChars`, `messageCount`, and `largePasteScore` describe a placeholder
string. `frontier_trivial` requires `messageCount <= 2`, `largePasteScore <
0.3`, and `totalTokens <= 200` — the invented features satisfy the first two
unconditionally, and a small export window satisfies the third. The rule is not
misjudging usage; it is reading fiction.

### Nothing is priced, and the advice is cross-vendor

`estimateCostUsd` returns null for `claude-opus-5[1m]` — `pricing.ts` has
`claude-opus-4`, `claude-sonnet-4`, and `claude-haiku`. Hence "—" on every
card. And `frontier-trivial.ts:26` computes savings against a hardcoded
`gpt-4o-mini`, which a Claude Code user cannot switch an individual call to.

## Decision

Make provenance explicit, stop inventing features, preserve the cache
breakdown, and add rules that are answerable from aggregates.

### Non-goals

- **Aggregating recommendation cards.** With the correctness fix the 25 bogus
  cards go to zero, and the new aggregate rules emit one card per window per
  model — so there is nothing left to group. Grouping is worth doing against
  real accumulated findings, not designed blind now.
- **Reconstructing requests from OTEL.** The attributes do not exist. The
  per-request path for Claude Code is the JSONL adapter.
- **Backfilling history.** Cache tokens were folded into input irreversibly at
  the agent; past events cannot be recovered.

## Design

### 1. Provenance on every event

`UsageEvent` gains a discriminator:

```ts
/** How this event was derived. Rules must not assume request semantics for aggregates. */
export type EventGrain = "request" | "aggregate";
```

| Source | Grain |
|--------|-------|
| OpenAI-compatible proxy | `request` |
| Claude Code JSONL adapter | `request` |
| Claude Code OTEL receiver | `aggregate` |

Defaulting: events without the field are treated as `request`, matching every
pre-existing producer except OTEL. The OTEL adapter is the only one that must
set it explicitly.

### 2. Stop fabricating features

The OTEL adapter no longer synthesises `requestMessages`. `promptChars`,
`messageCount`, and `largePasteScore` become **absent** rather than invented,
which requires making them optional in `EventFeatures`. `modelTier` stays — it
is derived from the model name, which OTEL genuinely provides.

Absent-and-honest beats present-and-wrong: a rule that reads a fabricated zero
cannot tell it apart from a real one.

### 3. Per-request rules refuse aggregates

`frontier_trivial`, `full_document_io`, and `context_bloat` all encode
per-request assumptions. Each returns `null` for `grain === "aggregate"`.

This is enforced once, in `runRules`, rather than repeated in each rule — a
new per-request rule must opt out of aggregates by default, not remember to.

### 4. Preserve the cache breakdown

`UsageEvent` gains `cacheReadTokens` and `cacheCreationTokens` (both optional,
defaulting to 0). The OTEL adapter stops folding them into `inputTokens`
(`claude-otel.ts:226-228`) and reports them separately.

**Ledger totals must not change.** Cost and token displays that previously
summed folded input keep summing the same quantity — the breakdown is
additional detail, not a re-definition. This is the highest-risk part of the
change: getting it wrong silently alters every historical spend figure.

### 5. Two aggregate rules

Both evaluate over a window (default 7 days) per model, not per event, and emit
at most one recommendation each per window.

**`frontier_share`** — what fraction of tokens went to frontier-tier models.
For this account it would read roughly: 122M Opus against 44M Sonnet and 29K
Haiku. Actionable in the way the current rule only pretends to be: route
routine work to a smaller model in the same family.

**`cache_efficiency`** — ratio of cache reads to fresh input. For a Claude Code
user this is the dominant cost lever, and today the information is discarded
before it reaches the cloud. Only meaningful once §4 lands.

### 6. Materiality floor

Rules emit nothing below a minimum. Expressed in estimated USD where a price
exists, falling back to tokens where it does not. An 89-token finding never
surfaces again.

### 7. Real pricing, in-vendor comparison

Add the Claude 5 family to `pricing.ts`. Savings compare against the **cheapest
model of the same vendor family** rather than a hardcoded `gpt-4o-mini`:
Opus → Sonnet or Haiku, GPT-4o → GPT-4o-mini. Cross-vendor advice is not
actionable and should never be generated.

## Migration

- The 25 existing `frontier_trivial` rows are wrong and must be deleted, not
  dismissed — dismissal implies the user judged them.
- Already-ingested events keep cache folded into input. Historical cache ratios
  are unrecoverable; `cache_efficiency` reports only on windows after deploy.
- Ledger totals must be identical before and after. Verify against production
  aggregates rather than assuming.

## Testing

- **Grain**: an aggregate event produces no hits from any per-request rule; a
  request event with identical numbers still does.
- **No fabrication**: OTEL-derived events have absent, not zeroed,
  `promptChars`/`messageCount`/`largePasteScore`.
- **Ledger invariance**: for a fixture OTLP payload, `inputTokens +
  outputTokens` after the change equals the total before it.
- **Floor**: a finding below the threshold emits nothing; one above emits once.
- **Pricing**: `claude-opus-5[1m]` prices; savings compare in-vendor; an unknown
  model yields null rather than a wrong number.
- **Aggregate rules**: `frontier_share` fires on a skewed mix and stays silent
  on a balanced one; `cache_efficiency` fires on a poor ratio, and is silent
  when cache fields are absent (pre-migration events) rather than reporting 0%.

## Risks

- **Ledger drift** from §4 is the one that would matter and be hard to notice.
  Pin it with a test, and verify against production totals.
- **An empty panel** immediately after deploy is expected: the account's only
  capture path is OTEL, and the proxy has no upstream key. `frontier_share`
  should fill it within one window.
- **Optional features** ripple into any code assuming those fields exist.

## Follow-ups

- Aggregating recommendation cards once real findings accumulate
- Pruning sent outbox rows, and an indexed timestamp column for `local-stats`
- Per-request Claude Code capture via the JSONL adapter, for users who want the
  per-request rules back
