# TokenOps

Open-source AI usage observability: a local agent captures LLM calls, a cloud API stores aggregates and optional short-TTL content, and a web dashboard shows spend, explore, and recommendations.

> Full quick start (agent init, proxy, Claude Code) lands in Phase 1 Task 14. Below: deploy + environment reference.

## Architecture (short)

```
[Claude Code / OpenAI SDK] → local agent (proxy + outbox)
                                    ↓ PAT
                              TokenOps API (Hono + Postgres)
                                    ↑ session cookie
                              Web dashboard (Vite/React)
```

Compose runs **db** + **api** + **web** (nginx serves the SPA and proxies `/v1` and `/health` to the API for same-origin cookies).

## Quick start (Docker Compose)

```bash
# From repo root
export SESSION_SECRET="$(openssl rand -hex 32)"   # required in production
docker compose -f deploy/docker-compose.yml up --build
```

- Dashboard: http://localhost:8080  
- API: http://localhost:3000 (`GET /health` → `{ "ok": true }`)  
- Postgres: `localhost:5432` user/password/db `tokenops`

Register the first user:

```bash
curl -X POST http://localhost:8080/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"at-least-8-chars"}'
```

(Or hit the API on port 3000.) After the first user, registration closes.

## Environment variables

### API (`apps/api`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | yes | — | Postgres connection string |
| `SESSION_SECRET` | yes | — | Secret for app config / session integrity checks |
| `PORT` | no | `3000` | HTTP port |
| `HOST` | no | `0.0.0.0` | Bind address |
| `HOSTED_LIMITS` | no | unset/false | When `true`: max 3 machines per user; default **30-day** raw event retention |
| `RAW_EVENT_RETENTION_DAYS` | no | unset | If set, delete `usage_events` older than N days (aggregates kept). Overrides hosted default when set. Self-host: leave unset for unlimited |
| `CORS_ORIGIN` | no | unset | Single browser origin for credentialed CORS. Prefer same-origin reverse proxy instead |
| `BOOTSTRAP_EMAIL` | no | — | Optional bootstrap (if implemented by deploy hooks) |
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
pnpm test
pnpm --filter @tokenops/api build
pnpm --filter @tokenops/web build
```

API needs `DATABASE_URL` + `SESSION_SECRET` for `pnpm --filter @tokenops/api dev`.

## License

MIT — see [LICENSE](./LICENSE).
