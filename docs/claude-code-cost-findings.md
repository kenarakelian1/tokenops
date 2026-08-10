# What Claude Code usage actually costs — measured

**Date:** 2026-08-10
**Status:** Findings. No design decision taken.
**Source:** `~/.claude/projects`, 200 session files modified in a trailing 7-day window, 13,682 unique API responses, deduplicated by `message.id`.

## Why this exists

The `feat/claude-session-adapter` branch was built to make three per-request efficiency rules — `frontier_trivial`, `full_document_io`, `context_bloat` — fire on real Claude Code data instead of on the fabricated features an OTLP metric produces. It succeeded at reading the data and failed at the premise: run over a real week, the rules yield roughly **24 findings from 14,546 turns**.

That is not a threshold-tuning problem. The rules were designed for API-style traffic — pick a cheaper model, send excerpts instead of whole documents, trim conversation history — and a coding agent's economics are different in kind. These are the measurements that show how.

## The measurements

### Where the input tokens go

| Component | Tokens | Share of tokens | Billed at |
|---|---:|---:|---|
| Raw (uncached) input | 109,464 | **0.0%** | 1.00× |
| Cache **read** | 4,294,512,099 | 96.7% | 0.10× |
| Cache **creation** | 145,374,357 | 3.3% | 1.25× |

Converting to effective cost units (tokens × multiplier):

| Component | Share of input cost |
|---|---:|
| Cache read | 70.3% |
| **Cache creation** | **29.7%** |
| Raw input | 0.0% |

### Context size per response

| Percentile | Tokens |
|---|---:|
| p50 | 233,438 |
| p90 | 721,478 |
| p99 | 943,266 |
| max | 998,027 |

### Other structure

- **Subagent share:** 4,423 of 13,682 responses are sidechains — **32.3%** of all API responses.
- **Model mix:** `claude-opus-5` 63%, `claude-sonnet-5` 24%, `claude-opus-4-8` 11%, `claude-haiku-4-5` 2%.
- **Cache read ratio:** p10 = 0.983, **p50 = 0.997**.

## What this means for the five existing rules

**`cache_efficiency` is dead for this workload.** It fires when the cache-read ratio falls below 0.50. The measured median is **0.997**. The 47.4% sample that motivated the threshold was a single cold-cache turn; steady state is near-perfect. This rule cannot fire and no threshold tuning saves it — the behavior it looks for does not occur.

**`full_document_io` is advising against something that is already free.** It fires on prompts above 20,000 characters with a high file-dump score, on the theory that pasting whole documents wastes input tokens. But **raw uncached input is 0.0% of the bill**. A pasted document costs full rate exactly once and is then read from cache at 0.1× forever. Only 40 of 14,546 turns even reached the character gate, and `fileDumpScore`'s p90 is 0.301 against a 0.55 threshold — Read output carries no code fences, which is most of what the score keys on.

**`context_bloat` measures the wrong growth.** Its gate is "input grew 1.8× since the session's baseline while little new content was added." With a cache-dominated context that grows gradually and a baseline that is in practice 20 turns back rather than the session's first turn, the growth gate passed 20 times in 14,302 turns. The underlying concern — enormous contexts — is real (p90 is 721k tokens), but 1.8× growth is not how it shows up.

**`frontier_trivial` cannot fire, correctly.** It caps at 200 total tokens; the median turn carries 233,438. A coding-agent turn is never trivial.

**`frontier_share` is the one that transfers.** 63% of responses are `claude-opus-5`, and that is a real, actionable mix question.

## Where the money actually is

Three signals the current rules do not look at:

**1. Cache creation is 3.3% of tokens and 29.7% of the input bill.** Every cache write costs 12.5× a cache read. High creation relative to read means the cached prefix keeps getting invalidated — by edits to files already in context, by tool output landing mid-prefix, by anything that changes the front of the conversation. This is the single largest addressable line item, and nothing currently measures it.

**2. Context size is the volume driver.** At p90 the context is 721,478 tokens, re-read every turn at 0.1×. On `claude-opus-5` that is roughly $0.36 per turn in cache reads alone before the model writes a word. The actionable question is not "did the context grow 1.8× since turn one" but "is this session carrying a context far larger than the work requires."

**3. A third of spend is invisible.** 32.3% of API responses are subagent turns. They share the parent's `sessionId` but have independent context, and nothing attributes cost to the subagent that incurred it or to the task that spawned it.

## The honest conclusion

The adapter's mechanics are sound and its measurements are trustworthy — the offset handling, UTF-8 correctness, truncation-race guard and OTLP scoping all survived adversarial review. What did not survive is the assumption that rules written for API traffic describe a coding agent's costs.

A rule set fitted to this workload would look at cache churn, absolute context size, and subagent attribution. That is a different design, not a retune, and it should start from these numbers rather than from the existing rules.

## Reproducing this

The measurements come from reading `~/.claude/projects/**/*.jsonl`, filtering to `type: "assistant"` lines carrying `message.usage`, and **deduplicating by `message.id`** — Claude Code writes one line per content block, so a naive per-line count inflates everything by ~2.1×. That inflation is itself the critical defect that stopped the branch; see the branch's review record.
