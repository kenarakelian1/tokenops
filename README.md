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
export SESSION_SECRET="$(openssl rand -hex 32)"        # required at boot (unused; see env table)
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
# optional: override Claude Code JSONL path (file or directory)
# claude_code_path = "/path/to/claude-code-usage.jsonl"

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

## Claude Code (JSONL + OpenTelemetry)

### Preferred: OpenTelemetry metrics (official Claude Code telemetry)

With the agent running (`tokenops agent run`), default OTLP HTTP listen is **`127.0.0.1:4318`**.

In the shell where you launch Claude Code (use **HTTP JSON**, not gRPC — TokenOps does not speak OTLP/gRPC yet):

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
claude_code = true
claude_code_otel_listen = "127.0.0.1:4318"   # empty string disables OTEL receiver
```

Metrics mapped into the ledger (`app=claude-code`):

| Metric | Use |
|--------|-----|
| `claude_code.token.usage` | Input/output/cache tokens → usage events (counter deltas) |
| `claude_code.cost.usage` | Session cost when present (else price-table estimate) |

> Your snippet with `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` and port **4317** is the default OTEL collector setup. Point Claude at **TokenOps** with **`http/json` + 4318** instead, or run an OTEL Collector that forwards metrics to TokenOps HTTP.

### Fallback: JSONL path

When `sources.claude_code = true`, the agent also watches a usage JSONL file and maps each line into the shared event schema (`app=claude-code`).

**Default path:** `~/.tokenops/claude-code-usage.jsonl`  
**Override:** set `sources.claude_code_path` in config (absolute path to a file or directory).

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
5. **Settings** — budget banner threshold, **create agent PAT**, retention notes

## Environment variables

### API (`apps/api`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | yes | — | Postgres connection string |
| `SESSION_SECRET` | yes | — | Required at boot by `env.ts`, but not currently read by any code path — cookie sessions were removed with the Clerk migration. Kept for now; a follow-up should drop it |
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
- `SESSION_SECRET` from env or a dev placeholder (change for real use)
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

Prefer the **web** URL for login (nginx proxies `/v1` to `tokenops-api` on the private network — cookies stay same-origin).

Self-deploy:

1. New project → add **Postgres** plugin (`DATABASE_URL` injected).
2. Deploy API from repo root with `railway.toml` / `deploy/api.Dockerfile`.
3. Set `SESSION_SECRET` and `CLERK_SECRET_KEY` (API refuses to boot without either). For hosted free tier set `HOSTED_LIMITS=true`. Set `CLERK_JWT_KEY` too — see [Environment variables](#api-appsapi) for why.
4. Deploy web as a second service (`deploy/web.Dockerfile`) so nginx can reach `tokenops-api:3000` on the private network.
5. **Before the web service's first build**, set `VITE_CLERK_PUBLISHABLE_KEY` as a Variable on that service. `deploy/web.Dockerfile` declares `ARG VITE_CLERK_PUBLISHABLE_KEY`, and Railway only populates a declared `ARG` from a service Variable of the same name at build time — there is no `railway.toml`/`railway.json` field that injects it for you (config-as-code there only covers `[build]`/`[deploy]`, not variables). **Skipping this step fails the web build outright**, because `apps/web/vite.config.ts` throws on a missing key instead of shipping a broken bundle.

Health check path: `/health`.

## Desktop agent installer (Windows)

### Download from GitHub Releases (easiest)

1. Open **[Releases](https://github.com/kenarakelian1/tokenops/releases)**  
2. Install [Node.js 22+](https://nodejs.org/) if needed  
3. Download **`TokenOps-Agent-Setup.exe`** (recommended) **or** `tokenops-agent-win.zip`  
4. Run the Setup wizard (per-user, no admin) — pick AI tools, PAT, startup  
5. Start Menu → **TokenOps Agent** (or `tokenops agent run`)

Portable: unzip `tokenops-agent-win.zip` → `install.cmd`.

> The Setup is not Authenticode-signed yet. If SmartScreen/Smart App Control warns: **More info → Run anyway**, or right‑click → Properties → **Unblock**.

### Build from source

```bat
pnpm.cmd install
pnpm.cmd package:agent
```

Outputs:

- `dist\tokenops-agent-win\` — portable folder + `install.cmd`  
- `dist\TokenOps-Agent-Setup.exe` — if [Inno Setup 6](https://jrsoftware.org/isinfo.php) is installed  

Wizard options: AI tools (Claude Code, Cursor, Grok/xAI, OpenAI), PAT, optional API keys, start at Windows sign-in.

Uninstall: **Apps & features** (Setup) or `uninstall.cmd` (portable).  
Quiet portable: `install.cmd -Quiet` / `-NoStartup`.

New release: tag `v*` and push, or run workflow **Release desktop agent**.## Development

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
| `apps/api` | Needs `DATABASE_URL` + `SESSION_SECRET` + `CLERK_SECRET_KEY` for `pnpm --filter @tokenops/api dev` |
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
