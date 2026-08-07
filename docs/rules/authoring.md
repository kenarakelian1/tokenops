# Writing a TokenOps recommendation rule

TokenOps ships five efficiency rules. This document is the contract for
writing a sixth. Outside contributions are accepted — the rule surface is
published precisely so that people who know a workload we don't can encode
it.

Everything below is copied from the source under
`packages/shared/src/rules/`. If a snippet here and the code disagree, the
code wins and this document is a bug.

**A note on the word "estimated."** TokenOps never reports a measured saving.
A rule declares what a request *would have looked like* had its advice been
taken; the runner prices both the real token counts and the hypothetical ones
through the same published rate table at the same instant, and reports the
difference. That is an estimate resting on a stated assumption, and every
number a rule produces is labelled that way in the type names
(`estimatedWastedUsd`), on the card, and in this guide.

---

## 1. What a rule is

A rule is **a predicate plus a counterfactual**. It answers two questions:

1. Is something wrong with this request (or this window)?
2. What would the request have looked like if it weren't?

It does not answer "how much did that cost?" A rule never multiplies a token
count by a rate, never reads a price table, and never returns a dollar
figure. The runner owns pricing, the materiality floor, severity, and
ordering. A contributor writes a predicate and a counterfactual and nothing
else.

### The rule interface

From `packages/shared/src/rules/contract.ts`:

```ts
export interface Rule<TInput> {
  readonly id: RuleId;
  readonly grain: "request" | "aggregate";
  readonly defaultSeverity: Severity;
  evaluate(input: TInput, ctx: RuleContext): RuleFinding | null;
  /**
   * Which slice of the input the counterfactual should be priced against.
   *
   * Most rules compare against the whole input and omit this — the runner
   * then builds the Actual from the input itself. A rule that reasons over a
   * COLLECTION and singles out one member (frontier_share picks the dominant
   * model out of a window) must implement this, because only the rule knows
   * which member it chose. Without it the runner would have to infer the
   * choice by matching token counts back against the collection, which is
   * ambiguous whenever two members share the same totals.
   *
   * Return null to withdraw the finding — if a rule cannot say what its
   * counterfactual is measured against, there is nothing to price.
   */
  resolveActual?(input: TInput, finding: RuleFinding): Actual | null;
}
```

`TInput` is `UsageEvent` for request-grain rules, and either
`AggregateWindow` or `ModelWindowTotals` for aggregate-grain rules — see
§ 1.4.

### What a rule returns

```ts
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
```

Returning `null` from `evaluate` means "this rule has nothing to say about
this input." That is the overwhelmingly common case and costs nothing.

### What a rule is given

```ts
export type RuleContext = {
  /** Pricing instant. Replays pass the event's own timestamp — see PricingContext. */
  now: Date;
  priceOverrides?: Record<string, PriceRow>;
  /** Request-grain rules only: prior events in the same session, oldest first. */
  sessionContext?: UsageEvent[];
};
```

`ctx.now` exists so a rule that needs a time reference gets the *pricing
instant* the runner is using, not the wall clock. Most predicates ignore it
entirely (all five shipped rules name it `_ctx` or use only
`ctx.sessionContext`). It matters because replays and back-tests pass each
event's own timestamp, so the same historical window reports the same
estimated savings no matter what day you ask.

`ctx.priceOverrides` is threaded through to the pricer for you. A rule should
never read it — if you find yourself wanting to, you are about to compute
money, which is § 4.2.

### The counterfactual

From `packages/shared/src/rules/counterfactual.ts`:

```ts
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
```

`Actual` and `Counterfactual` are structurally identical on purpose: they are
the two sides of one comparison, priced by one function through one table.

```ts
export function priceCounterfactual(
  actual: Actual,
  counterfactual: Counterfactual,
  ctx: PricingContext,
): PricedSavings;

export type PricedSavings = {
  estimatedWastedTokens: number;
  estimatedWastedUsd: number | null;
};
```

`estimatedWastedUsd` is `null` when either side is unpriceable — a more
honest answer than charging the whole call as waste, which is what
`frontier_trivial` did before this function existed.

### Grain: which runner will call you

`grain` is a declaration, not a hint. It replaced an `isAggregate()` gate
that used to live inside the runner, so that a new rule **states** which
shape of input it consumes rather than remembering to opt out of the wrong
one.

| `grain` | Input type | Runner | Registration |
|---|---|---|---|
| `"request"` | `UsageEvent` | `runRules` (`rules/index.ts`) | append to `REQUEST_RULES` |
| `"aggregate"` | `AggregateWindow` or `ModelWindowTotals` | `runAggregateRules` (`rules/aggregate/index.ts`) | wire into the runner body and add the id to `AGGREGATE_RULE_IDS` |

Request-grain rules read a single event's derived `features` — prompt chars,
message count, paste and file-dump scores, and (for `context_bloat`) that
event's same-session history. An aggregate has none of that: it is a
time-bucketed sum with no request inside it. `runRules` discards every
`grain: "aggregate"` event before any request rule runs.

The aggregate runner is not a `for` loop over a registry — it calls its two
rules explicitly, because `frontier_share` consumes a whole
`AggregateWindow` while `cache_efficiency` is evaluated once per model row
(`ModelWindowTotals`) and deduplicated down to the worst offender. Adding an
aggregate rule means editing `runAggregateRules` as well as
`AGGREGATE_RULE_IDS`; that list is what tells the hourly job which cards to
retire when a rule stops firing.

---

## 2. A worked example: `frontier_trivial`

This is the whole rule, verbatim from
`packages/shared/src/rules/frontier-trivial.ts`:

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

Roughly thirty lines of body, of which seven are early returns. That ratio is
normal and correct.

### Why each early return exists

```ts
if (features.modelTier !== "frontier") return null;
if (totalTokens > FRONTIER_TRIVIAL_MAX_TOTAL_TOKENS) return null;
```

The predicate proper. Nothing subtle: this rule is about frontier models
doing small work.

```ts
if (features.messageCount == null) return null;
if (features.largePasteScore == null) return null;
```

**Absence is not zero.** `features.messageCount` and
`features.largePasteScore` are optional on `UsageFeaturesSchema` — a capture
path that cannot derive them omits them. Treating a missing `largePasteScore`
as `0` would mean "we know there was no large paste," which is a claim the
data does not support, and would fire this rule on every frontier call from a
capture path that simply doesn't report the field. Note that these two guards
use `== null` so they catch both `null` and `undefined`, and that they come
*before* the comparisons that consume the same fields.

```ts
if (features.messageCount > 2) return null;
if (features.largePasteScore >= 0.3) return null;
```

Now the values can be trusted, so they can be compared. A three-message
exchange or a substantial paste isn't a trivial task even if the token count
is small.

```ts
const suggestedModel = cheaperSiblingModel(event.model);
if (!suggestedModel) return null;
```

**A finding a user cannot act on is not a finding.** `cheaperSiblingModel`
returns `null` when the vendor family is unrecognised, or when the model is
already the cheapest tier in its family. Before this guard existed, the rule
compared every frontier-tier trivial call against a hardcoded
`gpt-4o-mini` — so a Grok user got a card telling them to switch vendors,
which is not something they can do for one call. `frontier-trivial.test.ts`
pins that behaviour with a `grok-4` fixture that must produce `null`.

### Why the counterfactual keeps token counts unchanged

```ts
counterfactual: {
  model: suggestedModel,
  inputTokens,       // unchanged
  outputTokens,      // unchanged
  cacheReadTokens: event.cacheReadTokens ?? null,
  cacheCreationTokens: event.cacheCreationTokens ?? null,
},
```

This rule's advice is "use a different model," not "send less." The
hypothetical is *the same prompt, the same answer, a cheaper model* — so
every token count carries over untouched and only `model` changes. The saving
is entirely the rate delta between the two models on identical volume, which
is exactly what the user would experience if they took the advice.

A rule whose advice *is* "send less" changes `inputTokens` instead and leaves
`model` alone. Both shapes go through the same pricer.

The `?? null` on the cache fields is the null-vs-zero invariant of § 4.1:
`UsageEvent.cacheReadTokens` is optional, and an absent field becomes `null`
("no breakdown recorded"), never `0` ("recorded, genuinely zero").

### Why `implicatedTokens` is the total, not a delta

```ts
implicatedTokens: totalTokens,   // inputTokens + outputTokens
```

The token delta between actual and counterfactual here is **zero** — the
model changed, not the volume. If `implicatedTokens` meant "tokens saved,"
this rule would always report `0`, the card would show "0 tokens" next to a
real dollar figure, and the materiality fallback would drop every finding
whose cost happened to be unpriceable.

`implicatedTokens` means "the tokens this finding is *about*." For a model
swap that is the entire call: all 200 of them were served by the wrong model.
For `full_document_io` it is the removed share; for `context_bloat` the
excess over the session's first request; for `cache_efficiency` the cache-read
shortfall; for `frontier_share` all frontier tokens in the window. In each
case it answers "how much traffic does this finding concern," which is what
a user reads it as.

The field flows into `PricedSavings.estimatedWastedTokens` untouched — the
pricer never derives it, precisely so a model-swap rule can report a token
count that is not a difference.

### Why `assumption` is phrased for a user

```ts
assumption: `${suggestedModel} handles requests at or under ${FRONTIER_TRIVIAL_MAX_TOTAL_TOKENS} tokens as well as ${event.model}`,
```

Rendered, that reads: *"claude-sonnet-5 handles requests at or under 200
tokens as well as claude-opus-5."*

That sentence appears **on the card**, next to the estimated dollar figure. It
is the thing a user is invited to disagree with. It names models they
recognise and a threshold they can evaluate against their own workload. It
does not say "assumes `cheaperSiblingModel(event.model)` is
quality-equivalent below `FRONTIER_TRIVIAL_MAX_TOTAL_TOKENS`" — that sentence
is true, and useless to the person deciding whether to act.

Write the assumption as the objection a skeptical user would raise, stated
before they raise it. If you cannot write that sentence, the counterfactual
is probably doing something you have not fully justified to yourself.

`assumption` is optional in the type and effectively mandatory in practice.
All five shipped rules set it. Omit it only when the counterfactual embeds no
judgement at all.

### Why this rule is `info`

```ts
defaultSeverity: "info",
```

Capped at 200 tokens, the most this can ever save on one call is a fraction
of a cent — and in a coding agent, the user does not pick a model per request
at all. Severity is declared per rule and deliberately **not** derived from
savings: a cheap finding can still be urgent, and mapping dollars onto
severity would just be a fresh set of magic numbers. Cards are ordered by
estimated savings, which is what actually keeps low-value findings down the
list.

---

## 3. Choosing a counterfactual

**The rule of thumb: a counterfactual must be something the user could
actually have done.** Not something cheaper. Not something theoretically
optimal. Something they could have chosen, in the situation they were
actually in.

What the five shipped rules declare:

| Rule | Counterfactual | Stated assumption |
|---|---|---|
| `frontier_trivial` | Cheapest in-vendor sibling model; every token count unchanged | *"claude-sonnet-5 handles requests at or under 200 tokens as well as claude-opus-5"* |
| `full_document_io` | Same model; `inputTokens` reduced by `inputTokens × fileDumpScore × 0.5`, cache breakdown trimmed | *"Assumes excerpting removes half the dumped content, leaving the rest of the prompt unchanged"* |
| `context_bloat` | Same model; `inputTokens` held flat at the session's first request, cache breakdown trimmed | *"Assumes context could have stayed at the size of the session's first request"* |
| `cache_efficiency` | Same model; `cacheReadTokens` raised toward `inputTokens × 0.5`, capped at `inputTokens − cacheCreationTokens` so the two cache components still fit inside `inputTokens` (see § 4.4) | *"Assumes a 50% cache-read ratio is achievable for this workload"* — the percentage is the ratio **actually targeted**, so it drops below 50% whenever the cap binds |
| `frontier_share` | Dominant frontier model's cheaper in-vendor sibling, over **that model's own** tokens and cache breakdown | *"Assumes routine work moves from claude-opus-5 to claude-sonnet-5. Other vendors' frontier tokens are counted in the share but not repriced."* |

Three shapes appear, and yours will be one of them:

- **Routing advice** — change `model`, keep every token count. The saving is
  the rate delta on identical volume. (`frontier_trivial`, `frontier_share`)
- **Volume advice** — keep `model`, lower `inputTokens`, and trim the cache
  breakdown to match with `trimCacheTokens` (§ 4.4). The saving is the removed
  tokens at the model's own rate. (`full_document_io`, `context_bloat`)
- **Cache-mix advice** — keep `model` and `inputTokens`, and move tokens
  between the rate tiers *inside* that input by raising a cache component. The
  saving is the multiplier delta (a cache read is billed at 0.1× the base
  input rate). The target must be capped to fit inside `inputTokens` — see
  § 4.4. (`cache_efficiency`)

Mixing two of them in one rule means you are asserting the user would have
done two different things at once, and the dollar figure stops being
attributable to either.

### Cross-vendor swaps are not actionable

**Never propose moving a call from one vendor to another.** A user cannot
switch a single request from Claude Opus to GPT-4o-mini: the API is
different, the client is different, the credentials are different, and in an
agent harness the model may not be theirs to pick at all. A card advising it
is not advice, it is noise — and the dollar figure attached to it is priced
across two vendors' rate cards, which compares nothing.

`cheaperSiblingModel(model)` is the only sanctioned way to name a target
model. It returns a cheaper model **in the same vendor family** (Anthropic:
haiku < sonnet < opus; OpenAI: `gpt-4o-mini` < the rest of the `gpt-4*`
family), or `null` when the family is unrecognised or the model is already
the cheapest in it. When it returns `null`, return `null` — there is nothing
actionable to say.

`frontier_share` shows how far this is taken. It reports the frontier share
of *all* tokens in the window, which may span several vendors, but it prices
only the largest frontier contributor's own tokens against that model's own
in-vendor sibling. Summing the whole window against one sibling's rate would
silently price gpt-4o tokens as if they were claude-sonnet-5. The assumption
string says so out loud: *"Other vendors' frontier tokens are counted in the
share but not repriced."* When the largest frontier contributor has no
in-vendor sibling, `selectDominant` falls through to the next-largest rather
than reaching across vendors.

---

## 4. The invariants a rule must not break

Each of these has already caused a real bug in this codebase. They are not
style preferences.

### 4.1 `null` and `0` are different on cache fields

`cacheReadTokens` and `cacheCreationTokens` are `number | null` on
`Counterfactual`, `Actual`, and `ModelWindowTotals`, and optional on
`UsageEvent`. The two states mean different things:

- **`null`** — no cache breakdown was ever recorded for this event or this
  slice of the window. Pre-migration events fold cache tokens into
  `inputTokens` and report nothing separately.
- **`0`** — a breakdown was recorded, and reuse was genuinely zero.

Collapsing them fails in **both directions**, which is why neither default is
safe:

- Treating `null` as `0` on a window that predates cache reporting invents a
  "low cache reuse" finding out of missing data — a confidently wrong card on
  a window straddling the migration.
- Treating a real `0` as "unknown" silences a user who is genuinely paying
  full price for context on every single call, which is the most valuable
  card the aggregate class can produce.

`cacheEfficiencyRule` acts on the distinction in its first line —
`if (totals.cacheReadTokens === null) return null;` — with a strict `===`, so
a recorded `0` proceeds to the ratio check and produces a finding. Note that
this guard is `=== null` (only `null` is "unknown") while the
`frontier_trivial` feature guards are `== null` (both `null` and `undefined`
are "absent" on an optional field). Both are deliberate; match the semantics
of the field you are reading.

On the way out, preserve it: `event.cacheReadTokens ?? null`, never
`?? 0`. `trimCacheTokens` follows the same discipline — a component that was
`null` on the actual side stays `null` on the counterfactual and contributes
`0` to the trim arithmetic, so trimming never materialises a number where the
event recorded none.

Related, and easy to get wrong the other way: cache tokens are **already
counted inside `inputTokens`**, not additional to it. Never add them.

### 4.2 Never read a provider-reported `costUsd` for savings

`Actual` has no `costUsd` field. That is deliberate, and it is the single
most important thing in this document.

`UsageEvent` *does* carry `costUsd`, and so does `ModelWindowTotals`. Both
are provider-reported and often more accurate than any estimate. Using one
for savings is nevertheless always wrong, because of what it does to the
*other* side of the comparison:

1. The actual side gets a real, cache-discounted, provider-billed number.
2. The counterfactual side can only ever be an estimate at published list
   rates, with no discount applied.
3. The estimate therefore comes out **higher** than the real figure for what
   is genuinely the cheaper option.
4. `priceCounterfactual` clamps through `Math.max(0, actualCost -
   counterfactualCost)`, so the saving becomes `0`.
5. `0` is below `MIN_WASTED_USD`, so `isMaterial` filters the hit out.
6. The card silently disappears. No error, no log, no failing test — the
   recommendation just never shows up.

`frontier_share` hit exactly this and was fixed inline. The fix that made it
un-reintroducible was removing `costUsd` from the type: `priceCounterfactual`
takes an `Actual`, `Actual` has no such field, so no future rule can pass one
even by accident. Both sides go through `estimateCostUsd` with the same
table, the same overrides, and the same `now`.

If you want to know why an estimate diverges from a provider's bill, that is a
pricing-table question, not a rule question. Fix the table.

### 4.3 Declare `grain` honestly; keep `id` in the `RuleId` union

```ts
export type RuleId =
  | "frontier_trivial"
  | "full_document_io"
  | "context_bloat"
  | "frontier_share"
  | "cache_efficiency";
```

A new rule adds its id to this union in `packages/shared/src/rules/types.ts`.
`RuleId` is not `string`, and it is not decorative: the union is what makes
persistence, dismissal, supersession, and the aggregate job's retirement list
exhaustive over the real set of rules. A rule whose id is not in the union
does not type-check, which is the intended outcome.

`grain` must match the input the rule actually reads. A rule that declares
`"aggregate"` but reads `event.features` compiles (the aggregate types have
no `features`, so it usually won't — but a sufficiently loose `TInput` can
sneak through) and then reads `undefined` at runtime for every OTEL-derived
user. A rule that declares `"request"` and is registered with the aggregate
runner will be handed a shape it does not expect. Declare it, register it in
the matching place, and let the type parameter check you.

### 4.4 Cache tokens are a subset of input tokens

On any `Counterfactual` you construct:

```
(cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0) <= inputTokens
```

They are subsets of `inputTokens`, not additions to it, and the pricer relies
on that. `estimateCostUsd` carves the cache portions out of the full-rate
portion:

```ts
const fullRateInputTokens = Math.max(
  0,
  inputTokens - cacheReadTokens - cacheCreationTokens,
);
```

Break the invariant and that clamp fires: the excess cache tokens are still
billed at their own multipliers while the full-rate portion has already
bottomed out at zero, so the counterfactual is priced for more tokens than it
actually contains. It comes out too expensive, and the estimated saving is
understated — or, if the overshoot is large enough, driven to zero by the
`Math.max(0, …)` in `priceCounterfactual` and filtered out as immaterial.

**Routing rules cannot break this**, because they copy the actual's cache
breakdown alongside an unchanged `inputTokens`.

**Token-reducing rules break it by default.** Shrink `inputTokens` from
12,000 to 7,200 while copying `cacheReadTokens: 8_000` across, and the
counterfactual claims 8,000 cached tokens inside a 7,200-token prompt. Use
`trimCacheTokens` (in `counterfactual.ts`, imported directly by
`full-document-io.ts` and `context-bloat.ts`):

```ts
const trimmedCache = trimCacheTokens(
  {
    inputTokens,
    cacheReadTokens: event.cacheReadTokens ?? null,
    cacheCreationTokens: event.cacheCreationTokens ?? null,
  },
  counterfactualInputTokens,
);
```

It removes **uncached content first**, which is what "send an excerpt" and
"hold context flat" actually mean — a cached system prompt stays cached when
the rest of the prompt shrinks around it. Only when the removal exceeds the
uncached portion does cached content shrink, and then `cacheCreationTokens`
(billed at 1.25× the base input rate) is shed before `cacheReadTokens`
(billed at 0.1×) — the expensive part goes first. A component that was `null`
stays `null`.

Its post-condition is exactly the invariant above. Use it in any rule whose
counterfactual lowers `inputTokens`.

**Cache-raising rules must cap, and `trimCacheTokens` will not help them.**
There is a third shape, and `cache_efficiency` is the reference example: it
leaves `inputTokens` alone and *raises* a cache component. `trimCacheTokens`
only shrinks, so it does not apply. The rule has to enforce the invariant
itself — the target it wants (`inputTokens × 0.5`) is not necessarily a target
it can have, because whatever `cacheCreationTokens` the window already
recorded occupies part of the same `inputTokens` budget. From
`aggregate/cache-efficiency.ts`:

```ts
const cacheCreationTokens = totals.cacheCreationTokens ?? 0;
const readCapacity = Math.max(0, totals.inputTokens - cacheCreationTokens);
const targetReads = Math.min(
  totals.inputTokens * CACHE_EFFICIENCY_MIN_READ_RATIO,
  readCapacity,
);
```

Worked: a window with `inputTokens: 1000`, `cacheReadTokens: 100`,
`cacheCreationTokens: 800` fires the rule (10% read ratio). The uncapped
target of 500 reads would give a counterfactual holding `500 + 800 = 1300`
cache tokens inside a 1000-token prompt — the invariant broken, and the
counterfactual priced as more expensive than it is. `readCapacity` is 200, so
`targetReads` becomes 200 and `200 + 800 = 1000` fits exactly.

Two details worth copying:

- **The `?? 0` is arithmetic-only.** A `null` `cacheCreationTokens` counts as
  `0` when computing capacity — the same convention `trimCacheTokens` uses —
  but it is still copied through to the counterfactual as `null`. The
  null-vs-zero distinction of § 4.1 survives the cap.
- **The stated assumption follows the cap, not the constant.** The card
  reports `Math.round((targetReads / totals.inputTokens) * 100)`, so the
  worked example above says *"Assumes a 20% cache-read ratio is achievable
  for this workload"*. Had it hardcoded the 50% constant, the card would
  assert a ratio its own counterfactual never reaches — the assumption would
  be describing a hypothetical that was not priced.

The general lesson: when a rule sets a cache component to a *computed target*
rather than copying or trimming an observed one, the target is a wish. Clamp
it to what `inputTokens` can actually hold, and derive both
`implicatedTokens` and the stated assumption from the clamped value, so the
number on the card and the number that was priced are the same number.

---

## 5. Testing a rule

Tests live beside the rule (`packages/shared/src/rules/*.test.ts`) and run
under Vitest with `pnpm -r test`.

### The `ev()` fixture helper

Every request-grain test file defines the same local helper. From
`packages/shared/src/rules/rules.test.ts`:

```ts
const CTX = { now: new Date("2026-09-15T00:00:00Z") };

function ev(
  partial: Partial<UsageEvent> &
    Pick<
      UsageEvent,
      "eventId" | "model" | "inputTokens" | "outputTokens" | "features"
    >,
): UsageEvent {
  return {
    timestamp: new Date().toISOString(),
    machineId: "m",
    machineName: "n",
    app: "openai-proxy",
    provider: "openai",
    costUsd: 0.01,
    hasContent: false,
    ...partial,
  };
}
```

The `Pick` is the useful part: the five fields every rule fixture must state
are required, and everything else is filled in. A fixture then shows only
what the test is about.

### Two tests per rule, minimum

**One asserting the counterfactual directly.** Call `evaluate` and inspect
the finding. No pricing, no floors, no runner — just "given this input, does
the rule declare the hypothetical I expect?"

```ts
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
    const finding = frontierTrivialRule.evaluate(event, CTX);
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
});
```

Note `costUsd: null` on that fixture. It is there to prove the point of
§ 4.2: the rule and the pricer produce a complete finding with no
provider-reported cost available at all.

**One asserting the priced hit through the runner.** This exercises
`resolveActual`, `priceCounterfactual`, severity, and the materiality floor
together:

```ts
it("flags frontier for trivial", () => {
  const hits = runRules(
    ev({
      eventId: "a",
      model: "claude-opus-4",
      inputTokens: 20,
      outputTokens: 180,
      costUsd: 0.05,
      features: {
        promptChars: 40,
        responseChars: 20,
        messageCount: 1,
        codeFenceCount: 0,
        largePasteScore: 0,
        fileDumpScore: 0,
        modelTier: "frontier",
      },
    }),
  );
  expect(hits.some((h) => h.ruleId === "frontier_trivial")).toBe(true);
});
```

Cover **each branch of the predicate**. `frontier_trivial` has seven early
returns; each is a case where the rule must stay quiet, and each deserves a
fixture. The `grok-4` test in `frontier-trivial.test.ts` exists because that
branch was once missing and shipped an unactionable card.

### Materiality can hide a correct rule

`runRules` and `runAggregateRules` both end with `.filter(isMaterial)`. A hit
whose `estimatedWastedUsd` is below `MIN_WASTED_USD` ($0.01) is discarded
before you see it. **A fixture that does not clear the floor produces an
empty array from a rule that is working perfectly**, and your test proves
nothing except that the floor works.

The concrete trap, which cost real debugging time: **no `claude-opus-5` →
`claude-sonnet-5` swap can clear `MIN_WASTED_USD` inside `frontier_trivial`'s
200-token cap.** Opus 5 is $5/$25 per million tokens; Sonnet 5 is $2/$10 while
the introductory rate is live and $3/$15 after it expires on 2026-08-31. The
delta is widest under the introductory rate, and the best case is 200 tokens
of pure output:

```
intro rate:       200 × ($25 − $10) / 1,000,000 = $0.003   ← the ceiling
after 2026-08-31: 200 × ($25 − $15) / 1,000,000 = $0.002
```

So the most this swap can ever be worth is **$0.003**, under a $0.01 floor —
and less once the introductory rate lapses. Both figures are given because a
reader checking the arithmetic will get one or the other depending on the day;
neither clears. `rules.test.ts` states the ceiling the same way ("max ~$0.003
at any token split"). Every fixture built on that pair silently returns `[]`,
and the natural conclusion — "the rule is broken" — is wrong.

The fixtures that do work pick their models and token splits deliberately:

- `frontier_trivial` uses **`claude-opus-4`** ($15/$75) with an
  output-heavy 20/180 split. The output-rate delta against Sonnet 5 is what
  is large enough to matter; an input-heavy split at the same total does not
  clear the floor either.
- `full_document_io` and `context_bloat` use **`gpt-4o`**, not
  `gpt-4o-mini` — the mini rate is too low to clear $0.01 at the token counts
  those fixtures use.

When a rule-level test passes and the runner-level test returns `[]`, check
the arithmetic against the floor before you touch the rule. If your rule is
genuinely correct but cheap, that is fine — assert on `evaluate` directly and
let the runner test use a model where the money is real.

### Pin `now` and `timestamp`

Do not rely on the wall clock. `claude-sonnet-5` has a date-gated
introductory rate ($2/$10 instead of $3/$15) that **expires 2026-08-31**, so
a fixture priced against Sonnet 5 produces one number before that date and a
different one after. A test written today that asserts an exact dollar figure
becomes a mystery failure on a specific morning.

Two things to pin:

- **`ctx.now`** — pass an explicit `RuleContext`, as the shipped tests do
  with `const CTX = { now: new Date("2026-09-15T00:00:00Z") };`. That date is
  after the cutoff, so those tests exercise the durable rate.
- **`timestamp` on the fixture event** — `runRules` defaults `now` to
  `new Date(event.timestamp)` when you do not pass `ctx`, and `ev()` defaults
  `timestamp` to `new Date().toISOString()`. A `runRules` call with no `ctx`
  and no explicit `timestamp` is therefore priced at the wall clock, whatever
  today happens to be.

`estimateCostUsd`, `priceCounterfactual`, and both runners all take `now` as
a parameter for exactly this reason. Use it.

---

## 6. Stability guarantees

**Published surface.** These are what a rule is written against, and they
will not change incompatibly without a deliberate, announced migration:

| Type | Where |
|---|---|
| `Rule<TInput>` | `rules/contract.ts` |
| `RuleFinding` | `rules/contract.ts` |
| `RuleContext` | `rules/contract.ts` |
| `Counterfactual` | `rules/counterfactual.ts` |
| `Actual` | `rules/counterfactual.ts` |
| `Severity` | `rules/types.ts` |
| `RuleId` | `rules/types.ts` (grows as rules are added) |

`Severity` exists as a named type specifically so the published contract has
no anonymous field types; it was extracted from an inline declaration on
`RuleHit` for that reason.

**Internal, may change without notice.** These are exported because the
runners and the API need them, not because they are a contribution surface:

- `priceFinding` — the runner's assembly step.
- `REQUEST_RULES` — the registry array. You append to it; do not depend on
  its order or identity.
- `runRules`, `runAggregateRules` — the runners themselves.
- `AGGREGATE_RULE_IDS` — a job-coordination detail.
- `isMaterial`, `MIN_WASTED_USD`, `MIN_WASTED_TOKENS` — the floor is a
  product decision and its values are expected to move.
- `trimCacheTokens` — stable in behaviour, but a helper rather than part of
  the contract (it is not re-exported from the package root; rules import it
  from `./counterfactual.js`).

**`RuleHit` is output-only.**

```ts
/** Runner OUTPUT. Rules return RuleFinding (see contract.ts); the runner prices it into this. */
export interface RuleHit {
  ruleId: RuleId;
  severity: Severity;
  title: string;
  detail: string;
  estimatedWastedTokens: number;
  estimatedWastedUsd: number | null;
  eventIds: string[];
  counterfactual: Counterfactual | null;
  assumption: string | null;
}
```

**Never construct a `RuleHit` in a rule.** It carries priced fields, a
resolved severity, and nullability that only exists to read legacy rows back
out of the database. Building one inside a rule means computing money, which
is the one thing a rule must not do. Return a `RuleFinding`; the runner does
the rest.

---

## 7. Submitting a rule

Open a pull request against `main`. A rule PR should contain:

1. **The rule** — a new file under `packages/shared/src/rules/` (or
   `rules/aggregate/` for aggregate grain), exporting a `Rule<TInput>` and
   any named threshold constants. Every magic number gets a name and a doc
   comment saying what it represents.
2. **Its id** — added to the `RuleId` union in `rules/types.ts`.
3. **Registration** — appended to `REQUEST_RULES` in `rules/index.ts` for
   request grain; wired into `runAggregateRules` and added to
   `AGGREGATE_RULE_IDS` for aggregate grain.
4. **Exports** — re-exported from `rules/index.ts` (or
   `rules/aggregate/index.ts`) and from `packages/shared/src/index.ts`,
   matching how the existing five are exported.
5. **Tests — at least one fixture-driven test per branch of the predicate.**
   Every early return is a branch. Plus the two tests of § 5: one asserting
   the counterfactual off `evaluate`, one asserting the priced hit through
   the runner with a fixture that clears the materiality floor.
6. **A stated assumption for any judgement embedded in the counterfactual.**
   If your counterfactual contains a number that represents a belief about
   what the user could have done — an excerpt fraction, an achievable ratio,
   a quality equivalence — it must be a named constant *and* it must appear
   in `assumption`, in words, phrased for the person reading the card.
7. **A README row** — add the rule to the table in the "Recommendation rules"
   section, then re-render with
   `node scripts/build-doc-html.mjs README.md README.html`.

Verify with:

```bash
pnpm -r build
pnpm -r test
```

What review will ask:

- Could a user actually do the thing your counterfactual describes?
- Is the target model in the same vendor family?
- Does anything read `costUsd` on the way to a savings figure?
- Do `null` cache fields survive as `null`?
- Does `(cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0)` fit inside the
  counterfactual's own `inputTokens`?
- Is every threshold named, and is every judgement stated on the card?
- Does the assumption read like something a user would push back on, or like
  a code comment?
