# Usage forecast — design

**Date:** 2026-08-16
**Status:** Approved design. Implementation not started.
**Scope:** Sub-project 1 of 3 (see "Decomposition" below).

## Why this exists

TokenOps was built because its author ran out of Claude Code usage three days
before the account limit reset. The v0.2.0 session-grain rules explain what a
session **cost, after the fact**. Nothing yet answers the question that caused
the problem: **am I going to make it to reset?**

## What the providers actually expose

Researched 2026-08-16 rather than assumed, because the answer determines
whether any of this has to be inferred at all.

| Source | Available? | What it gives | Applies to |
|---|---|---|---|
| `anthropic-ratelimit-*` response headers | **Yes** | limit / remaining / reset for requests, tokens, input tokens, output tokens; `retry-after` on 429 | API keys, **~1-minute windows** |
| Admin Usage & Cost API (`/v1/organizations/usage_report/messages`) | **Yes** | authoritative cumulative usage, 1m/1h/1d buckets, split by uncached / cached / creation / output | API organizations, Admin key |
| Max / Pro subscription limits | **No programmatic access** | Claude Code's own `/usage` shows session cap, weekly cap, extra balance — display only | the plan this project's author uses |

Verified locally as well: the `claude` CLI has no `usage` subcommand, and no
limit or quota state is cached anywhere under `~/.claude`. Session JSONL
carries no limit marker — `stop_reason` only ever takes `tool_use`,
`end_turn`, `stop_sequence`, or null, and every "rate limit" string in the
files is prose inside conversations.

Open upstream requests: claude-code
[#33820](https://github.com/anthropics/claude-code/issues/33820) (expose
headers to hooks and status line; closed as duplicate of #27915) and
[#44328](https://github.com/anthropics/claude-code/issues/44328)
(`claude usage --json`).

**Consequence:** for a Max subscription, any absolute quota figure would be
invented. This design never invents one.

**Two structural facts we do get for free**, and they replace guesses that
were nearly made: Max enforces a **rolling 5-hour session window** and a
**rolling 7-day window** — not a fixed monthly reset date. Both windows here
are trailing windows over event timestamps.

## Decomposition

Three subsystems share one abstraction and ship separately:

1. **Usage forecast** — this spec. Subscription pacing. `declared` and
   `inferred` provenance.
2. **Proxy rate-limit capture** — the agent's proxy already sits where
   `anthropic-ratelimit-*` / `x-ratelimit-*` headers arrive and currently
   reads only `content-type`. Adds `measured` provenance. Solves imminent
   throttling, not cycle exhaustion.
3. **Admin Usage & Cost API** — replaces estimated ledger figures with
   Anthropic's own, including the cached/uncached/creation split. Adds
   `reported` provenance.

Note for sequencing: 100% of events ever ingested by this deployment are
`app=claude-code` / `provider=anthropic`. Sub-projects 2 and 3 deliver
nothing to the current user and exist for other users.

## Provenance

Every limit and every projection carries where it came from. This is a field,
not a comment, and the UI renders it beside every number.

```ts
export type LimitProvenance = "measured" | "reported" | "declared" | "inferred";
```

| Provenance | Meaning | Authority |
|---|---|---|
| `measured` | read from a provider response header | authoritative, ~1 min |
| `reported` | returned by a provider usage API | authoritative, cumulative |
| `declared` | the user marked a real limit hit | the user's own observation |
| `inferred` | derived from the user's own history | weakest — a bound, never a fact |

A `measured` "429 in 60 seconds" and an `inferred` "you may have hit a wall in
July" must never render alike. This is the v0.2.0 card discipline — state a
bound, not a promise — applied to forecasting, and it is what makes the
inference component safe to build at all.

## Units, and why the unknown metering formula does not sink this

Anthropic does not publish what a subscription meters. This design uses the
same cache-aware weighting the rules already use:

```
units(event) = rawInput × 1.00 + cacheCreation × 1.25 + cacheRead × 0.10 + output × 5.00

  rawInput = max(0, inputTokens − cacheRead − cacheCreation)
```

It is called a **proxy** everywhere in code and UI, never "usage".

The saving grace is that the primary output is **self-relative**. "You are
consuming 2.1× your own median" holds as long as the proxy is *monotonically
related* to whatever Anthropic counts — the formula itself is not needed, only
that more consumption yields a larger number. That is a far weaker assumption
than knowing the metering, and it is the reason the no-configuration path is
honest.

Absolute claims ("you will run out Thursday") are only made against a
`declared` ceiling, never against the proxy alone.

## The projection

### Windows

Trailing **5 hours** (session) and trailing **7 days** (weekly), computed over
event timestamps. No fixed reset date, because Anthropic does not enforce one.

### Roll-out is modelled exactly

A trailing total does not simply grow at the current pace — old events leave
the window as time advances. Naive extrapolation (`current + pace × hours`)
systematically over-predicts exhaustion. The projection therefore simulates
forward:

```
trailing7d(t) = trailing7d(now)
              + pace × (t − now)                          // inflow, estimated
              − Σ units(events in [now−7d, now−7d+(t−now)]) // outflow, exact
```

The outflow term is **exact**, not estimated: those events are already in the
ledger. This is cheap and materially more accurate than extrapolation, and a
unit test must fail under the naive formula.

### Pace

Units per hour over a trailing 24 hours — shorter than the projection horizon,
so a burst registers, but long enough that one idle night does not erase it.

### Ceiling, in order of authority

1. A `declared` observation for that window kind, most recent first.
2. Otherwise the user's **own historical maximum** for that window, labelled
   `inferred`. This is defensible: a maximum you actually reached is a *lower
   bound* on your real limit.

### Output shape

With zero configuration:

> Trailing 7 days: **1.34M units** — 87% of your highest week ever (Aug 3–10).
> At the current pace you would pass that in **2.1 days**. *(inferred ceiling —
> your own historical maximum)*

After one declaration:

> Trailing 7 days: **1.34M units** — 78% of your observed limit (marked Aug 9).
> At the current pace you would reach it in **3.4 days**. *(declared ceiling)*

## Declaring a limit hit

One control: **"I just hit my limit."** It records:

```ts
type LimitObservation = {
  windowKind: "session_5h" | "weekly_7d";
  observedAt: string;      // ISO
  unitsInWindow: number;   // the trailing total at that instant
  provenance: LimitProvenance;
  status: "active" | "superseded" | "dismissed";
};
```

The most recent active observation per window kind is the ceiling. Newest
wins because limits change — Anthropic permanently doubled Claude Code's
5-hour limits on 2026-05-06 — and older observations remain visible as
history rather than being averaged into a number that describes neither
regime.

## Inferring candidate limit hits

**The inference proposes; it never decides.** This is the whole of how it
stays honest, and it is a deliberate constraint rather than an
implementation detail.

A candidate requires **all three**:

1. a zero-consumption gap of at least `CANDIDATE_MIN_GAP_HOURS = 12`,
2. immediately preceded by a trailing-7d value in the **top decile** of that
   user's own trailing-7d history,
3. falling in hours when that user's own activity pattern predicts work —
   specifically, the gap must overlap at least
   `CANDIDATE_MIN_ACTIVE_HOURS = 4` hours that sit in the top half of the
   user's observed hour-of-week activity distribution.

Clause 3 is what separates a limit hit from a weekend or a holiday. Twelve
hours is chosen to clear a night's sleep without needing clause 3 to carry
that case alone; clause 3 then excludes the quiet stretches that a fixed
threshold cannot distinguish.

These two values are starting points, not measured constants. Unlike the
rules' thresholds — which were derived from measurement — no data exists yet
to calibrate them, and the acceptance gate below is what decides whether they
survive. If they do not, the component ships disabled.

A candidate is surfaced as a question, never as a ceiling:

> *You went quiet Aug 3–6 after your heaviest stretch that week. Was that a
> usage limit?* **[Yes] [No]**

**Yes** converts it into a `declared` observation — the inference's output
becomes the declaration's input. **No** marks it `dismissed` so it is never
proposed again. Because inference cannot set a ceiling on its own, a wrong
guess costs one dismissed prompt instead of a confidently wrong forecast.

## Architecture

### `packages/shared/src/forecast/`

Pure functions over an event array. No database, no clock: `now` is always a
parameter, matching `RuleContext.now`, so replays are deterministic.

| File | Responsibility |
|---|---|
| `units.ts` | `consumptionUnits(event)` — the single definition of the proxy weighting |
| `windows.ts` | `trailingWindow`, `windowHistory`, `projectWindow` (including roll-out) |
| `candidates.ts` | `detectCandidateWalls` |
| `index.ts` | `runForecast(events, now, observations)` → the complete answer |

### API

- New table `limit_observations`: `userId`, `windowKind`, `observedAt`,
  `unitsInWindow`, `provenance`, `status`.
- Repo methods on **both** implementations — memory and Drizzle. The
  session-rules work shipped Drizzle SQL that no test could reach; that gap
  is not to be repeated silently, and where it cannot be closed it must be
  stated.
- `GET /v1/forecast`, `POST /v1/limit-observations`, and confirm/dismiss for
  candidates.

### Web

A forecast panel rendering provenance beside every figure.

## Error handling

- No events in the window: report "not enough data", never a projection.
- Fewer than `MIN_HISTORY_DAYS = 14` of history: a "historical maximum" drawn
  from one week is just the current week, so it is not a ceiling at all.
  Report pace only and omit any time-to-exhaustion until there is enough
  history for the maximum to mean something.
- Pace of zero: no exhaustion time exists; say so rather than emitting
  `Infinity`.
- An event carrying no cache breakdown (`null`) contributes its known
  components only; it never fabricates a zero. Same `null` vs `0` discipline
  as the rules.
- The forecast query failing must not take down any other panel — the
  recommendations route already carries this pattern.

## Testing

Unit tests per pure function, including two that pin the reasoning rather
than the arithmetic:

- a roll-out case that **fails under naive extrapolation**, and
- a candidate-detection case where a weekend must **not** be proposed.

### Acceptance gate

`scripts/measure-forecast.mjs`, replayed over real `~/.claude/projects`
history, mirroring `measure-session-rules.mjs`. Two criteria:

1. **The projection is computable and sane** — pace, both windows, and a
   historical maximum, with no `NaN` and no negative time-to-exhaustion.
2. **Detection is checked against remembered ground truth.** This project's
   author ran out of usage roughly three days before a reset. If detection
   proposes that period, it works. If it proposes twenty candidates across the
   window, it is noise and **ships disabled** rather than being tuned until
   the output looks acceptable.

Criterion 2 is the important one. The previous rule set shipped green and
useless because nothing was measured against reality until the end. Here a
real event exists to check against, not merely a plausibility bound — and the
correct response to failing it is to disable the component and report the
number, not to move the thresholds.
