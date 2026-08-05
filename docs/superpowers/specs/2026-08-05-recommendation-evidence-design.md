# Recommendation evidence — design

**Date:** 2026-08-05
**Status:** Approved, not yet implemented

## Problem

The Recommendations panel now says true things, but not actionable ones. The
single live card reads:

> **Frontier-heavy token mix** — 80% of your tokens in this window went to a
> frontier-tier model (`claude-opus-5[1m]`). Consider `claude-sonnet-5` for
> routine work. — 257,083,982 tokens · $778.82

That tells you *what*, never *which calls*. There is no way to act on it beyond
a vague resolution to use Opus less.

Showing the offending calls requires content, and there is none. Verified
against production: **712 events, `has_content = 0` on every one, and the
`event_content` table empty.**

Three independent causes, and the first is structural.

### The active capture path contains no requests

`claude_code.token.usage` carries two attributes — `type` and `model`
(`apps/agent/src/adapters/claude-otel.ts:5`). No prompts, no responses, no
request boundary. Nothing exists to quote, and no UI change can conjure it.

### The features are still fabricated in production

The newest event in the ledger carries:

```json
{"promptChars":54,"messageCount":1,"largePasteScore":0.00135,"modelTier":"frontier"}
```

`54` is the length of `[otel] claude_code.token.usage model=claude-opus-5[1m]`
— the synthetic string the adapter measures. The fix for this is merged but the
deployed agent predates it, so every event still describes a placeholder.

### The adapter watches a file nothing writes

`~/.tokenops/claude-code-usage.jsonl` does not exist and no process creates it.
Meanwhile Claude Code writes **1,455 session JSONL files** under
`~/.claude/projects/`, the newest 18 MB and updated minutes ago, each holding
the full conversation: real prompts, real responses, real per-turn token counts.

The data has been there all along; the agent was watching the wrong path.

## Decision

**Read Claude Code's own session JSONL.** It supplies real requests, real
features, and the text that evidence requires, in one change.

Rejected: running JSONL alongside OTEL. The same usage would arrive twice, and
deduplicating across two capture mechanisms risks the ledger invariant the
previous branch spent seven tasks establishing. OTEL is replaced, not
supplemented.

### Three retention tiers

| Tier | Retention | Contains |
|------|-----------|----------|
| Local outbox | Full, on device | Complete request and response text |
| Cloud raw | **2 hours** | Text, for rendering fresh examples in the dashboard |
| Recommendation summary | Permanent | Shape plus a redacted skeleton |

Raw text is ephemeral evidence; the derived summary outlives it so a card stays
meaningful after the content expires.

The current `event_content` TTL is 7 days (`CONTENT_TTL_MS` in
`apps/api/src/services/ingest.ts`). Two hours is not a constant swap: the expiry
job runs hourly, so a 2-hour TTL means content can survive up to 3 hours. Either
the job interval drops or the documented guarantee becomes "at most 3 hours".
State whichever is chosen; do not claim 2 and deliver 3.

## Non-goals

- **Backfilling evidence** for the 712 existing events. They are aggregates with
  no content and never will have any.
- **Capturing non-Claude-Code traffic.** The proxy already handles that when an
  upstream key is set; it is idle for unrelated reasons.
- **Changing the default privacy mode.** `local` stays the default. Cloud raw
  content requires explicit opt-in, as it does today.

## Architecture

### Capture

A new adapter reads `~/.claude/projects/**/*.jsonl`, tailing files as Claude
Code appends. Each assistant turn becomes one `UsageEvent` with
`grain: "request"`, features derived from the **actual** prompt and response,
and content attached subject to the privacy gate.

Practical constraints the implementation must handle:

- **Scale.** 1,455 files, the largest 18 MB. Reading them whole on every poll is
  not viable; the adapter must track per-file offsets and resume.
- **Idempotence.** `buildEventId` hashes `machineId | app | providerRequestId |
  fingerprint | timeBucketSec`. Session JSONL carries a stable per-turn
  identifier — use it, so re-reading a file cannot double-count.
- **Rotation and concurrent writes.** Claude Code appends to the file that is
  currently open; a partial final line is normal and must be skipped, not
  parsed as corrupt.

`sources.claude_code_path` already accepts a file or a directory, so the config
surface exists.

### Redaction

The permanent summary carries **shape plus a redacted skeleton**:

- **Shape** — turn count, prompt and response lengths, code-fence count,
  file-paste and file-dump indicators, model, timestamp. Copies no content.
- **Skeleton** — the prompt with identifiers, string literals, numbers, emails,
  URLs and paths replaced by typed placeholders, preserving only structural
  tokens.

**This is the highest-risk component in the design, and it must be treated as
such.** Redaction is heuristic. A heuristic that fails once has written PII into
permanent storage under a field name asserting it is safe — worse than never
claiming safety. Accordingly:

- It gets its own adversarial test suite: emails in unusual formats, secrets in
  code comments, base64 blobs, paths with usernames, JWTs, connection strings,
  names in prose.
- It fails **closed**. Anything the redactor cannot confidently classify is
  dropped, not passed through. An unhelpful skeleton is acceptable; a leaky one
  is not.
- It has a hard length ceiling, so a redaction miss cannot store an entire
  document.
- The skeleton is derived **once, at recommendation time**, from content that is
  still within its 2-hour window — never re-derived later from data that no
  longer exists.

Prose is the case where redaction is weakest: "summarise this email from
Dr. Chen about the Aldridge matter" has no syntax to key on. The ceiling and
fail-closed rule are what keep that bounded.

### Evidence on the card

A recommendation gains linked evidence: up to three example events, each showing
shape always, and the raw text only while it remains within its window. The UI
must distinguish "content expired" from "no content captured" — they mean
different things, and conflating them repeats the absent-versus-zero mistake the
previous branch existed to fix.

## Migration

The 712 OTEL-derived events **stay**. They are 318M tokens of real spend history
and the ledger must remain continuous across the switch. Once the deployed agent
carries the merged `grain` change they are marked `aggregate`, so per-request
rules ignore them while aggregate rules continue to use them.

Cutover order matters: update the agent first (so JSONL capture is verified
working), then disable the OTEL receiver. A gap is recoverable; double-counting
is not.

## Testing

- **Adapter**: a fixture session file produces one event per assistant turn with
  correct token counts; re-reading produces no duplicates; a truncated final
  line is skipped; offsets resume correctly across restarts.
- **Features are real**: `promptChars` matches the actual prompt length, not a
  synthetic string. Pin this explicitly — it is the regression that started all
  of this.
- **Redaction**: the adversarial suite above, each case asserting the secret does
  not appear in the output. Plus a property test: no substring of length ≥ 8
  from the input appears in the skeleton unless it is a structural token.
- **Retention**: content is unreachable after its window; the summary is not.
- **Ledger invariance**: switching capture must not change historical totals.

## Risks

- **Redaction leaking PII into permanent storage.** The one that would matter and
  be hard to detect. Mitigated by fail-closed, a length ceiling, and adversarial
  tests — none of which prove correctness on unseen input.
- **Double-counting during cutover** if both paths run. Mitigated by ordering.
- **Session files are large and numerous**; a naive implementation could read
  hundreds of megabytes per poll.
- **Claude Code's JSONL format is not a published contract** and may change. The
  adapter should tolerate unknown fields and skip unparseable turns rather than
  failing the whole file.

## Follow-ups

- Postgres test harness (`@electric-sql/pglite`) — the previous branch shipped
  repo-layer SQL that has never executed
- Outbox pruning and an indexed timestamp column
- Retiring the unused `~/.tokenops/claude-code-usage.jsonl` path once the new
  adapter lands
