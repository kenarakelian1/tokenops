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

## What the session rules actually surface (measured 2026-08-11)

The two session-grain rules built to replace `cache_efficiency` — `session_context_ceiling` and `session_cache_churn` — were replayed against the same `~/.claude/projects/**/*.jsonl` history using `scripts/measure-session-rules.mjs`, over a 7-day window, before being called done. This is the acceptance gate the previous rule set never had.

The gate checks two things: an empty finding set (the rules never fire) and a noisy one (the rules fire on most sessions instead of an exceptional few). The noise check is against the pre-cap finding count — every hit a rule produces before its top-10-per-rule display cap — not the post-cap "cards shown" count, since post-cap is bounded above by `10 × (number of rules)` regardless of how often a rule actually fires and so could never trip a ceiling on its own.

```
window:                7 days
sessions:              24
turns (deduped):       15,567
unattributed turns:    4,897 (481.9M tokens)

session_context_ceiling: 17 sessions fire (70.8% of 24), top 10 shown, $898.29 API-equivalent
session_cache_churn: 1 sessions fire (4.2% of 24), top 1 shown, $60.34 API-equivalent

CARDS SHOWN: 11
PRE-CAP FINDINGS: 18 (noise ceiling: 24)
PASS: bounded, non-empty finding set.
```

24 sessions were considered, built from 15,567 deduped turns; 4,897 turns (481.9M tokens) were sidechain and carry no `sessionId`, so they are counted as unattributed rather than attributed to any session. `session_context_ceiling` fires on 17 of the 24 sessions — **70.8%** — capped to the top 10 by estimated waste, $898.29 API-equivalent. `session_cache_churn` fires on 1 of 24 — **4.2%** — $60.34 API-equivalent. 11 cards total are shown to the user; 18 pre-cap findings were produced against a noise ceiling of 24 (half of the 48 possible session×rule pairs across 24 sessions and 2 rules).

`session_context_ceiling` firing on 17 of 24 sessions — about 71% — is a high proportion for a rule meant to flag an exceptional condition rather than describe the norm. It is not disqualifying on its own (the underlying workload does run consistently large contexts, as the earlier measurements in this document show), but it means the rule is closer to "most sessions in this window" than to "an outlier worth a card," and that is worth watching if it holds over a longer window or a different set of projects. The script deliberately does not gate on this fire-rate number — one week of one developer's history is too small a sample to justify a threshold on it, and inventing one would repeat the mistake this document exists to catch.

The absolute dollar figures above will drift slightly between runs of this script even with no code changes: the scan window is mtime-based (`WINDOW_DAYS` days back from "now"), so as time passes the same 7-day window rolls forward and picks up newer turns while dropping older ones. That is expected drift, not a discrepancy to investigate.
