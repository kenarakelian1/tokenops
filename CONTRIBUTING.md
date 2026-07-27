# Contributing to TokenOps

Thanks for helping. TokenOps is an open-source multi-machine token ledger with efficiency recommendations.

## Development

```bash
pnpm install
pnpm test
pnpm --filter @tokenops/shared build
```

Package layout:

| Path | Role |
|------|------|
| `packages/shared` | Event schema, features, rules, pricing |
| `apps/api` | Hono API + Postgres |
| `apps/agent` | Local proxy, adapters, outbox |
| `apps/web` | Dashboard |
| `deploy/` | Docker Compose + Railway |

## Guidelines

- Prefer small, focused PRs.
- New features need basic Vitest coverage; bug fixes need a regression test.
- Provider API keys must never leave the local agent.
- Money in the UI is always labeled **estimated**.
- Phase 1 sources: OpenAI-compatible proxy + Claude Code JSONL. New adapters are welcome as separate packages under `apps/agent/src/adapters/`.

## Good first issues

- Additional provider price table rows
- Cursor / other IDE adapters
- Claude Code official hooks (when available)
- Dashboard polish and a11y

## License

MIT — see `LICENSE`.
