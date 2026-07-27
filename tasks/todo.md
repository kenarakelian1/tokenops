# TokenOps — current work

## Brainstorming / design
- [x] Explore project context (empty greenfield repo)
- [x] Clarifying questions (scope, privacy, OSS, phase 1 sources, success bar)
- [x] Approaches (chose sidecar agent + cloud)
- [x] Design sections approved
- [x] Write design spec + HTML
- [x] User reviews design spec
- [x] Implementation plan (`writing-plans`)
- [x] Execute Phase 1 plan (14 tasks)

## Spec / plan
- `docs/superpowers/specs/2026-07-27-tokenops-design.md`
- `docs/superpowers/specs/2026-07-27-tokenops-design.html`
- `docs/superpowers/plans/2026-07-27-tokenops-phase1.md`

## Phase 1 tasks (complete)
- [x] Task 1 — monorepo scaffold + MIT
- [x] Task 2 — shared schema / pricing / event-id
- [x] Task 3 — features + privacy
- [x] Task 4 — three rules
- [x] Task 5 — API shell + health + env
- [x] Task 6 — auth (session + PAT)
- [x] Task 7 — ingest, aggregates, heartbeats, recommendations
- [x] Task 8 — agent identity + outbox + privacy ship
- [x] Task 9 — OpenAI-compatible proxy
- [x] Task 10 — agent CLI + flush + heartbeats
- [x] Task 11 — Claude Code JSONL adapter
- [x] Task 12 — web dashboard
- [x] Task 13 — Compose / Docker / content TTL / Railway
- [x] Task 14 — README + README.html + e2e fixture path docs

## Review (Task 14)
- Full Phase 1 README covers product, architecture, Compose, agent init/run, OpenAI SDK proxy URL, Claude Code JSONL + fixture path, privacy modes, free tier/self-host, pnpm dev/test, env, Railway.
- Standalone `README.html` matches design-spec typography/CSS.
- Optional `scripts/seed-demo-events.ts` not added (fixture copy path documented instead).
- `pnpm test` run as final verification (see report).
