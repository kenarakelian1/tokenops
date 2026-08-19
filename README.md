# TokenOps

**Open-source AI usage observability.** A local agent captures LLM calls on each machine; a cloud API stores aggregates and optional short-TTL content; a web dashboard shows spend, explore, and efficiency recommendations.

TokenOps answers: *where did my tokens go, across apps and computers — and what waste can I cut?*

Phase 1 includes:

- **Unified ledger** — tokens and **estimated** USD by time, machine, app, model, and source
- **Two capture paths** — OpenAI-compatible local proxy + Claude Code session-file adapter (reads Claude Code's own `~/.claude/projects` transcripts, nothing to install)
- **Five rule-based recommendations, in two classes** — three per-request rules (frontier-for-trivial, full-document I/O, context bloat) plus two window-aggregate rules (frontier-heavy token mix, low cache reuse); see [Recommendation rules](#recommendation-rules). **Four of the five do not fire on real Claude Code usage** — see [What works today](#what-works-today) before relying on them
- **Privacy controls** — metadata always; raw content optional (`off` / `local` / `cloud_ttl`)
- **Self-hostable** — MIT license, Docker Compose, Railway-ready

> Money in the UI is always labeled **estimated**. Provider API keys never leave your machine.

## What works today

Being straight about it, because the honest answer is more useful than the pitch:

**Works.** The ledger — capture, storage, and a dashboard showing tokens and estimated spend by time, machine, app, model and source. The OpenAI-compatible proxy. Privacy: features are derived on your machine, and prompt text never leaves it unless you explicitly opt in.

**Works as of v0.2.0: recommendations on Claude Code** — via two rules written for this workload rather than for API traffic. See [See your own numbers](#see-your-own-numbers) to run them against your history in about ten seconds, without deploying anything.

**The original five rules still do not fire on Claude Code, and that is correct.** They encode advice written for API traffic ("use a cheaper model", "send excerpts not whole files", "trim your history"), and a coding agent breaks every one of those assumptions. Rather than retune them, v0.2.0 retired `cache_efficiency` outright and added a session grain.

I measured a week of my own usage — 13,682 API responses — to check:

| | Measured |
|---|---|
| Raw, uncached input | **0.0%** of the bill |
| Cache reads | 70.3% of cost (96.7% of tokens, at 0.1×) |
| Cache creation | **29.7%** of cost (3.3% of tokens, at 1.25×) |
| Context per response | p50 **233,438** tokens, p90 721,478 |
| Subagent share | **32.3%** of responses |
| Cache-read ratio | p50 **0.997** |

So `full_document_io` warns against pasting documents when raw input is 0.0% of the bill; `cache_efficiency` triggers below a 0.50 read ratio against a measured median of 0.997; `frontier_trivial` caps at 200 tokens against a 233k median. Only `frontier_share` transfers.

Full method and numbers: [What Claude Code usage actually costs](docs/claude-code-cost-findings.md).

**What v0.2.0 did about it.** Measuring per *session* rather than per request moved the target, and corrected one of my own conclusions above: cache creation is 29.7% of the input bill, but it concentrates in **cheap** sessions — the 90 highest-churn sessions were only 8.2% of burn. Chasing it would have optimised the part that doesn't hurt.

The cost is in sessions that run for days and never reset. **21.1% of turns ran above 600k context and carried 46.9% of all cache reads**; holding context at 300k would have cut cache-read tokens **39.3%**. So:

- **`session_context_ceiling`** — turns above a 300k context target, priced against the same turns held at the target.
- **`session_cache_churn`** — cache writes dominating a session's input cost, billed at 12.5× the read rate.

Replayed over a real week: **11 cards from 23 sessions, ~$1,000 API-equivalent**, the largest a single 1,935-turn session alive for 171 hours.

**Two caveats I'd rather state than bury.** `session_context_ceiling` fires on roughly **7 in 10 sessions** — bounded in practice by savings-ranking and a 10-card cap, but weaker signal than a rule with that title implies. And the cards state a **bound, not a promised saving**: resetting a session costs you re-establishing context, which is why the disputable claim rides on each card as its assumption. Subagent turns carry no session id, so ~11% of consumption is attributed to nothing and the panel says so.

If your numbers look different from mine, please open an issue; one week of one developer is not a dataset.

### See your own numbers

No account, no deployment, no data leaving your machine — it reads `~/.claude/projects` directly:

```bash
pnpm install && pnpm -r build
node scripts/measure-session-rules.mjs           # summary + pass/fail gate
node scripts/measure-session-rules.mjs --detail  # every card: which session, what it cost
WINDOW_DAYS=30 node scripts/measure-session-rules.mjs --detail
```

`--detail` prints exactly the cards the dashboard would show, ranked by savings. This is also the acceptance gate for the rule set itself: it exits non-zero both when nothing fires *and* when too much does, so an overtuned rule fails the build rather than filling a panel with noise.

### Will I make it to reset?

```bash
node scripts/measure-forecast.mjs           # both windows, pace, projection
node scripts/measure-forecast.mjs --detail  # plus your hour-of-week activity model
```

Anthropic publishes no quota for subscription plans and exposes none
programmatically, so this never invents one. With no configuration it
compares your pace against **your own history** — your highest week ever is a
lower bound on your real limit, because you reached it. Mark a real limit hit
in the app and the projection switches to that instead, and says so.

Replayed over 37.5 days of my own history (42,610 deduped events from 90,293
raw assistant lines, a 2.12x dedup ratio — local retention doesn't go back
further than that): the gate itself passes — every figure finite, no
projection lands in the past, and candidate detection proposed **0** wall
candidates, comfortably under the noise ceiling of 5.

The gate isn't the real test, though. I ran out of usage roughly three days
before a weekly reset at some point while using this tool, and the honest
report is more specific than "detection missed it." The longest
zero-consumption gap anywhere in the retained history is **37.1 hours**; a
three-day outage is 72+ hours. No gap in the available data is even close to
long enough to be that event, so it cannot appear in this run's input
regardless of what the detector's thresholds are set to — it predates
2026-07-10, the earliest event local retention still has. **This run does
not test the detector's ability to catch that case, in either direction.**
What it does establish is precision: across all 18 real zero-consumption
gaps of 12+ hours in the window — a range of lengths and times of day — the
detector proposed zero false positives. Two gaps had a heavy-enough run-up
to pass that condition but were overnight (0 and 3 active hours, under the
4-hour bar); the one long daytime-spanning gap (37.1h, over a weekend) had a
run-up below the user's own top decile. **Recall remains untested** on this
data, and thresholds were not loosened to manufacture a hit anyway.

## Architecture

```
┌─────────────────────────────┐
│  Claude Code / OpenAI SDK   │
└─────────────┬───────────────┘
              │  localhost proxy :8787  or  JSONL tail
              ▼
┌─────────────────────────────┐
│  Local agent (per machine)  │
│  proxy · adapters · privacy │
│  SQLite outbox · heartbeat  │
└─────────────┬───────────────┘
              │  PAT  POST /v1/events, /v1/heartbeats
              ▼
┌─────────────────────────────┐
│  TokenOps API (Hono)        │
│  Postgres · aggregates      │
│  rules · content TTL job    │
└─────────────┬───────────────┘
              │  Clerk session JWT (Bearer)
              ▼
┌─────────────────────────────┐
│  Web dashboard (Vite/React) │
│  Overview · Explore · Recs  │
│  Machines · Settings        │
└─────────────────────────────┘
```

| Piece | Role |
|-------|------|
| `@tokenops/agent` | Capture, privacy gate, durable outbox, ship to cloud |
| `@tokenops/api` | Auth (Clerk-verified dashboard session + PAT), ingest, aggregates, recommendations |
| `@tokenops/web` | Dashboard UI |
| `@tokenops/shared` | Event schema, features, pricing, rules, privacy |

Compose runs **db** + **api** + **web** (nginx serves the SPA and proxies `/v1` and `/health` for same-origin API calls).

## Authentication

TokenOps uses [Clerk](https://clerk.com) for all human sign-in. **Every
deployment needs a Clerk application, including self-hosted ones.**
`docker compose up` alone does not yield a working login — Clerk is a hard
dependency, not an optional integration. Sign-up, password reset, and MFA are
handled by Clerk, so TokenOps runs no email infrastructure.

1. Create a free application at [dashboard.clerk.com](https://dashboard.clerk.com)
2. Set `CLERK_SECRET_KEY` on the API
3. Set `VITE_CLERK_PUBLISHABLE_KEY` on the web build (it is baked into the
   client bundle at **build** time — see [Web](#web-appsweb) below)

Agents authenticate separately with `tok_…` PATs and are unaffected by Clerk —
no change or re-install needed for existing agents. Create a PAT from the
dashboard once signed in, under **Settings → Agent access token**.

## Quick start (Docker Compose)

```bash
# From repo root
export CLERK_SECRET_KEY="sk_test_..."                   # required — from the Clerk dashboard
export VITE_CLERK_PUBLISHABLE_KEY="pk_test_..."         # required — web build fails without it
docker compose -f deploy/docker-compose.yml up --build
```

| URL | Purpose |
|-----|---------|
| http://localhost:8080 | Dashboard (nginx → static web + API proxy) |
| http://localhost:3000 | API direct (`GET /health` → `{ "ok": true }`) |
| `localhost:5432` | Postgres (`tokenops` / `tokenops` / `tokenops`) |

Sign in at http://localhost:8080 with Clerk (`@tokenops/web` embeds
`@clerk/react`'s `<SignIn />`); the API JIT-provisions a local `users` row on
first verified request. Then create an ingest PAT from the dashboard
**Settings** page, or directly against the API with a Clerk session JWT:

```bash
curl -X POST http://localhost:8080/v1/auth/pats \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <clerk-session-jwt>' \
  -d '{"name":"laptop-agent"}'
# → { "token": "…", "id": "…" }  — copy the token once; it is not shown again
```

There is no `POST /v1/auth/register` or `/v1/auth/login` — Clerk owns
sign-up and sign-in entirely; only `GET /v1/auth/me` and
`POST /v1/auth/pats` remain on the API, both behind a Clerk session JWT.

## Local agent: `tokenops init` + `agent run`

The agent runs on each machine that generates LLM traffic.

```bash
pnpm install
pnpm --filter @tokenops/agent build

# Optional: link CLI globally, or use pnpm exec / node path
pnpm --filter @tokenops/agent start -- init
# Writes ~/.tokenops/config.toml and machine identity

# Edit config: cloud URL, ingest token, machine name, privacy, sources
#   cloud.url           = "http://127.0.0.1:3000"   # or your hosted API
#   cloud.ingest_token  = "<PAT from above>"

export OPENAI_API_KEY=sk-...   # used only for proxy upstream — never sent to TokenOps
pnpm --filter @tokenops/agent start -- agent run
```

Useful commands:

| Command | Purpose |
|---------|---------|
| `tokenops init [--force]` | Default `~/.tokenops/config.toml` + machine identity |
| `tokenops agent run` | Start proxy, Claude Code watcher, outbox flush, heartbeats |
| `tokenops status` | Queue depth, last error, config paths |

Default config sketch (`~/.tokenops/config.toml`):

```toml
[cloud]
url = "http://127.0.0.1:3000"
ingest_token = ""

[privacy]
content_mode = "local"   # off | local | cloud_ttl
content_ttl_days = 7

[proxy]
listen = "127.0.0.1:8787"
upstream = "https://api.openai.com"
# API key via OPENAI_API_KEY env — never synced to cloud

[sources]
openai_proxy = true
claude_code = true
# claude_code_path defaults to ~/.claude/projects (what Claude Code already
# writes); override only if your sessions live somewhere else
# claude_code_path = "/path/to/.claude/projects"
claude_code_backfill_days = 7   # days of existing session history to read on first run

[machine]
name = "desktop"
```

Create an ingest PAT from the dashboard **Settings** page (or `POST /v1/auth/pats` while logged in).

## Point OpenAI / Grok (xAI) SDK at the local proxy

With the agent running, point any OpenAI-compatible client at the proxy. The agent measures usage, extracts features, enqueues events, and forwards the request upstream with your local key.

### OpenAI

```toml
# ~/.tokenops/config.toml
[proxy]
listen = "127.0.0.1:8787"
upstream = "https://api.openai.com"
```

```bat
set OPENAI_API_KEY=sk-...
tokenops agent run
```

Events use `app=openai-proxy`, `provider=openai`.

### Grok / xAI

```toml
[proxy]
listen = "127.0.0.1:8787"
upstream = "https://api.x.ai/v1"
```

```bat
set XAI_API_KEY=xai-...
tokenops agent run
```

Events use **`app=grok-proxy`**, **`provider=xai`**. Estimated prices for common `grok-*` models are in the shared price table.

```ts
import OpenAI from "openai";

const grok = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "not-used-upstream", // real key is XAI_API_KEY on the agent
});

await grok.chat.completions.create({
  model: "grok-4",
  messages: [{ role: "user", content: "hello" }],
});
```

### Shared client pattern (either provider)

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: process.env.OPENAI_API_KEY, // still required by many SDKs; proxy uses env upstream key
});

const res = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello from TokenOps" }],
  // Optional: correlates multi-turn context for the context_bloat rule
  // @ts-expect-error session_id is TokenOps-friendly metadata
  session_id: "my-coding-session",
});
```

- Default listen address: `127.0.0.1:8787`
- Captures **`POST /v1/chat/completions`** (other `/v1/*` paths are proxied without usage capture)
- Events: `app=openai-proxy` or `app=grok-proxy` depending on upstream
- Optional `session_id` / `sessionId` / `metadata.session_id` / OpenAI `user` → event `sessionId`
- If the cloud is down, events stay in the local SQLite outbox and flush when connectivity returns

## Claude Code (session files, default) + OpenTelemetry (other emitters)

### Default: Claude Code's own session files

When `sources.claude_code = true` (the default), the agent watches Claude
Code's own session transcripts — the `*.jsonl` files Claude Code already
writes on every session. There is nothing to configure or install: no
telemetry env vars, no collector, no separate usage log to point at.

- **Default path:** `~/.claude/projects`. **Override:** `sources.claude_code_path` in config, to any directory Claude Code writes sessions under.
- The watcher recurses into every `*.jsonl` under that root and emits **one event per API response** (`app=claude-code`, `grain: "request"`). Not one per line: Claude Code writes one line per assistant *content block*, so a response with a text block plus three tool calls is four lines sharing one `message.id` and carrying identical input usage. Events are coalesced on `message.id` and take the last block's token counts, which are the authoritative ones.
- **Known gap, stated rather than left to be discovered:** a response is held until the next one begins, so the **final response of a session that has ended is never emitted**. Measured over 120 real session files: 98.2% of responses, 99.2% of input tokens, **93.6% of output tokens**. The under-count is one-directional and bounded — nothing is ever counted twice. Closing it needs a delta-emit on a reappearing `message.id`; an earlier attempt that flushed on file idleness was reverted because a tool call outlasting the poll made it split ~34% of responses and double-count their input. See the comment on `createSessionParser` in `apps/agent/src/adapters/claude-session.ts`.
- **First run:** reads `sources.claude_code_backfill_days` (default **7**) of existing history by file mtime, capped at **20,000 events** per scan so a large `~/.claude/projects` (easily upward of a gigabyte across a thousand-plus session files) can't stall startup. Anything the cap defers is retried on the very next poll with a fresh 20,000-event budget — deferred, never lost, though a backlog larger than one poll's budget can take more than one poll to fully catch up.
- Per-file read offsets are persisted (`~/.tokenops/session-offsets.db`), so a restart resumes tailing instead of re-reading everything.

**Privacy — this is the property that matters most, so it's stated plainly
rather than left for you to infer:** the per-request features this adapter
reports (prompt length, message count, paste/file-dump score, model tier,
and so on) are all computed **on your machine**, from the session text on
disk. The adapter never attaches raw prompt or response text to an event —
`hasContent` is always `false` and no `content` field is ever set. Only the
derived integers and token counts leave the device. This holds **regardless
of `[privacy].content_mode`** — `content_mode` governs whether this agent
*additionally* ships raw content it captured, and this adapter never
captures any raw content to begin with, so there is nothing for that setting
to gate here.

### Which recommendation rules this makes live — and which it doesn't

Session-file events carry real per-request features, which is what makes
the per-request rules capable of firing at all (see [Recommendation
rules](#recommendation-rules) for the full list):

- **`context_bloat`** fires — it reads a session's input-token growth across turns, which `sessionId` + per-turn `inputTokens` from session files supply directly.
- **`full_document_io`** fires — it reads prompt length and file-dump score, both derived from the real message text on disk.
- **`frontier_trivial` will not fire on Claude Code data, by design.** It requires a request at or under **200 total tokens**; a real Claude Code turn — system prompt, tool definitions, conversation history — runs on the order of **55,000 tokens**. No genuine Claude Code session gets small enough to cross that threshold. If you install this adapter and wait for a `frontier_trivial` card from Claude Code usage, none will arrive — that's the rule correctly staying silent on data it structurally cannot apply to, not a bug in the tool. (`frontier_share`, the window-aggregate rule that asks a similar question at the 7-day-total level instead of per-request, is unaffected and still runs.)

### OpenTelemetry stays available — scoped to other emitters

With the agent running (`tokenops agent run`), the OTLP HTTP metrics
receiver still listens by default on **`127.0.0.1:4318`**, and is still
useful for anything else that speaks OTLP/HTTP JSON (Codex, Gemini, a
collector forwarding other tools' metrics). But **while `sources.claude_code
= true`, every `claude_code.*` metric arriving at that receiver is dropped
at the door** (logged once at startup), so the same Claude Code turns are
never counted twice — once from the session file, once from OTEL. This is
enforced in code, not left to configuration, because a doubled ledger is the
one failure this cutover cannot recover from.

If you want Claude Code's own OTEL metrics instead of the session-file
adapter (coarser: aggregate-only, no per-request features), turn off
`sources.claude_code` and point Claude Code's telemetry at the agent (use
**HTTP JSON**, not gRPC — TokenOps does not speak OTLP/gRPC yet):

```bash
# Windows PowerShell
$env:CLAUDE_CODE_ENABLE_TELEMETRY = "1"
$env:OTEL_METRICS_EXPORTER = "otlp"
$env:OTEL_EXPORTER_OTLP_PROTOCOL = "http/json"
$env:OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318"
claude
```

```bash
# bash / macOS / WSL
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
claude
```

Config (`~/.tokenops/config.toml`):

```toml
[sources]
claude_code = false                          # let OTEL own capture instead of session files
claude_code_otel_listen = "127.0.0.1:4318"   # empty string disables the OTEL receiver
```

Metrics mapped into the ledger (`app=claude-code`, `grain: "aggregate"`):

| Metric | Use |
|--------|-----|
| `claude_code.token.usage` | Input/output/cache tokens → usage events (counter deltas) |
| `claude_code.cost.usage` | Session cost when present (else price-table estimate) |

OTEL-only events carry no per-request features (only `modelTier`), so only
`frontier_share` and `cache_efficiency` — the window-aggregate rules — can
fire from them; see [Why per-request rules don't fire for OTEL-only
users](#why-per-request-rules-dont-fire-for-otel-only-users).

> Your snippet with `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` and port **4317** is the default OTEL collector setup. Point Claude at **TokenOps** with **`http/json` + 4318** instead, or run an OTEL Collector that forwards metrics to TokenOps HTTP.

### Legacy fallback: custom usage JSONL (no caller today)

Before the session-file adapter existed, the agent could tail a bespoke
`~/.tokenops/claude-code-usage.jsonl` file — a format nothing writes out of
the box. That code
(`apps/agent/src/adapters/claude-code.ts`, fixture at
`apps/agent/test/fixtures/claude-code-usage.jsonl`) is kept in the tree and
its tests still run, but `agent-main.ts` no longer calls it: the session-file
adapter above is what actually runs when `sources.claude_code = true`. See
the retention comment at the top of that file for why it's kept rather than
deleted.

## Privacy modes

Configured under `[privacy]` in `config.toml`. **Metadata + features always ship.** Content (request/response bodies) is gated:

| Mode | On device | Shipped to cloud |
|------|-----------|------------------|
| `off` | No content stored | Features + metadata only |
| `local` (default) | Content may be kept locally for inspection | Features + metadata only |
| `cloud_ttl` | Same as local extract | Content stored in cloud with **7-day TTL**, then deleted; aggregates/features remain |

- Provider **API keys never appear in ingest payloads** (proxy tests assert this).
- Cloud content rows expire via the API expire-content job; `has_content` is cleared on the usage event.

## Free tier and self-host

| Mode | How |
|------|-----|
| **Self-host** | Compose or your own Postgres + containers. `HOSTED_LIMITS` defaults **false** — unlimited machines; leave `RAW_EVENT_RETENTION_DAYS` unset for unlimited raw event retention. |
| **Hosted free tier** | Deploy with `HOSTED_LIMITS=true`: max **3 machines** per user (heartbeat/ingest returns `403 { "error": "machine_limit" }` for a 4th `machine_id`); default **30-day** raw `usage_events` retention. Daily aggregates are kept. |

Content TTL (7 days) applies whenever content was ingested under `cloud_ttl`, self-host or hosted.

See [Environment variables](#environment-variables) and [Railway](#railway) below.

## Dashboard

After Compose is up and you have logged in:

1. **Overview** — tokens & est. $ (today / 7d / 30d), top models
2. **Explore** — filter by machine, app, model, time
3. **Recommendations** — five efficiency rules in two classes, with estimated waste; dismiss when done (see [Recommendation rules](#recommendation-rules))
4. **Machines** — last seen, sync health
5. **Settings** — budget banner threshold, **create agent PAT**, retention notes

## Recommendation rules

Five rule-based recommendations, in two classes: **per-request** rules that
inspect one event's derived features, and **window-aggregate** rules that
inspect per-model token totals over a trailing window. Which class runs for
you depends on your capture path.

| Rule | Class | Fires when | Source |
|------|-------|-------------|--------|
| `frontier_trivial` | per-request | A frontier-tier model handled a short request (≤2 messages, ≤200 total tokens, low paste score) with a cheaper same-vendor sibling model available | `packages/shared/src/rules/frontier-trivial.ts` |
| `full_document_io` | per-request | Prompt ≥20,000 chars with a high file-dump score (≥0.55) — a whole document pasted instead of an excerpt or diff | `packages/shared/src/rules/full-document-io.ts` |
| `context_bloat` | per-request | A session's input tokens grew ≥1.8× from that session's first event while under 25% of the growth was new content | `packages/shared/src/rules/context-bloat.ts` |
| `frontier_share` | window aggregate | Frontier-tier models account for more than 80% of tokens in the trailing 7-day window; names the dominant frontier model's cheaper sibling | `packages/shared/src/rules/aggregate/frontier-share.ts` |
| `cache_efficiency` | window aggregate | A model's cache-read tokens are under 50% of its input tokens for the window, and a cache breakdown was actually recorded | `packages/shared/src/rules/aggregate/cache-efficiency.ts` |

Every hit is also subject to a materiality floor (`packages/shared/src/rules/materiality.ts`)
— by default at least $0.01 estimated waste, or 5,000 tokens when cost is
unknown — so cheap, noisy findings never reach the panel.

**Writing your own rule:** the rule contract is published, and **outside rule
contributions are accepted**. See
[docs/rules/authoring.md](docs/rules/authoring.md)
([rendered](docs/rules/authoring.html)) for the interface, an annotated
worked example, how to choose a counterfactual, the invariants a rule must
not break, the fixture-driven test pattern, and which types are stable.

### Why per-request rules don't fire for OTEL-only users

`frontier_trivial`, `full_document_io`, and `context_bloat` read a single
event's `features` — prompt chars, message count, paste/file-dump score, and
(for `context_bloat`) that event's same-session history. An aggregate has
none of that: it's a time-bucketed sum, not a request. `runRules` enforces
this centrally by discarding every `grain: "aggregate"` event before any
per-request rule runs (`packages/shared/src/rules/index.ts`), rather than
trusting each rule to opt out on its own.

Of TokenOps' capture paths, two produce per-request events and can trigger
these three rules: the **OpenAI-compatible local proxy** and the **Claude
Code session-file adapter** (both build full `features` per call — see
`apps/agent/src/adapters/claude-session.ts` and the proxy under
`apps/agent/src/proxy/`). The **Claude Code OTEL metrics receiver**
(`apps/agent/src/adapters/claude-otel.ts`) cannot: Claude Code's
`claude_code.token.usage` counter carries only a token `type` and `model`,
with no prompt or message to derive features from, so every event it emits
is stamped `grain: "aggregate"` and is gated out.

This means **a user whose only capture path is Claude Code OTEL will never
see `frontier_trivial`, `full_document_io`, or `context_bloat` fire** — that
is expected, not a bug. Note this is a stricter gap than the session-file
adapter's own `frontier_trivial` gap described above: OTEL loses all three
per-request rules to missing features, where the session-file adapter has
real features but still can't cross `frontier_trivial`'s 200-token cap with
genuine Claude Code turn sizes. They still get `frontier_share` and
`cache_efficiency`: those two rules run hourly against 7-day per-model token
totals built from every ingested event regardless of grain or capture path
(`apps/api/src/jobs/aggregate-rules.ts`), so OTEL-only usage still populates
the Recommendations panel, just from the aggregate class only.

### Cache token fields

Usage events may carry `cacheReadTokens` / `cacheCreationTokens`
(`packages/shared/src/schema/event.ts`), populated today by the Claude Code
OTEL receiver. They are **additionally counted inside `inputTokens`, not on
top of it** — `inputTokens` already includes cache-read and cache-creation
tokens, matching what the provider actually billed. Ledger totals
(`inputTokens + outputTokens`) are exactly the same whether or not an event
reports a cache breakdown. **Do not add `cacheReadTokens` /
`cacheCreationTokens` to `inputTokens` when computing spend or token
totals** — that double-counts every Claude Code OTEL user's usage.

`null` and `0` mean different things for these fields, and the distinction
is load-bearing for `cache_efficiency`: `null` means no cache breakdown was
ever recorded (no capture path had reported one yet when the event was
written); `0` means a breakdown was recorded and reuse was genuinely zero.
Summing a `null` as `0` would either wrongly silence a real "paying full
price for context" finding, or wrongly manufacture a "low cache reuse" card
on a window straddling the day cache reporting was added. See the doc
comment on `packages/shared/src/rules/aggregate/cache-efficiency.ts` for how
the rule preserves this distinction.

## Environment variables

### API (`apps/api`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | yes | — | Postgres connection string |
| `PORT` | no | `3000` | HTTP port |
| `HOST` | no | `0.0.0.0` | Bind address |
| `HOSTED_LIMITS` | no | unset/false | When `true`: max 3 machines; default 30-day raw event retention |
| `RAW_EVENT_RETENTION_DAYS` | no | unset | If set, delete `usage_events` older than N days (aggregates kept) |
| `CORS_ORIGIN` | no | unset | Single browser origin for credentialed CORS (prefer same-origin proxy) |
| `CLERK_SECRET_KEY` | yes | — | Clerk Backend API secret key; the API refuses to boot without it |
| `CLERK_JWT_KEY` | **recommended for production** | unset | PEM public key for networkless JWT verification |

**Set `CLERK_JWT_KEY` in production.** Without it, `verifyToken` fetches
Clerk's JWKS over the network on cache misses; if Clerk is unreachable, that
fetch fails and every request is rejected `401 unauthorized` — a Clerk outage
then looks to users exactly like a bad login, not an outage. Setting
`CLERK_JWT_KEY` (a PEM key from the Clerk dashboard, pinned to your instance)
makes verification fully networkless, so it keeps working through a Clerk API
outage.

### Accounts

The dashboard authenticates via [Clerk](https://clerk.com) — sign-up, sign-in,
and session management all live on Clerk's side. The API verifies the Clerk
session JWT on `Authorization: Bearer` and provisions (or adopts, by email) a
local `users` row on first sight (see `apps/api/src/auth/provision.ts`).
Agents keep using long-lived PATs (`POST /v1/auth/pats`), unaffected by this.

### Content TTL

- Optional request/response bodies in `event_content` expire after **7 days** (set at ingest).
- Hourly job (`apps/api/src/jobs/expire-content.ts`):
  1. `DELETE` expired `event_content`; set matching `usage_events.has_content = false`
  2. If `HOSTED_LIMITS=true` or `RAW_EVENT_RETENTION_DAYS` is set, delete old `usage_events` (default 30 days when hosted). **Daily aggregates are never deleted by this job.**

### Web (`apps/web`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_API_URL` | no | `""` (same origin) | API base URL at **build** time. Empty when nginx proxies `/v1` |
| `VITE_CLERK_PUBLISHABLE_KEY` | **yes, at build time** | — | Clerk publishable key baked into the client bundle; `vite build` throws and aborts the build if unset (see `apps/web/vite.config.ts`) |

### Compose helpers

See `deploy/env.example`. Compose defaults:

- `DATABASE_URL=postgres://tokenops:tokenops@db:5432/tokenops`
- `CLERK_SECRET_KEY` and `VITE_CLERK_PUBLISHABLE_KEY` are passed through from
  your shell env — **Compose will not sign in without `CLERK_SECRET_KEY`, and
  the `tokenops-web` image will fail to build without
  `VITE_CLERK_PUBLISHABLE_KEY`** (empty defaults to `""` in the `args:`/
  `environment:` blocks purely so `docker compose config`/`up db` don't abort
  on interpolation before you've exported them — the real failure surfaces
  loudly at API boot or web build time instead)
- Optional vars (`CLERK_JWT_KEY`, `CORS_ORIGIN`, `RAW_EVENT_RETENTION_DAYS`) are **omitted** when unset (empty strings would fail strict Zod validation without the API’s empty→undefined normalization)

## Railway

Hosted free-tier (this repo’s project):

| Service | URL |
|---------|-----|
| **Dashboard** | https://tokenops-web-production.up.railway.app |
| **API** | https://tokenops-api-production.up.railway.app |
| **Health** | https://tokenops-api-production.up.railway.app/health |

Prefer the **web** URL for login (nginx proxies `/v1` to `tokenops-api` on the private network, so the dashboard and API share one origin).

Self-deploy:

1. New project → add **Postgres** plugin (`DATABASE_URL` injected).
2. Deploy API from repo root with `railway.toml` / `deploy/api.Dockerfile`.
3. Set `CLERK_SECRET_KEY` (API refuses to boot without it). For hosted free tier set `HOSTED_LIMITS=true`. Set `CLERK_JWT_KEY` too — see [Environment variables](#api-appsapi) for why.
4. Deploy web as a second service (`deploy/web.Dockerfile`) so nginx can reach `tokenops-api:3000` on the private network.
5. **Before the web service's first build**, set `VITE_CLERK_PUBLISHABLE_KEY` as a Variable on that service. `deploy/web.Dockerfile` declares `ARG VITE_CLERK_PUBLISHABLE_KEY`, and Railway only populates a declared `ARG` from a service Variable of the same name at build time — there is no `railway.toml`/`railway.json` field that injects it for you (config-as-code there only covers `[build]`/`[deploy]`, not variables). **Skipping this step fails the web build outright**, because `apps/web/vite.config.ts` throws on a missing key instead of shipping a broken bundle.

Health check path: `/health`.

### Adoption verification (production cutover)

The production account (`kenarakelian1@gmail.com`) predates Clerk and has
`clerk_user_id IS NULL`. On first Clerk sign-in, `resolveUserId` (see
`apps/api/src/auth/provision.ts`) adopts that row by matching email, which
preserves its `id` — and therefore the existing PAT, machines, and usage
ledger that foreign-key to it. The email match is a plain lowercase
comparison, not Clerk's identity, so **anything other than a case difference
between the Clerk identity's primary email and the stored `users.email`
misses adoption silently** (no error, no `409`) and creates a second, empty
account instead. A Gmail dot-alias signed in via Google SSO (e.g.
`ken.arakelian1@gmail.com`) is exactly this trap. The symptom is an empty
dashboard after a fine-looking login; making a new PAT and reinstalling the
agent only compounds it, since the new PAT attaches to the new, empty
account.

**Recommended:** create the Clerk user directly with the exact production
address (Clerk dashboard → Users → Create), rather than letting the account
holder self-serve sign up (which may go through Google SSO and resolve a
slightly different address).

**Before deploying**, record the current state:

```sql
select id, email, clerk_user_id from users;
```

**After the first Clerk sign-in**, run it again and confirm:

- the **same** `id` as before,
- `clerk_user_id` is now set (non-null),
- still exactly **one** row.

If a second row appears, adoption missed (email mismatch). Do not create a
new PAT against it — instead, fix the Clerk user's primary email to match
`users.email` exactly (or update `users.email` to match Clerk, whichever is
correct), delete the erroneous second row, and re-authenticate.

### Migration 0002 rollback and rolling-deploy notes

- **No image rollback after migration 0002.** `apps/api/drizzle/0002_clever_the_hood.sql`
  drops the `sessions` table and adds `users.clerk_user_id`. A pre-branch API
  image finds no `sessions` table and 500s on every dashboard route, so once
  0002 is applied, rolling back the API image is not an option — roll forward
  only.
- **Before applying migration 0002**, check production for out-of-band
  dependents on `sessions` before running it, since the generated SQL uses
  `DROP TABLE ... CASCADE`:

  ```sql
  \d+ sessions
  -- and/or
  select * from pg_depend where refobjid = 'sessions'::regclass;
  ```

- **Brief agent-ingest errors during the rolling deploy are expected and
  self-healing.** Migration `0001_tiny_pandemic.sql` changes the `machines`
  primary key from `machine_id` alone to the composite
  `(user_id, machine_id)`. While the old API container is still serving
  traffic during the rollover, its `upsertMachine` still issues
  `ON CONFLICT ("machine_id")`, which Postgres rejects once the PK is
  composite. No data is lost — the agent's local outbox keeps the affected
  rows pending and retries until the new container is serving.

## Desktop agent (Windows)

The desktop app is the primary way to run the agent: a tray app, not a
console window you have to keep open.

### Download from GitHub Releases (recommended)

1. Open **[Releases](https://github.com/kenarakelian1/tokenops/releases)**
2. Download **`TokenOps-Setup-<version>.exe`**
3. Run the Setup wizard (per-user, no admin)
4. Start Menu → **TokenOps**

**Node.js is not required for this path.** Electron bundles its own Node
runtime, so nothing needs to be installed first.

> The Setup is not Authenticode-signed yet. If SmartScreen/Smart App Control
> warns: **More info → Run anyway**, or right‑click → Properties → **Unblock**.

#### Tray behaviour

Closing the window does **not** stop the agent — it hides the window to the
system tray and capture keeps running underneath, exactly like the console
window it replaces never had to stay open. Click the tray icon (or **Show
TokenOps** from its context menu) to bring the window back. **Quit** (from the
tray menu) is the only action that actually stops capture; it waits for the
outbox and proxy to shut down cleanly before the process exits.

The window itself shows **local-only** data — today's tokens/estimated cost,
capture status, and recent activity read straight from the machine's own
outbox. It does not show cloud history or recommendations; an **Open
dashboard** button opens the hosted/self-hosted dashboard in your default
browser for that.

### Portable ZIP (headless / server installs, no GUI)

For machines where you don't want a tray icon — servers, CI runners, remote
sessions — the original console-style install is still available:

1. Download **`tokenops-agent-win.zip`** from Releases
2. Unzip, double-click `install.cmd` (or `install.cmd -Quiet` for CI)
3. Start Menu → **TokenOps Agent** (or `tokenops agent run`)

**This path still requires [Node.js 22+](https://nodejs.org/)** on `PATH` —
it runs the CLI directly with your system Node, unlike the Setup above.

Uninstall: `uninstall.cmd` (portable) or **Apps & features** (Setup app).
Quiet portable: `install.cmd -Quiet` / `-NoStartup`.

### Migrating from an older install

If a previous Inno-based install left a `TokenOpsAgent` Task Scheduler entry
or a `%LOCALAPPDATA%\TokenOps\bin` PATH entry behind, installing the new
Setup removes both automatically (see `apps/desktop/build/installer.nsh`) so
the old console-mode agent and the new tray app don't both try to bind
`127.0.0.1:8787`. `~/.tokenops/config.toml` and `machine.json` are left
untouched, so the machine keeps its identity, PAT, and history across the
switch.

### Build from source

```bat
pnpm.cmd install
pnpm.cmd --filter "@tokenops/desktop..." build
pnpm.cmd --filter @tokenops/desktop exec electron-builder --win --publish never
```

Outputs `dist\TokenOps-Setup-<version>.exe`. For the portable ZIP payload
instead:

```bat
pnpm.cmd package:agent
```

Outputs `dist\tokenops-agent-win\` — portable folder + `install.cmd`.

Wizard options (portable installer): AI tools (Claude Code, Cursor, Grok/xAI,
OpenAI), PAT, optional API keys, start at Windows sign-in.

New release: tag `v*` and push, or run workflow **Release desktop agent**.

## Development

```bash
pnpm install
pnpm test                 # full monorepo Vitest suite
pnpm build                # build all packages
pnpm --filter @tokenops/api build
pnpm --filter @tokenops/web build
pnpm --filter @tokenops/agent build
```

| Package | Notes |
|---------|-------|
| `packages/shared` | Schema, pricing, features, rules — no I/O |
| `apps/api` | Needs `DATABASE_URL` + `CLERK_SECRET_KEY` for `pnpm --filter @tokenops/api dev` |
| `apps/agent` | Unit tests mock upstream; no live provider keys in CI |
| `apps/web` | `pnpm --filter @tokenops/web dev` for Vite (UI against Compose/Railway API preferred); `build` additionally requires `VITE_CLERK_PUBLISHABLE_KEY` or it throws |

**Policy:** automated tests run locally (Vitest + fixtures). Product verification (smoke, demos) uses Compose or Railway URLs — not ad-hoc localhost servers for “it works.”

Layout:

```
tokenops/
  packages/shared/     # Zod schemas, features, pricing, rules
  apps/agent/          # CLI, proxy, Claude Code adapter, outbox
  apps/api/            # Hono API + Drizzle + Postgres
  apps/web/            # Vite + React dashboard
  deploy/              # Compose, Dockerfiles, nginx, Railway
  docs/superpowers/    # Design spec + implementation plan
```

## License

MIT — see [LICENSE](./LICENSE).
