# Session-grain recommendation rules — design

**Date:** 2026-08-11
**Status:** Approved design. Implementation not started.
**Supersedes the conclusion of:** `docs/claude-code-cost-findings.md` (see "Correction" below)

## Why this exists

TokenOps' five rules produce roughly **24 findings from 14,546 turns** of real
Claude Code usage. That is not a tuning problem. The rules encode API-traffic
advice — pick a cheaper model, send excerpts instead of whole documents, trim
conversation history — and a coding agent violates all three premises. The
adapter that feeds them is accurate; the rules are aimed at a workload that
does not exist here.

This design replaces them with rules fitted to the measured workload.

## Correction to the prior findings

`docs/claude-code-cost-findings.md` named cache creation "the single largest
addressable line item." Measured per session, that is wrong.

| slice | share of consumption |
|---|---:|
| top 1 session | 19.6% |
| top 5 sessions | 55.7% |
| **top 10 sessions** | **80.1%** |
| top 25 sessions | 91.0% |

The ten sessions that make up 80% of consumption have cache-churn shares of
13–33% — **below** the 45.4% median. The 90 sessions above 45% churn are
together only **8.2% of burn**. Cache churn is 29.7% of the input bill in
aggregate because it is concentrated in *cheap* sessions. Optimizing it first
would have optimized the part that does not hurt.

The expensive sessions are expensive because they are long and never reset:

| context band | % of turns | **% of all cache-read tokens** |
|---|---:|---:|
| 0–100k | 21.3% | 4.1% |
| 100–200k | 21.9% | 9.0% |
| 200–400k | 18.6% | 15.7% |
| 400–600k | 17.1% | 24.3% |
| **600k+** | **21.1%** | **46.9%** |

A fifth of turns consume nearly half of all cache reads. Holding context at
300k would have cut cache-read tokens **39.3%**, and cache reads are 70.3% of
the input bill. That is roughly 4× the entire churn opportunity.

**Measurement basis:** `~/.claude/projects`, 190 session files modified in the
trailing 7 days as of 2026-08-11, 13,766 API responses deduplicated by
`message.id`, 180 sessions of ≥5 turns. Consumption units are
`creation×1.25 + read×0.10 + output×5.00`, the cache-aware effective-token
weighting.

## What the rules optimize

Rules compute in **tokens**. Currency is a rendering decision, not a rule
decision: the same waste is one number in two currencies, and a subscription
user's constraint is limit headroom while an API user's is dollars. Making the
engine token-native keeps TokenOps useful to both without duplicating rules.

Cards render **tokens as the primary figure** and `≈ $X API-equivalent` as
secondary. There is deliberately no billing-mode setting: a toggle adds
persistence, config surface, and a failure mode to buy a label change. It can
be layered on later without touching the rules.

## The rule set

### `session_context_ceiling` — severity `warn`

Fires when a session's turns above a target context size carried material
cache-read tokens.

**Constants** (exported from the rule module):

```ts
export const SESSION_CONTEXT_TARGET_TOKENS = 300_000;  // a CONTEXT_BAND_EDGES value
export const SESSION_MIN_TURNS = 20;
```

`SESSION_CONTEXT_TARGET_TOKENS` must be one of `CONTEXT_BAND_EDGES`. The
histogram can only sum at band boundaries, so a target between edges would
require interpolating — an estimate presented as an exact sum.

**Derivation from the rollup.** Let `i` be the index of the target in
`CONTEXT_BAND_EDGES`:

```
turnsAbove = sum(turnsByContextBand[i..])
readsAbove = sum(cacheReadByContextBand[i..])
```

**Actual** (only the above-target turns; output and cache creation are set
equal on both sides so they cancel out of the subtraction):

```
{ model: dominantModel,
  inputTokens: readsAbove,
  outputTokens: 0,
  cacheReadTokens: readsAbove,
  cacheCreationTokens: 0 }
```

**Counterfactual** (the same turns, each reading exactly the target):

```
{ model: dominantModel,
  inputTokens: SESSION_CONTEXT_TARGET_TOKENS * turnsAbove,
  outputTokens: 0,
  cacheReadTokens: SESSION_CONTEXT_TARGET_TOKENS * turnsAbove,
  cacheCreationTokens: 0 }
```

Savings therefore reduce to
`(readsAbove − target × turnsAbove) × cacheReadPrice`.

**Known conservatism.** A turn in the 300–400k band has context ≥ 300k but
cache *reads* slightly below it, since part of its input is cache creation.
`target × turnsAbove` can therefore marginally exceed that band's actual
reads. The effect pushes savings **down**, and `priceCounterfactual` already
clamps at zero. Understating is the correct direction for a bound; do not
"fix" it by inflating the counterfactual.

**Assumption string** (rendered as `Assumes: {assumption}`, clause only, no
leading "Assumes"):

```
resetting context at this size would not have required re-doing work already in it
```

This is the claim a user may legitimately dispute — resetting costs rework —
and it belongs on the card. The rule reports a **bound, not a promise**: it
states what the above-target turns cost, not that resetting is free.

### `session_cache_churn` — severity `info`

Fires when cache creation dominates a session's input cost, meaning the cached
prefix keeps invalidating.

**Constants:**

```ts
export const SESSION_CHURN_MIN_COST_SHARE = 0.45;
export const SESSION_CHURN_BASELINE_TOKEN_SHARE = 0.026;
```

**Gate.** With `C = cacheCreationTokens`, `R = cacheReadTokens`:

```
churnCostShare = (C * 1.25) / (C * 1.25 + R * 0.10)
```

fires when `churnCostShare > SESSION_CHURN_MIN_COST_SHARE` and
`turnCount >= SESSION_MIN_TURNS`.

**Where the baseline constant comes from.** Holding total input tokens
`T = C + R` fixed, solving `1.25C / (1.25C + 0.10(T − C)) = 0.25` for the
25%-of-input-cost baseline (the measured p10 across sessions is 24.0%) gives
`C = 0.02597 T`, rounded to **0.026**. Recording the derivation here so the
constant is auditable rather than a magic number.

**Counterfactual.** Excess creation above baseline is instead read from cache;
total input tokens are preserved:

```
Actual:         { inputTokens: T, cacheReadTokens: R,          cacheCreationTokens: C,          outputTokens: 0 }
Counterfactual: { inputTokens: T, cacheReadTokens: T - T*0.026, cacheCreationTokens: T * 0.026, outputTokens: 0 }
```

**Assumption string:**

```
a stable cached prefix would have re-read this content instead of rewriting it
```

**Both rules require `cacheReadTokens !== null` and `cacheCreationTokens !==
null`.** `null` means no cache breakdown was ever recorded, and a rule that
treats it as `0` produces a confidently wrong finding. Stay silent instead.

### Deliberately not built

- **A concentration rule.** Cards already sort by savings, so
  `session_context_ceiling` surfaces the top-burn sessions on its own. A
  separate rule would restate the ranking as a finding.
- **A subagent-attribution rule.** 32.3% of responses but 11.2% of weighted
  consumption, and there is no action behind it — "use fewer subagents" is
  usually wrong advice. This is reporting, not a recommendation.
- **A burn-rate / time-to-reset projection.** Closest to the original user
  pain and worth building, but it is a forecasting subsystem rather than a
  rule. Separate spec.

### Retirement

`cache_efficiency` is retired, not retargeted. Its gate (cache-read ratio
below 0.50) cannot fire on this workload — the measured median is 0.997.
Reusing its id for churn would silently change what already-stored historical
cards meant. Retire the id; `session_cache_churn` is a new id.

`frontier_share` is kept unchanged — it is the one existing rule that
transfers, and 63% `claude-opus-5` is a real mix question.

`frontier_trivial`, `full_document_io`, and `context_bloat` are left in place
for now: they are correct for API-style traffic, which other users may have.
They simply stay silent here.

## Data shape

`SessionRollup` is a sibling of `AggregateWindow`, not a replacement.

```ts
/** Band edges owned by the rules module; the rollup builder imports them. */
export const CONTEXT_BAND_EDGES = [0, 100_000, 200_000, 300_000, 400_000, 600_000] as const;

export type SessionRollup = {
  sessionId: string;
  start: string;
  end: string;
  turnCount: number;
  /** Dominant model by consumption — what the counterfactual is priced at. */
  model: string;
  modelTier: ModelTier;
  inputTokens: number;
  outputTokens: number;
  /** null = no cache breakdown recorded; 0 = recorded and genuinely zero. */
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** Per-band sums, length === CONTEXT_BAND_EDGES.length. Index i covers [edge[i], edge[i+1]). */
  turnsByContextBand: number[];
  cacheReadByContextBand: number[];
};
```

A histogram, not a sample. Bounded regardless of session length (the largest
observed session is 1,935 turns), computable in one SQL `GROUP BY`, and "cache
reads above 300k" is an exact sum of the top bands with no percentile
estimation. Thresholds may move between band edges without re-aggregating
history.

The `number | null` discipline is carried over verbatim from
`ModelWindowTotals`: summing `null` as `0` collapses "unknown" into "checked,
and zero", which produces a wrong finding in either direction.

## Wiring

**Runner.** `runSessionRules(rollup, now, priceOverrides)` in
`packages/shared/src/rules/session/index.ts`, hand-wired the same way
`runAggregateRules` is, reusing `priceFinding` and `isMaterial` so savings
assembly stays in exactly one place.

**Job.** Dedupe key is `` `${ruleId}|${sessionId}` `` — a session is a
naturally stable key, unlike the aggregate job's window start, which advances
daily and required superseding to avoid minting a card per day. Two
differences from the aggregate job:

- Session rules emit *many* cards, one per qualifying session, not at most one
  per rule. Supersession runs per `(ruleId, sessionId)`: a session that no
  longer fires has its open card retired.
- **Open cards are capped at the top 10 sessions per rule, ranked by
  savings.** Ten is justified by the measured concentration (top 10 = 80.1% of
  burn). Per rule rather than overall, so that ceiling cards — which carry
  larger savings — cannot crowd churn cards out of the panel entirely.
- **The cap is stated in the UI**, naming how many sessions were omitted. A
  silent truncation reads as full coverage.

**Unattributed consumption.** Sidechain turns omit `sessionId` by the
adapter's design, so subagent consumption — 11.2% of the weighted total — rolls
into no session. Session rollups undercount by approximately that much. The
rollup set carries an explicit unattributed total so the panel can state it,
rather than presenting 89% of usage as 100%.

## Error handling

- A rollup with `turnCount < SESSION_MIN_TURNS` produces no finding. Short
  sessions have no reset decision to make.
- A rollup with `null` cache fields produces no finding from either rule.
- An unpriceable model yields `estimatedWastedUsd: null` with
  `estimatedWastedTokens` still populated; `isMaterial` falls back to the token
  floor, as it already does elsewhere.
- Band arrays whose length does not match `CONTEXT_BAND_EDGES` are a
  programming error in the rollup builder, not user data: throw rather than
  silently truncate.

## Testing

Per-rule unit tests: band arithmetic, `null` vs `0`, materiality floors,
threshold edges on both sides, and the pinned-assumption-string test the
existing five rules already have.

**Fixtures come from real sessions, scrubbed** via the existing
`scrub-fixture.py`, never hand-written from this spec. Hand-written fixtures
are what allowed a 2.109× double-count to sit underneath 358 green tests: every
fixture encoded the spec's assumptions rather than the data's actual shape.

**The acceptance gate is a back-test replay over real history, and it is a
requirement rather than a nice-to-have.** The rule set is done when the replay
produces a bounded, sane finding count — on the order of 10–30 cards covering
most of measured burn. Not 24 findings from 14,546 turns, which is the failure
that parked the previous branch, and not thousands. **This measurement is run
and reported before the work is called complete, whichever way it comes out.**

That is the operative lesson from the parked branch: the rules were green and
useless, and nobody measured until the end.
