# TokenOps Design Spec

**Date:** 2026-07-27  
**Status:** Draft for user review  
**Repo:** `tokenops` (greenfield monorepo)

## 1. Problem

Token spend is fragmented across providers, coding agents, and machines. Dashboards from vendors show invoices, not *why* tokens are wasted (frontier model for trivial tasks, full-document I/O, context bloat). There is no single ledger that spans apps and computers with actionable efficiency advice.

## 2. Goals

### Product goals

- **Unified ledger:** tokens and estimated cost by time, machine, app, model, and source.
- **Cross-machine:** one account merges usage from every computer running the agent.
- **Inspection:** request-level features (and optional content) power efficiency recommendations.
- **Open source + free tier:** full stack is OSS and self-hostable; hosted free tier is convenience (and later optional hosted LLM-judge), not a closed core.

### Phase 1 success (thin slice of all three)

1. Credible multi-machine ledger (tokens + estimated $).
2. Two Phase 1 capture paths: OpenAI-compatible local proxy + Claude Code adapter.
3. At least three high-confidence rule-based recommendations with estimated savings.
4. Configurable privacy on the local agent (metadata always; content optional with TTL).

### Non-goals (Phase 1)

- Cursor, Gemini, browser-chat, or other adapters (catalog expands later).
- Multi-tenant orgs, SSO, invites, roles.
- Automatic model routing / rewriting requests (observe + advise only).
- LLM-as-judge recommendations (architecture leaves a hook; not required for v1 free tier).
- Perfect provider billing parity (public price tables + overrides are enough).
- Mobile apps or advanced BI.

## 3. Users and distribution

| Aspect | Decision |
|--------|----------|
| v1 users | Single user per account; many machines and apps |
| License | MIT (default) or Apache-2.0 if patent grant preferred at init |
| Local app | Open source agent per machine |
| Cloud | Same codebase self-hosted (Docker Compose) or hosted free tier |
| Later | Free tier limits on hosted; self-host unlimited by software |

## 4. Architecture

### Shape: sidecar agent + thin API + web dashboard

```
┌─────────────────────────────┐     ┌──────────────────────────────┐
│  Machine (local agent)      │     │  Cloud / self-host           │
│                             │     │                              │
│  • OpenAI-compatible proxy  │────▶│  API (ingest, query, recs)   │
│  • Claude Code adapter      │     │  Postgres (ledger + aggs)    │
│  • Privacy / retention cfg  │     │  Rule engine (efficiency)    │
│  • Offline queue            │     │  Web dashboard               │
│  • Machine identity         │     │  Auth (single-user v1)       │
└─────────────────────────────┘     └──────────────────────────────┘
         ▲                                      │
         │ point base_url here                  │ Railway free tier
    apps / SDKs / Claude Code                   │ or Docker Compose
```

### Component responsibilities

| Piece | Does | Does not (v1) |
|-------|------|----------------|
| Local agent | Capture, privacy gate, tag machine/app, queue & ship | Host multi-machine dashboard |
| Proxy | OpenAI-compatible chat/completions (+ embeddings if cheap); measure tokens; optional body retention | Replace every proprietary wire protocol forever |
| Claude Code adapter | Normalize Claude Code usage into shared event schema | Full IDE marketplace plugins |
| Cloud API | Auth, ingest, aggregate, run rules, serve dashboard data | Multi-tenant billing |
| Dashboard | Spend/tokens, breakdowns, recommendations, machines | Fancy BI |
| Rule engine | Three efficiency rules on event features | LLM-as-judge everywhere |

### Trust and privacy

- **Upstream provider API keys stay on the machine only.** Never sent to cloud.
- Cloud always receives **metadata + derived features**.
- **Content** (raw or lightly redacted request/response) is governed by local config:
  - `off` — never store content
  - `local` — store only on machine for TTL, ship features only
  - `cloud_ttl` — ship content with short cloud retention (e.g. 7 days), then drop to features-only
- Local config file example path: `~/.tokenops/config.toml`.

## 5. Event model

Every observed call becomes a **usage event**. Optional **payload** is separate and TTL-scoped.

### Usage event (always)

| Field | Description |
|-------|-------------|
| `event_id` | Idempotent ID (see below) |
| `timestamp` | When the request completed (UTC) |
| `machine_id` | Stable per install |
| `machine_name` | Human label |
| `app` | e.g. `openai-proxy`, `claude-code`, later `cursor`, … |
| `provider` | e.g. `openai`, `anthropic`, `unknown` |
| `model` | Model string as used |
| `input_tokens` | From usage object or estimate |
| `output_tokens` | From usage object or estimate |
| `cost_usd` | Nullable estimate from price table |
| `latency_ms` | Optional |
| `session_id` | Optional correlation |
| `features` | JSON object (see below) |
| `has_content` | Whether a payload was retained somewhere |

### Features (always, local extraction)

Derived without requiring cloud:

- Prompt/response character lengths
- Message count / role mix if available
- Approx “large paste” / code-fence / file-dump signals
- Model tier class (frontier / mid / small) from a maintained table
- Session-level context growth signal when `session_id` present

### Content payload (optional)

- Request/response bodies or redacted variants
- Subject to `content_mode` and TTL GC on agent and/or API

### Idempotency

`event_id` = stable hash of (`machine_id`, `app`, provider request id if present, else content/feature fingerprint + time bucket). Ingest is upsert-safe; partial batch retries do not double-count.

### Cost estimation

- Shared price table: model → USD per 1M input / 1M output tokens.
- User overrides in local and/or cloud settings.
- UI always labels money as **estimated**.
- Unknown model → tokens counted, `cost_usd = null`.

## 6. Local agent

### Capabilities

1. **OpenAI-compatible proxy** on `127.0.0.1` (default port `8787`):
   - Implement subset: `/v1/chat/completions` required; `/v1/embeddings` if low effort.
   - Forward to configured upstream with local API key (env or config, never synced).
   - Transparent to clients: same status/body as upstream when possible.
2. **Claude Code adapter**
   - Map usage into the shared event schema (`app=claude-code`).
   - Prefer official hooks/telemetry if available; otherwise documented log/usage file watch. Exact mechanism is an implementation spike, not an open product question.
3. **Privacy gate + feature extraction** before enqueue.
4. **Outbox** (SQLite): durable queue, exponential backoff flush to cloud.
5. **Identity:** `machine_id` + display name; heartbeats so dashboard shows last-seen and queue depth.
6. **CLI:** `tokenops status`, `tokenops agent run`, config init.

### Config sketch

```toml
[cloud]
url = "https://tokenops.example.com"
ingest_token = "..."

[privacy]
content_mode = "local"   # off | local | cloud_ttl
content_ttl_days = 7

[proxy]
listen = "127.0.0.1:8787"
upstream = "https://api.openai.com"
# API key via env — never synced to cloud

[sources]
openai_proxy = true
claude_code = true

[machine]
name = "desktop-main"
```

### Failure behavior

| Failure | Behavior |
|---------|----------|
| Upstream API error | Return same error to client; log attempt if possible |
| Cloud unreachable | Grow outbox; retry with backoff; surface last-sync in `status` |
| Feature extract error | Never fail the proxied request; best-effort features |
| Agent not running | Proxy down → client fails fast; docs: start agent first |

## 7. Cloud API and dashboard

### API

- `POST /v1/events` — batch ingest (agent PAT).
- `GET /v1/aggregates` — by day/machine/app/model.
- `GET /v1/events` — filtered list.
- `GET /v1/recommendations` — open/dismissed; `POST` dismiss/ack.
- `POST /v1/heartbeats` — machine last-seen, queue depth.
- `GET /health` — liveness.
- Dashboard session auth separate from ingest token (rotatable PAT).

### Auth (v1)

- Single-user account.
- Dashboard: email/password or magic link (no paid IdP required for self-host).
- Agent: personal access token scoped to ingest (+ heartbeat).
- Optional hosted IdP (e.g. Clerk) later; not a Phase 1 hard dependency.

### Dashboard screens

1. **Overview** — tokens & est. $ (today / 7d / 30d), top models, soft budget banner if set.
2. **Explore** — filters: machine, app, model, time; event table.
3. **Recommendations** — tips, severity, estimated waste, sample events, dismiss.
4. **Machines & sources** — last seen, sync health.
5. **Settings** — price overrides, budget threshold (in-app banner v1), content retention display of cloud policy.

### Hosted free tier (suggested defaults)

| Limit | Value |
|-------|--------|
| Users per account | 1 |
| Machines | 3 |
| Raw events retention | 30 days |
| Aggregates | Longer (e.g. 1 year) |
| Cloud content | Off by default; max TTL 7 days if enabled |
| Recommendations | Rules included; hosted LLM-judge not in free tier |
| Ingest | Soft rate limit |

Self-host: no artificial product limits.

## 8. Rule engine (Phase 1)

Rules run on ingest (and optionally nightly recompute). Each recommendation stores: rule id, severity, estimated wasted tokens/$, linked `event_id`s, status (`open` / `dismissed`).

### Rule 1 — Frontier for trivial

**Signal:** model tier = frontier AND input_tokens + output_tokens below a low threshold AND features indicate simple shape (few messages, small prompt).  
**Advice:** use a smaller/cheaper model for this class of task.  
**Savings estimate:** cost(frontier) − cost(default small model) for those tokens.

### Rule 2 — Full-document I/O

**Signal:** very large prompt and/or response; high “file dump / repeated blob” feature scores.  
**Advice:** send diffs, excerpts, or retrieved chunks instead of whole documents every turn.  
**Savings estimate:** fraction of input tokens attributed to bulk dump × price.

### Rule 3 — Context bloat

**Signal:** same `session_id` with rising input tokens and low new-content ratio across events.  
**Advice:** trim history, summarize, or drop stale files from context.  
**Savings estimate:** excess input tokens vs early-session baseline × price.

Rules are implemented in `packages/shared` so agent (local preview) and API (authoritative) can share logic. Authoritative recommendations for the dashboard are cloud-computed from ingested features.

## 9. Tech stack

| Layer | Choice |
|-------|--------|
| Monorepo | pnpm workspaces |
| Agent | TypeScript (Node) |
| Proxy | Node HTTP, OpenAI-compatible subset |
| API | Hono or Fastify on Node |
| DB | Postgres |
| Web | Vite + React (static) talking to API |
| Shared | Zod schemas, feature extractors, rules, price table |
| Agent local DB | SQLite outbox |
| Deploy | Docker Compose (api + web + postgres); Railway Dockerfiles / `railway.toml` |
| Tests | Vitest (unit/integration); thin Playwright smoke optional |

### Repo layout

```
tokenops/
  apps/agent/
  apps/api/
  apps/web/
  packages/shared/
  deploy/
  docs/
  tasks/
```

## 10. Data flow summary

### Proxy path

1. Client → local proxy → upstream.
2. Measure usage; extract features; privacy gate.
3. Outbox → `POST /v1/events`.
4. API upserts, aggregates, runs rules.
5. Dashboard reads aggregates + recommendations.

### Claude Code path

1. Adapter observes usage → same event schema.
2. Same outbox → ingest → rules → dashboard.

## 11. Security

- Provider secrets never leave the machine.
- TLS to cloud endpoints.
- Localhost proxy may be HTTP.
- Ingest tokens rotatable; store hashed at rest on API if practical.
- Content at rest: minimize; TTL GC mandatory when content enabled.
- OSS self-host: operator-controlled Postgres and encryption at rest via their infra.

## 12. Testing strategy

| Layer | Coverage |
|-------|----------|
| Unit | Feature extractors, three rules, cost table, privacy redaction, event_id stability |
| Integration | Ingest idempotency, aggregates, recommendation creation, outbox flush (test Postgres or equivalent) |
| Proxy | Mock upstream; assert client-visible response + recorded event fields |
| E2E (thin) | Seed events → recs via API; optional Playwright overview smoke |
| Product verification | Deployed Railway or Compose URL — not localhost manual demos as the primary gate |

## 13. Phased roadmap (post–Phase 1)

1. Additional adapters: Cursor, more providers, browser exports if feasible.
2. Richer features / optional LLM-as-judge on free or paid tier.
3. Budget alerts (email/webhook).
4. Multi-user / team (org model) when needed.
5. Optional auto-routing suggestions applied only with explicit user opt-in.

## 14. Open implementation notes (resolved at plan time, not product ambiguity)

- Exact Claude Code capture mechanism (hooks vs logs): spike in first implementation PR.
- Hono vs Fastify: pick one in implementation plan.
- MIT vs Apache-2.0: set at repository license file creation.
- Password vs magic-link for dashboard: pick simplest self-host-friendly option in plan.

## 15. Success metrics for Phase 1 ship

- [ ] Agent proxy: real OpenAI-compatible client completes a chat through proxy; event appears in cloud.
- [ ] Claude Code path: at least one real or fixture-backed usage path produces events.
- [ ] Second machine (or second `machine_id` in tests) merges on one dashboard.
- [ ] All three rules fire on synthetic fixtures with stable, tested thresholds.
- [ ] Privacy modes `off` / `local` / `cloud_ttl` covered by tests.
- [ ] `docker compose up` and Railway deploy path documented and working for API+web+Postgres.
- [ ] README: install agent, point client at proxy, connect Claude Code, open dashboard.

---

## Approval history

- Architecture (sidecar + cloud): approved
- Components & Phase 1 scope: approved
- Data flow, errors, testing: approved
- Stack, free tier, OSS packaging: approved
- Full written spec: pending user review
