# TokenOps

**Open-source AI usage observability.** A local agent captures LLM calls on each machine; a cloud API stores aggregates and optional short-TTL content; a web dashboard shows spend, explore, and efficiency recommendations.

TokenOps answers: *where did my tokens go, across apps and computers — and what waste can I cut?*

Phase 1 includes:

- **Unified ledger** — tokens and **estimated** USD by time, machine, app, model, and source
- **Two capture paths** — OpenAI-compatible local proxy + Claude Code JSONL adapter
- **Three rule-based recommendations** — frontier-for-trivial, full-document I/O, context bloat
- **Privacy controls** — metadata always; raw content optional (`off` / `local` / `cloud_ttl`)
- **Self-hostable** — MIT license, Docker Compose, Railway-ready

> Money in the UI is always labeled **estimated**. Provider API keys never leave your machine.

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
              │  session cookie
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
| `@tokenops/api` | Auth (session + PAT), ingest, aggregates, recommendations |
| `@tokenops/web` | Dashboard UI |
| `@tokenops/shared` | Event schema, features, pricing, rules, privacy |

Compose runs **db** + **api** + **web** (nginx serves the SPA and proxies `/v1` and `/health` for same-origin cookies).

## Quick start (Docker Compose)

```bash
# From repo root
export SESSION_SECRET="$(openssl rand -hex 32)"   # required in production
docker compose -f deploy/docker-compose.yml up --build
```

| URL | Purpose |
|-----|---------|
| http://localhost:8080 | Dashboard (nginx → static web + API proxy) |
| http://localhost:3000 | API direct (`GET /health` → `{ "ok": true }`) |
| `localhost:5432` | Postgres (`tokenops` / `tokenops` / `tokenops`) |

Register the first (and only) user:

```bash
curl -X POST http://localhost:8080/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"at-least-8-chars"}'
```

After the first user, registration closes. Log in via the dashboard, then create an agent PAT:

```bash
# After login, session cookie is set. Create a personal access token:
curl -X POST http://localhost:8080/v1/auth/pats \
  -H 'content-type: application/json' \
  -b cookies.txt \
  -d '{"name":"laptop-agent"}'
# → { "token": "…", "id": "…" }  — copy the token once; it is not shown again
```

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

[machine]
name = "desktop"
```

## Point OpenAI SDK at the local proxy

With the agent running, point any OpenAI-compatible client at the proxy. The agent measures usage, extracts features, enqueues events, and forwards the request upstream with your local key.

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: process.env.OPENAI_API_KEY, // still required by many SDKs; proxy uses env upstream key
});

const res = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello from TokenOps" }],
});
```

- Default listen address: `127.0.0.1:8787`
- Phase 1 captures **`POST /v1/chat/completions`** (other `/v1/*` paths are proxied without usage capture)
- Events use `app=openai-proxy`
- If the cloud is down, events stay in the local SQLite outbox and flush when connectivity returns

## Claude Code JSONL path

When `sources.claude_code = true`, the agent watches a usage JSONL file and maps each line into the shared event schema (`app=claude-code`).

**Default path:** `~/.tokenops/claude-code-usage.jsonl`

Each line is one JSON object. Required fields: `model`, `inputTokens` (or `input_tokens`), `outputTokens` (or `output_tokens`). Optional: `timestamp`, `sessionId`, `requestPreview` / `responsePreview`.

Example line:

```json
{"timestamp":"2026-07-27T10:00:00.000Z","model":"claude-sonnet-4","inputTokens":1200,"outputTokens":350,"sessionId":"sess-1","requestPreview":"…","responsePreview":"…"}
```

### End-to-end fixture path

A checked-in sample log for tests and manual smoke:

```
apps/agent/test/fixtures/claude-code-usage.jsonl
```

To exercise the adapter against a running agent without live Claude Code:

```bash
# Agent must be running (tokenops agent run)
cp apps/agent/test/fixtures/claude-code-usage.jsonl ~/.tokenops/claude-code-usage.jsonl
# Or append more lines — the watcher tails the file
```

Then open the dashboard Explore view (or query `GET /v1/events`) after the next outbox flush (~5s).

> Phase 1 watches the default path under `~/.tokenops/`. If your Claude Code install writes elsewhere, symlink or copy into that path (a dedicated `claude_code_path` config field is a follow-up).

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
3. **Recommendations** — three efficiency rules with estimated waste; dismiss when done
4. **Machines** — last seen, sync health
5. **Settings** — budget banner threshold, retention notes

## Environment variables

### API (`apps/api`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | yes | — | Postgres connection string |
| `SESSION_SECRET` | yes | — | Secret for app / session integrity |
| `PORT` | no | `3000` | HTTP port |
| `HOST` | no | `0.0.0.0` | Bind address |
| `HOSTED_LIMITS` | no | unset/false | When `true`: max 3 machines; default 30-day raw event retention |
| `RAW_EVENT_RETENTION_DAYS` | no | unset | If set, delete `usage_events` older than N days (aggregates kept) |
| `CORS_ORIGIN` | no | unset | Single browser origin for credentialed CORS (prefer same-origin proxy) |
| `BOOTSTRAP_EMAIL` | no | — | Optional bootstrap email |
| `BOOTSTRAP_PASSWORD` | no | — | Optional bootstrap password |

### Content TTL

- Optional request/response bodies in `event_content` expire after **7 days** (set at ingest).
- Hourly job (`apps/api/src/jobs/expire-content.ts`):
  1. `DELETE` expired `event_content`; set matching `usage_events.has_content = false`
  2. If `HOSTED_LIMITS=true` or `RAW_EVENT_RETENTION_DAYS` is set, delete old `usage_events` (default 30 days when hosted). **Daily aggregates are never deleted by this job.**

### Web (`apps/web`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_API_URL` | no | `""` (same origin) | API base URL at **build** time. Empty when nginx proxies `/v1` |

### Compose helpers

See `deploy/env.example`. Compose defaults:

- `DATABASE_URL=postgres://tokenops:tokenops@db:5432/tokenops`
- `SESSION_SECRET` from env or a dev placeholder (change for real use)
- Optional vars (`BOOTSTRAP_*`, `CORS_ORIGIN`, `RAW_EVENT_RETENTION_DAYS`) are **omitted** when unset (empty strings would fail strict Zod validation without the API’s empty→undefined normalization)

## Railway

1. New project → add **Postgres** plugin (`DATABASE_URL` injected).
2. Deploy API from repo root with `deploy/railway.toml` / `deploy/api.Dockerfile`.
3. Set `SESSION_SECRET`. For a hosted free tier set `HOSTED_LIMITS=true`.
4. Deploy web as a second service (`deploy/web.Dockerfile`) behind one public host that can reach `api:3000` on the private network, **or** host static assets and set `CORS_ORIGIN` + build `VITE_API_URL` to the API public URL (cookie `SameSite=Lax` cross-site needs careful setup — same-origin proxy is preferred).

Health check path: `/health`.

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
| `apps/api` | Needs `DATABASE_URL` + `SESSION_SECRET` for `pnpm --filter @tokenops/api dev` |
| `apps/agent` | Unit tests mock upstream; no live provider keys in CI |
| `apps/web` | `pnpm --filter @tokenops/web dev` for Vite (UI against Compose/Railway API preferred) |

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
