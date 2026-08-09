# Claude Code session adapter — design

**Date:** 2026-08-09
**Status:** Approved, not yet implemented
**Supersedes the capture half of:** `2026-08-05-recommendation-evidence-design.md`

## Problem

TokenOps' three per-request rules — `frontier_trivial`, `full_document_io`,
`context_bloat` — fire on nothing in production. Every event in the ledger
arrives through the OTLP receiver as `grain: "aggregate"`, and `runRules`
gates aggregates away because each request rule reads features an aggregate
cannot have.

Worse, the features those events carry are fabricated. A production event
reads:

```json
{"promptChars":54,"messageCount":1,"largePasteScore":0.00135,"modelTier":"frontier"}
```

`54` is the length of `[otel] claude_code.token.usage model=claude-opus-5[1m]`
— the synthetic string the OTEL adapter measures, because
`claude_code.token.usage` carries only `type` and `model` attributes. There
are no prompts, no responses, and no request boundary in an OTLP metric.
Nothing can be derived from it, and no UI change can conjure it.

Meanwhile Claude Code writes the data on disk. Verified on this machine:
**1,527 session files under `~/.claude/projects/`, 1.38 GB, the largest
32 MB.** Each `type: "assistant"` line carries a real per-turn usage record:

```json
{"input_tokens":2,"cache_creation_input_tokens":28890,
 "cache_read_input_tokens":26048,"output_tokens":229,...}
```

plus `sessionId`, `requestId`, `uuid`, `parentUuid`, `timestamp`, `cwd`,
`gitBranch`, and the message content itself. One 3.2 MB session held 1,227
lines, 532 of them assistant turns.

The data has been there all along; the agent was watching
`~/.tokenops/claude-code-usage.jsonl`, a path nothing writes.

## Decision

**Read Claude Code's own session JSONL, derive features locally, and ship
only numbers.**

Three decisions distinguish this from the earlier evidence spec:

1. **No content leaves the machine.** `extractFeatures` runs on the agent.
   `promptChars`, `fileDumpScore`, `largePasteScore`, `codeFenceCount` and
   `messageCount` are computed from the real prompt text on disk and shipped
   as integers. The permanent redacted-skeleton store the earlier spec
   proposed is **dropped entirely** — it was that spec's own
   highest-risk component, requiring an adversarial test suite because a
   single heuristic miss writes PII into permanent storage under a field
   name asserting it is safe. It is not needed to make the rules fire, which
   is the goal here.
2. **OTEL stays.** The earlier spec decided "OTEL is replaced, not
   supplemented." That is reversed: the OTLP receiver keeps serving every
   emitter *except* Claude Code, per the split-by-source rule in
   `2026-08-05-recommendation-credibility-design.md`.
3. **Bounded backfill.** First run reads a configurable window (default 7
   days), not 1.38 GB.

## Non-goals

- **Cloud content and redaction.** Dropped, per Decision 1. If raw evidence
  on a card is wanted later it gets its own spec, with the adversarial
  redaction suite the earlier design correctly demanded.
- **Backfilling all history.** ~230,000 assistant turns extrapolated from
  measured density. The back-test caps at 20,000 events per window, so most
  of it could not reach the headline figure anyway.
- **Changing the default privacy mode.** `local` stays. This design needs no
  privacy change at all, because it ships no content.
- **Removing the 712 existing OTEL events.** They are real spend history and
  the ledger must remain continuous.
- **New rules.** This makes the existing rules see real data.

## Architecture

### Capture

A new adapter, `apps/agent/src/adapters/claude-session.ts`, alongside the
existing ones.

**Watches** `~/.claude/projects/**/*.jsonl`. `sources.claude_code_path`
already accepts a file or a directory; its default changes from the
never-written `~/.tokenops/claude-code-usage.jsonl` to the directory Claude
Code actually writes.

**Emits** one `UsageEvent` per `type: "assistant"` line carrying a
`message.usage`. All other line types are skipped: `user`, `attachment`,
`system`, `file-history-snapshot`, `file-history-delta`, `mode`,
`last-prompt`, `ai-title`, `queue-operation`, `pr-link`.

**Grain** is `"request"`. This is the entire point: request rules evaluate
these and skip the OTEL-derived aggregates.

**Idempotence** uses the turn's own stable identifiers:

```ts
buildEventId({
  machineId,
  app: "claude-code",
  providerRequestId: line.requestId,
  fingerprint: line.uuid,
  timeBucketSec: Math.floor(Date.parse(line.timestamp) / 1000),
})
```

`uuid` is stable per turn and survives re-reads, so resuming from a stale
offset after a crash cannot double-count.

### Token accounting

Folded, per the `UsageEvent` schema's stated invariant that cache tokens are
subsets of `inputTokens`:

```
inputTokens         = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
cacheReadTokens     = cache_read_input_tokens
cacheCreationTokens = cache_creation_input_tokens
outputTokens        = output_tokens
costUsd             = null
```

The measured sample becomes `inputTokens: 54_940`, `cacheRead: 26_048`,
`cacheCreation: 28_890`, `output: 229`.

Folding is not cosmetic. Unfolded, that turn would enter the ledger as 2
input tokens for a request billed roughly 55,000 — and
`cache_efficiency` would compute a read ratio of 26048/2, which is
meaningless. `cacheRead + cacheCreation ≤ inputTokens` is the property
`checkCacheEfficiency` and `trimCacheTokens` both assume, and it holds by
construction here.

`costUsd` is `null` because a Max subscription has no per-request cost.
Nothing downstream needs it: savings estimate both sides through
`estimateCostUsd` and never read a reported cost.

### Features

Derived by the existing `extractFeatures`, fed the turn's own message content
plus the prior turn's `promptChars` as `sessionPriorPromptChars` (which is
what produces `newContentRatio`, the signal `context_bloat` gates on).

No new feature code. This is the function whose output was fabricated under
OTEL; feeding it real text is the fix.

### What this will actually surface

Stated plainly so the result is not a surprise:

| Rule | On real Claude Code data |
|------|--------------------------|
| `context_bloat` | Fires. Long sessions grow input while adding little new text. |
| `full_document_io` | Fires. Claude Code pastes file contents constantly, and `fileDumpScore` keys on code fences and path density. |
| `frontier_trivial` | **Never fires.** It caps at 200 total tokens; real turns are ~55,000. A Claude Code turn is never trivial. |
| `cache_efficiency` | Borderline — the measured sample is 26,048/54,940 = **47.4%**, just under the 50% threshold. |

`cache_efficiency` is the one to watch. Counting cache *creation* inside
`inputTokens` drags the read ratio down even when reuse is healthy, so the
rule may fire on every window, which is noise rather than a finding. This is
the first real use for the back-test: change
`CACHE_EFFICIENCY_MIN_READ_RATIO`, replay a window, and see whether the card
count and dollars move sensibly. Tuning it by guesswork is what the back-test
exists to replace.

### The OTel guard

When the session adapter is enabled, the OTLP receiver drops metrics whose
name begins with `claude_code.`, and logs once at startup:

```
otel: claude_code.* metrics ignored — session JSONL adapter owns this source
```

Every other OTLP emitter continues to work. The drop lives at the receiver,
not in config resolution, so "both sources ingesting Claude Code" is not a
state a user can configure their way into. Double-counting is the one
failure this cutover cannot recover from — a gap is re-readable from disk, a
doubled ledger is not.

### Scale and offsets

A per-file record — path, size, offset, last-seen mtime — in the agent's
existing SQLite.

- **Skip by mtime.** Files older than the backfill cutoff are never opened,
  so 1.38 GB is never parsed.
- **Read from the offset**, never the whole file. The largest is 32 MB.
- **First-run ceiling**, `MAX_BACKFILL_EVENTS = 20_000`. If the backfill
  would exceed it, emit up to the cap, stop, and log the number of turns
  skipped and the timestamp reached. A silent truncation reads as "captured
  everything" when it did not — the same disclosure rule the back-test
  endpoint follows with `truncated`. 20,000 matches the back-test's own
  `MAX_BACKTEST_EVENTS`, so a full backfill is exactly what one back-test
  window can consume; a larger ceiling would ship events the headline figure
  could never reach.
- **Partial final line.** Claude Code appends while the adapter reads, so a
  truncated last line is normal. It is skipped **and the offset is not
  advanced past it**, so the complete line is read next poll. Advancing past
  it silently drops one turn per poll on an active session.

Config gains `sources.claude_code_backfill_days` (default 7).

## Migration

The 712 OTEL-derived events stay, remain `aggregate`, and continue to feed
the aggregate rules. Historical totals must not move.

Cutover order: land the adapter with the OTel guard in the same change. The
guard makes the ordering safe rather than something an operator has to
sequence correctly.

## Testing

- A fixture session file yields one event per assistant turn and zero for
  every other line type.
- **Features are real**: `promptChars` equals the actual prompt length, not a
  synthetic string. Pin this explicitly — it is the regression that started
  this work.
- Token folding on the measured sample: `inputTokens === 54_940`, and
  `cacheRead + cacheCreation <= inputTokens`.
- Re-reading a file produces no duplicate events.
- A truncated final line is skipped, the offset is not advanced, and the
  complete line is emitted on the next poll.
- Offsets resume correctly across a restart.
- Files older than the backfill cutoff are not opened.
- The first-run ceiling logs what it dropped.
- The OTel guard drops `claude_code.*` and passes every other metric.
- Windows paths resolve — sessions live under `C--Users-Ken-…` directory
  names, and nothing may assume POSIX separators.

## Risks

1. **The JSONL format is not a published contract** and can change in any
   Claude Code release. The adapter tolerates unknown fields and skips
   unparseable turns rather than failing a file. The failure mode must be
   missing data, never a crashed agent.
2. **`cache_efficiency` may become noise** at ~47% on healthy usage. Named
   above; the back-test is the tuning instrument.
3. **Volume is unknown until it runs.** Seven days of heavy use could be
   thousands of events. The ceiling and the first-run log make that visible
   before it becomes an ingest problem.
4. **Sidechain turns.** Assistant lines carry `isSidechain`, marking subagent
   turns that share the parent's `sessionId`. Interleaving them into the
   parent's session context would corrupt `context_bloat`, whose whole
   measurement is "input grew relative to the session's first request" — a
   subagent's independent context makes that growth meaningless.

   **Decision: emit sidechain turns as events with `sessionId` omitted.**
   Their tokens are real spend and must reach the ledger and the aggregate
   rules; but `contextBloatRule` returns null without a `sessionId`, so they
   are excluded from session reasoning by the rule's existing guard rather
   than by a special case in the adapter. Tested by asserting a sidechain
   turn produces an event whose tokens count and whose `sessionId` is absent.

## Follow-ups

- Tune `CACHE_EFFICIENCY_MIN_READ_RATIO` against real data using the
  back-test, once a week of events exists.
- Retire the unused `~/.tokenops/claude-code-usage.jsonl` path and the
  adapter that watches it, once this one is proven.
- Cloud evidence with redaction, if raw prompt quotes on a card are ever
  wanted — its own spec, with the adversarial suite.
