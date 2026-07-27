# TokenOps Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a multi-machine token ledger with an OpenAI-compatible local proxy, Claude Code adapter, privacy-configurable capture, and three rule-based efficiency recommendations via an OSS self-hostable cloud + dashboard.

**Architecture:** Per-machine TypeScript agent (proxy + adapters + SQLite outbox + privacy gate) ships usage events to a Hono API on Postgres; shared package owns Zod schemas, feature extraction, cost estimates, and rules; Vite+React dashboard reads aggregates and recommendations.

**Tech Stack:** pnpm workspaces, TypeScript, Node 22+, Vitest, Hono, Drizzle ORM + Postgres, better-sqlite3, Vite + React, Docker Compose, Railway.

**Spec:** `docs/superpowers/specs/2026-07-27-tokenops-design.md`

## Global Constraints

- Provider API keys **never** leave the machine (never in ingest payload).
- Cloud always stores metadata + features; content only when `content_mode = cloud_ttl`.
- Money in UI is always labeled **estimated**.
- Phase 1 sources only: `openai-proxy`, `claude-code`.
- Single-user auth; multi-machine via `machine_id`.
- License: **MIT**.
- API framework: **Hono**.
- Dashboard auth: email + password (scrypt/bcrypt); agent auth: personal access token (PAT).
- Tests: **Vitest**; no reliance on live provider APIs in CI (mock upstream).
- Deploy path required: Docker Compose + Railway-ready Dockerfiles before “done”.
- Product verification against Compose/Railway URLs; automated tests run locally with in-process/fixtures.
- Human-facing docs: `.md` + standalone `.html` when shipping README/design updates.

---

## File map (create during tasks)

```
tokenops/
  package.json                 # pnpm workspace root
  pnpm-workspace.yaml
  tsconfig.base.json
  vitest.workspace.ts
  LICENSE                      # MIT
  .gitignore
  README.md
  README.html
  packages/shared/
    package.json
    tsconfig.json
    src/index.ts
    src/schema/event.ts        # Zod UsageEvent, Features, IngestBatch
    src/event-id.ts
    src/pricing.ts
    src/features.ts
    src/privacy.ts
    src/rules/index.ts
    src/rules/frontier-trivial.ts
    src/rules/full-document-io.ts
    src/rules/context-bloat.ts
    src/model-tier.ts
    src/*.test.ts
  apps/api/
    package.json
    tsconfig.json
    drizzle.config.ts
    src/index.ts
    src/app.ts
    src/env.ts
    src/db/client.ts
    src/db/schema.ts
    src/db/migrate.ts
    src/auth/password.ts
    src/auth/session.ts
    src/auth/pat.ts
    src/routes/health.ts
    src/routes/auth.ts
    src/routes/events.ts
    src/routes/aggregates.ts
    src/routes/recommendations.ts
    src/routes/heartbeats.ts
    src/services/ingest.ts
    src/services/rules-runner.ts
    src/services/aggregates.ts
    src/**/*.test.ts
  apps/agent/
    package.json
    tsconfig.json
    src/cli.ts
    src/config.ts
    src/identity.ts
    src/outbox.ts
    src/flush.ts
    src/privacy-apply.ts
    src/proxy/server.ts
    src/proxy/handler.ts
    src/adapters/claude-code.ts
    src/agent-main.ts
    src/**/*.test.ts
  apps/web/
    package.json
    vite.config.ts
    index.html
    src/main.tsx
    src/App.tsx
    src/api/client.ts
    src/pages/Overview.tsx
    src/pages/Explore.tsx
    src/pages/Recommendations.tsx
    src/pages/Machines.tsx
    src/pages/Settings.tsx
    src/pages/Login.tsx
  deploy/
    docker-compose.yml
    api.Dockerfile
    web.Dockerfile
    railway.toml
  tasks/todo.md
```

### Shared interfaces (locked names)

```ts
// packages/shared — canonical types
export type ContentMode = "off" | "local" | "cloud_ttl";

export type ModelTier = "frontier" | "mid" | "small" | "unknown";

export interface UsageFeatures {
  promptChars: number;
  responseChars: number;
  messageCount: number;
  codeFenceCount: number;
  largePasteScore: number;      // 0..1
  fileDumpScore: number;        // 0..1
  modelTier: ModelTier;
  newContentRatio?: number;     // 0..1 when session-aware
}

export interface UsageEvent {
  eventId: string;
  timestamp: string;            // ISO-8601 UTC
  machineId: string;
  machineName: string;
  app: "openai-proxy" | "claude-code" | string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs?: number;
  sessionId?: string;
  features: UsageFeatures;
  hasContent: boolean;
  content?: {
    requestBody?: unknown;
    responseBody?: unknown;
  };
}

export interface IngestBatch {
  events: UsageEvent[];
}

export type RuleId =
  | "frontier_trivial"
  | "full_document_io"
  | "context_bloat";

export interface RuleHit {
  ruleId: RuleId;
  severity: "info" | "warn" | "high";
  title: string;
  detail: string;
  estimatedWastedTokens: number;
  estimatedWastedUsd: number | null;
  eventIds: string[];
}

export function buildEventId(parts: {
  machineId: string;
  app: string;
  providerRequestId?: string;
  fingerprint: string;
  timeBucketSec: number;
}): string;

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  priceOverrides?: Record<string, { inputPerMTok: number; outputPerMTok: number }>,
): number | null;

export function extractFeatures(input: {
  model: string;
  requestMessages?: Array<{ role: string; content: unknown }>;
  responseText?: string;
  sessionPriorPromptChars?: number;
}): UsageFeatures;

export function applyPrivacy(
  event: UsageEvent,
  mode: ContentMode,
): UsageEvent;

export function runRules(
  event: UsageEvent,
  sessionContext?: UsageEvent[],
): RuleHit[];
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `LICENSE`, `.gitignore`, `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `apps/api/package.json`, `apps/agent/package.json`, `apps/web/package.json`

**Interfaces:**
- Consumes: none
- Produces: workspace scripts `pnpm test`, `pnpm -r build`; package names `@tokenops/shared`, `@tokenops/api`, `@tokenops/agent`, `@tokenops/web`

- [ ] **Step 1: Create root workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

Root `package.json`:
```json
{
  "name": "tokenops",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "pnpm -r run build",
    "lint": "pnpm -r run build"
  },
  "devDependencies": {
    "typescript": "^5.7.3",
    "vitest": "^3.0.5",
    "@types/node": "^22.10.0"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

MIT `LICENSE` (standard MIT text, copyright year 2026).

`.gitignore`: `node_modules`, `dist`, `.env`, `.env.*`, `*.db`, `.tokenops`, `coverage`.

- [ ] **Step 2: Scaffold package stubs**

Each package `package.json` with `"type": "module"`, `"name": "@tokenops/..."`, scripts `build` (`tsc`), `test` (`vitest run`).

`packages/shared/src/index.ts`:
```ts
export const TOKENOPS_VERSION = "0.1.0";
```

- [ ] **Step 3: Install and verify**

Run: `pnpm install`  
Run: `pnpm exec tsc -p packages/shared --noEmit` (after tsconfig exists)  
Expected: success

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.workspace.ts LICENSE .gitignore packages apps
git commit -m "chore: scaffold pnpm monorepo for tokenops"
```

---

### Task 2: Shared event schema + event_id + pricing

**Files:**
- Create: `packages/shared/src/schema/event.ts`, `packages/shared/src/event-id.ts`, `packages/shared/src/pricing.ts`, `packages/shared/src/model-tier.ts`, `packages/shared/src/schema/event.test.ts`, `packages/shared/src/event-id.test.ts`, `packages/shared/src/pricing.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `UsageEventSchema` (Zod), `parseUsageEvent`, `buildEventId`, `estimateCostUsd`, `getModelTier`, `DEFAULT_PRICES`

- [ ] **Step 1: Write failing tests**

`packages/shared/src/event-id.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildEventId } from "./event-id.js";

describe("buildEventId", () => {
  it("is stable for same inputs", () => {
    const a = buildEventId({
      machineId: "m1",
      app: "openai-proxy",
      providerRequestId: "req_1",
      fingerprint: "fp",
      timeBucketSec: 100,
    });
    const b = buildEventId({
      machineId: "m1",
      app: "openai-proxy",
      providerRequestId: "req_1",
      fingerprint: "fp",
      timeBucketSec: 100,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when machine differs", () => {
    const a = buildEventId({
      machineId: "m1", app: "openai-proxy", fingerprint: "fp", timeBucketSec: 1,
    });
    const b = buildEventId({
      machineId: "m2", app: "openai-proxy", fingerprint: "fp", timeBucketSec: 1,
    });
    expect(a).not.toBe(b);
  });
});
```

`packages/shared/src/pricing.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { estimateCostUsd } from "./pricing.js";

describe("estimateCostUsd", () => {
  it("computes from default gpt-4o-mini prices", () => {
    const cost = estimateCostUsd("gpt-4o-mini", 1_000_000, 0);
    expect(cost).toBeTypeOf("number");
    expect(cost!).toBeGreaterThan(0);
  });

  it("returns null for unknown model", () => {
    expect(estimateCostUsd("totally-unknown-model-xyz", 100, 100)).toBeNull();
  });

  it("respects overrides", () => {
    const cost = estimateCostUsd("custom-m", 1_000_000, 0, {
      "custom-m": { inputPerMTok: 1, outputPerMTok: 2 },
    });
    expect(cost).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `pnpm exec vitest run packages/shared/src/event-id.test.ts packages/shared/src/pricing.test.ts`  
Expected: FAIL (modules not found)

- [ ] **Step 3: Implement**

`event-id.ts` — SHA-256 hex of `machineId|app|providerRequestId|fingerprint|timeBucketSec` via `node:crypto`.

`pricing.ts` — map at least:
- `gpt-4o`, `gpt-4o-mini`, `o1`, `o3-mini`
- `claude-sonnet-4`, `claude-opus-4`, `claude-haiku` (use approximate public rates; document as estimates)
- Prefix match: if exact miss, try longest prefix key

`model-tier.ts`:
```ts
const FRONTIER = [/opus/i, /o1(?!\-mini)/i, /o3(?!\-mini)/i, /gpt-4(?!o-mini)/i, /claude-3-opus/i];
const SMALL = [/mini/i, /haiku/i, /nano/i, /8b/i];
export function getModelTier(model: string): ModelTier { /* frontier > small > mid heuristics */ }
```

`schema/event.ts` — Zod object matching `UsageEvent` above; export `UsageEventSchema`, `IngestBatchSchema`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm exec vitest run packages/shared`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): event schema, event ids, and cost estimates"
```

---

### Task 3: Feature extraction + privacy gate

**Files:**
- Create: `packages/shared/src/features.ts`, `packages/shared/src/privacy.ts`, `packages/shared/src/features.test.ts`, `packages/shared/src/privacy.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `extractFeatures`, `applyPrivacy`

- [ ] **Step 1: Write failing tests**

```ts
// features.test.ts
import { describe, it, expect } from "vitest";
import { extractFeatures } from "./features.js";

describe("extractFeatures", () => {
  it("counts messages and chars", () => {
    const f = extractFeatures({
      model: "gpt-4o",
      requestMessages: [
        { role: "user", content: "a".repeat(100) },
        { role: "user", content: "```\ncode\n```" },
      ],
      responseText: "ok",
    });
    expect(f.messageCount).toBe(2);
    expect(f.promptChars).toBeGreaterThan(100);
    expect(f.codeFenceCount).toBeGreaterThanOrEqual(1);
    expect(f.modelTier).toBe("frontier");
  });

  it("scores large paste when one message is huge", () => {
    const f = extractFeatures({
      model: "gpt-4o-mini",
      requestMessages: [{ role: "user", content: "x".repeat(50_000) }],
      responseText: "y",
    });
    expect(f.largePasteScore).toBeGreaterThan(0.5);
    expect(f.fileDumpScore).toBeGreaterThan(0.3);
  });
});
```

```ts
// privacy.test.ts
import { describe, it, expect } from "vitest";
import { applyPrivacy } from "./privacy.js";
import type { UsageEvent } from "./schema/event.js";

const base: UsageEvent = {
  eventId: "e1",
  timestamp: new Date().toISOString(),
  machineId: "m",
  machineName: "n",
  app: "openai-proxy",
  provider: "openai",
  model: "gpt-4o-mini",
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.001,
  features: {
    promptChars: 10,
    responseChars: 5,
    messageCount: 1,
    codeFenceCount: 0,
    largePasteScore: 0,
    fileDumpScore: 0,
    modelTier: "small",
  },
  hasContent: true,
  content: { requestBody: { hi: 1 }, responseBody: { bye: 2 } },
};

describe("applyPrivacy", () => {
  it("strips content for off", () => {
    const e = applyPrivacy(base, "off");
    expect(e.content).toBeUndefined();
    expect(e.hasContent).toBe(false);
    expect(e.features.promptChars).toBe(10);
  });

  it("keeps content for cloud_ttl", () => {
    const e = applyPrivacy(base, "cloud_ttl");
    expect(e.content?.requestBody).toEqual({ hi: 1 });
    expect(e.hasContent).toBe(true);
  });

  it("strips content for local (cloud ship shape)", () => {
    // applyPrivacy prepares the *ship* payload: local mode does not send content upstream
    const e = applyPrivacy(base, "local");
    expect(e.content).toBeUndefined();
    expect(e.hasContent).toBe(false);
  });
});
```

- [ ] **Step 2: Run — FAIL**

Run: `pnpm exec vitest run packages/shared/src/features.test.ts packages/shared/src/privacy.test.ts`

- [ ] **Step 3: Implement `extractFeatures` and `applyPrivacy`**

Heuristics:
- Flatten message `content` (string or array of `{text}` parts) to text.
- `codeFenceCount` = matches of /```/g / 2 floored min 0.
- `largePasteScore` = min(1, promptChars / 40_000).
- `fileDumpScore` = min(1, 0.4 * largePasteScore + 0.3 * min(1, codeFenceCount / 5) + (path-like line density bonus)).
- `newContentRatio` = if `sessionPriorPromptChars` provided: `clamp(1 - sessionPriorPromptChars / max(promptChars,1), 0, 1)`.

`applyPrivacy`: clone event; for `off` and `local` delete `content` and set `hasContent=false`; for `cloud_ttl` keep content.

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): feature extraction and privacy gate"
```

---

### Task 4: Rule engine (three rules)

**Files:**
- Create: `packages/shared/src/rules/frontier-trivial.ts`, `packages/shared/src/rules/full-document-io.ts`, `packages/shared/src/rules/context-bloat.ts`, `packages/shared/src/rules/index.ts`, `packages/shared/src/rules/rules.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `runRules(event, sessionContext?) => RuleHit[]`
- Threshold constants exported for tests:
  - `FRONTIER_TRIVIAL_MAX_TOTAL_TOKENS = 200`
  - `FULL_DOC_MIN_PROMPT_CHARS = 20_000`
  - `FULL_DOC_MIN_DUMP_SCORE = 0.55`
  - `BLOAT_MIN_EVENTS = 3`
  - `BLOAT_INPUT_GROWTH_RATIO = 1.8`
  - `BLOAT_MAX_NEW_CONTENT_RATIO = 0.25`

- [ ] **Step 1: Write failing tests covering all three rules**

```ts
import { describe, it, expect } from "vitest";
import { runRules } from "./index.js";
import type { UsageEvent } from "../schema/event.js";

function ev(partial: Partial<UsageEvent> & Pick<UsageEvent, "eventId" | "model" | "inputTokens" | "outputTokens" | "features">): UsageEvent {
  return {
    timestamp: new Date().toISOString(),
    machineId: "m",
    machineName: "n",
    app: "openai-proxy",
    provider: "openai",
    costUsd: 0.01,
    ...partial,
  };
}

describe("runRules", () => {
  it("flags frontier for trivial", () => {
    const hits = runRules(ev({
      eventId: "a",
      model: "gpt-4o",
      inputTokens: 20,
      outputTokens: 10,
      features: {
        promptChars: 40, responseChars: 20, messageCount: 1,
        codeFenceCount: 0, largePasteScore: 0, fileDumpScore: 0, modelTier: "frontier",
      },
    }));
    expect(hits.some((h) => h.ruleId === "frontier_trivial")).toBe(true);
  });

  it("flags full document io", () => {
    const hits = runRules(ev({
      eventId: "b",
      model: "gpt-4o-mini",
      inputTokens: 12_000,
      outputTokens: 100,
      features: {
        promptChars: 40_000, responseChars: 200, messageCount: 2,
        codeFenceCount: 8, largePasteScore: 0.9, fileDumpScore: 0.8, modelTier: "small",
      },
    }));
    expect(hits.some((h) => h.ruleId === "full_document_io")).toBe(true);
  });

  it("flags context bloat with session history", () => {
    const session: UsageEvent[] = [
      ev({ eventId: "s1", model: "gpt-4o-mini", inputTokens: 1000, outputTokens: 50, sessionId: "S",
        features: { promptChars: 1000, responseChars: 50, messageCount: 2, codeFenceCount: 0, largePasteScore: 0, fileDumpScore: 0, modelTier: "small", newContentRatio: 1 } }),
      ev({ eventId: "s2", model: "gpt-4o-mini", inputTokens: 1500, outputTokens: 50, sessionId: "S",
        features: { promptChars: 1500, responseChars: 50, messageCount: 4, codeFenceCount: 0, largePasteScore: 0, fileDumpScore: 0, modelTier: "small", newContentRatio: 0.2 } }),
    ];
    const current = ev({
      eventId: "s3", model: "gpt-4o-mini", inputTokens: 3000, outputTokens: 50, sessionId: "S",
      features: { promptChars: 3000, responseChars: 50, messageCount: 6, codeFenceCount: 0, largePasteScore: 0, fileDumpScore: 0, modelTier: "small", newContentRatio: 0.1 },
    });
    const hits = runRules(current, session);
    expect(hits.some((h) => h.ruleId === "context_bloat")).toBe(true);
  });

  it("returns empty for normal mid-size call", () => {
    const hits = runRules(ev({
      eventId: "c",
      model: "gpt-4o-mini",
      inputTokens: 800,
      outputTokens: 200,
      features: {
        promptChars: 2000, responseChars: 500, messageCount: 4,
        codeFenceCount: 1, largePasteScore: 0.1, fileDumpScore: 0.1, modelTier: "small",
      },
    }));
    expect(hits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement rules**

- **frontier_trivial:** `modelTier === "frontier"` AND `input+output <= 200` AND `messageCount <= 2` AND `largePasteScore < 0.3`  
  wasted tokens = total; wasted USD = costUsd (or re-estimate vs small model using `estimateCostUsd("gpt-4o-mini", ...)` delta).

- **full_document_io:** `promptChars >= 20000` AND `fileDumpScore >= 0.55`  
  wasted tokens = `floor(inputTokens * fileDumpScore * 0.5)`; USD from proportional cost.

- **context_bloat:** require `sessionId` and `sessionContext` length >= 2; compare first event inputTokens to current; if `current.input / first.input >= 1.8` AND `newContentRatio <= 0.25`  
  wasted = `current.inputTokens - first.inputTokens`.

`runRules` concatenates hits from all three.

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): efficiency rules for frontier, dumps, and bloat"
```

---

### Task 5: API database schema + app shell

**Files:**
- Create: all `apps/api/src/db/*`, `apps/api/src/env.ts`, `apps/api/src/app.ts`, `apps/api/src/index.ts`, `apps/api/src/routes/health.ts`, `apps/api/drizzle.config.ts`, `apps/api/src/db/schema.test.ts` (optional light), migration SQL under `apps/api/drizzle/`
- Dependencies: `hono`, `@hono/node-server`, `drizzle-orm`, `postgres` (or `pg`), `drizzle-kit`, `zod`, `dotenv`

**Interfaces:**
- Produces tables: `users`, `sessions`, `pats`, `machines`, `usage_events`, `event_content`, `daily_aggregates`, `recommendations`
- Produces: `createApp() => Hono` with `GET /health` → `{ ok: true }`

**DB columns (Drizzle):**

- `users`: id uuid PK, email unique, password_hash, budget_usd_monthly numeric null, created_at
- `sessions`: id text PK, user_id, expires_at
- `pats`: id uuid, user_id, token_hash unique, name, created_at, revoked_at null
- `machines`: machine_id text PK, user_id, name, last_seen_at, last_queue_depth int
- `usage_events`: event_id text PK, user_id, timestamp, machine_id, machine_name, app, provider, model, input_tokens, output_tokens, cost_usd, latency_ms, session_id, features jsonb, has_content bool
- `event_content`: event_id PK FK, request_body jsonb, response_body jsonb, expires_at
- `daily_aggregates`: (user_id, day, machine_id, app, model) PK, input_tokens, output_tokens, cost_usd, event_count
- `recommendations`: id uuid PK, user_id, rule_id, severity, title, detail, estimated_wasted_tokens, estimated_wasted_usd, event_ids jsonb, status (`open`|`dismissed`), created_at, unique(user_id, rule_id, event_ids hash) or dedupe by first event_id+rule_id

- [ ] **Step 1: Write health route test**

```ts
import { describe, it, expect } from "vitest";
import { createApp } from "./app.js";

describe("health", () => {
  it("returns ok", async () => {
    const app = createApp({ db: null as never }); // allow test double later; or use real createApp without db for health only
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
```

Prefer: `createApp(deps: { db: Db })` and health does not need db.

- [ ] **Step 2: Implement schema, migrate helper, health**

`env.ts` reads `DATABASE_URL`, `SESSION_SECRET`, `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD` (for first user seed).

- [ ] **Step 3: Run vitest for health — PASS**

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "feat(api): drizzle schema, app shell, health route"
```

---

### Task 6: Auth — user session + PAT

**Files:**
- Create: `apps/api/src/auth/password.ts`, `session.ts`, `pat.ts`, `routes/auth.ts`, `apps/api/src/auth/auth.test.ts`
- Middleware: `requireSession`, `requirePat` (PAT via `Authorization: Bearer tok_...`)

**Interfaces:**
- `hashPassword(pw) / verifyPassword(pw, hash)`
- `createSession(userId) / getSession(token)`
- `createPat(userId, name) => { token: string }` (show once); `verifyPat(token) => userId | null`
- Routes:
  - `POST /v1/auth/register` — only if zero users exist (bootstrap); else 403
  - `POST /v1/auth/login` `{email,password}` → Set-Cookie session
  - `POST /v1/auth/logout`
  - `POST /v1/auth/pats` `{name}` session-required → `{ token, id }`
  - `GET /v1/auth/me` session-required

- [ ] **Step 1: Unit test password + PAT hash stability**

```ts
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";
import { hashToken, generatePatToken } from "./pat.js";

describe("password", () => {
  it("roundtrips", async () => {
    const h = await hashPassword("secret-pass-1");
    expect(await verifyPassword("secret-pass-1", h)).toBe(true);
    expect(await verifyPassword("nope", h)).toBe(false);
  });
});

describe("pat", () => {
  it("generates tok_ prefix", () => {
    const t = generatePatToken();
    expect(t.startsWith("tok_")).toBe(true);
    expect(hashToken(t)).toHaveLength(64);
  });
});
```

- [ ] **Step 2: Implement with `node:crypto` scrypt for passwords; sha256 for PAT storage**

- [ ] **Step 3: Integration test with PGlite or testcontainers**

Prefer **`pglite` + drizzle** for CI simplicity if compatible; else skip-to-compose. Minimum: mock db interface for route tests.

If PGlite is painful with drizzle, use an in-memory fake repository for auth tests:

```ts
it("login sets cookie", async () => { /* seed user; POST login; expect set-cookie */ });
```

- [ ] **Step 4: PASS + commit**

```bash
git commit -m "feat(api): session auth and personal access tokens"
```

---

### Task 7: Event ingest, aggregates, rules runner

**Files:**
- Create: `apps/api/src/services/ingest.ts`, `aggregates.ts`, `rules-runner.ts`, `routes/events.ts`, `routes/aggregates.ts`, `routes/recommendations.ts`, `routes/heartbeats.ts`, tests

**Interfaces:**
- `POST /v1/events` PAT auth, body `IngestBatchSchema` → `{ accepted: number, duplicates: number }`
- `GET /v1/aggregates?from&to` session → rows
- `GET /v1/events?machineId&app&model&from&to&limit` session
- `GET /v1/recommendations?status=open` session
- `POST /v1/recommendations/:id/dismiss` session
- `POST /v1/heartbeats` PAT `{ machineId, machineName, queueDepth }`

**Ingest algorithm:**
1. Validate batch.
2. For each event: upsert `usage_events` on `event_id` (ignore duplicate content update if exists).
3. If `content` present and mode implied by hasContent: insert `event_content` with `expires_at = now + 7d`.
4. Bump `daily_aggregates` (increment tokens/cost/count).
5. Load recent same `session_id` events (limit 20); `runRules(event, session)`; upsert open recommendations (dedupe key: `user_id + rule_id + event.eventId`).
6. Upsert machine last_seen.

- [ ] **Step 1: Write ingest idempotency test (fake or pglite repo)**

```ts
it("counts duplicates on second ingest", async () => {
  const batch = { events: [sampleEvent("e1")] };
  const r1 = await ingest(db, userId, batch);
  const r2 = await ingest(db, userId, batch);
  expect(r1.accepted).toBe(1);
  expect(r2.duplicates).toBe(1);
  expect(await countEvents(db)).toBe(1);
});

it("creates frontier_trivial recommendation", async () => {
  await ingest(db, userId, { events: [frontierTrivialFixture()] });
  const recs = await listRecs(db, userId);
  expect(recs.some((r) => r.ruleId === "frontier_trivial")).toBe(true);
});
```

- [ ] **Step 2: Implement services + routes**

- [ ] **Step 3: PASS**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(api): ingest, aggregates, recommendations, heartbeats"
```

---

### Task 8: Agent config, identity, outbox

**Files:**
- Create: `apps/agent/src/config.ts`, `identity.ts`, `outbox.ts`, `privacy-apply.ts`, tests

**Interfaces:**
- `loadConfig(path?: string): TokenOpsConfig` from `~/.tokenops/config.toml` (use `smol-toml` or `@iarna/toml`)
- `ensureIdentity(): { machineId, machineName }` — persist `~/.tokenops/machine.json`
- `Outbox` class: `enqueue(event)`, `listPending(limit)`, `markSent(ids)`, `markFailed(id, err)`, SQLite file `~/.tokenops/outbox.db`
- Config type matches design (cloud url/token, privacy, proxy, sources, machine)

Default config written by `tokenops init`.

- [ ] **Step 1: Outbox tests with temp dir**

```ts
it("enqueue and list pending", () => {
  const ob = new Outbox(tmpDb);
  ob.enqueue(sampleEvent("e1"));
  expect(ob.listPending(10)).toHaveLength(1);
  ob.markSent(["e1"]);
  expect(ob.listPending(10)).toHaveLength(0);
});
```

- [ ] **Step 2: Implement with better-sqlite3**

Table `outbox(event_id TEXT PK, payload TEXT, status TEXT, attempts INT, last_error TEXT, created_at TEXT)`.

- [ ] **Step 3: PASS + commit**

```bash
git commit -m "feat(agent): config, machine identity, sqlite outbox"
```

---

### Task 9: OpenAI-compatible proxy

**Files:**
- Create: `apps/agent/src/proxy/server.ts`, `handler.ts`, `apps/agent/src/proxy/proxy.test.ts`

**Interfaces:**
- `startProxy(opts: { listen: string; upstream: string; apiKey: string; onEvent: (e: UsageEvent) => void }): Promise<Server>`
- Handles `POST /v1/chat/completions` (non-stream first; if `stream:true`, still proxy stream and best-effort parse final usage if present)
- Forwards headers `authorization` from upstream key
- Builds UsageEvent: app `openai-proxy`, provider from upstream host heuristic (`openai` if api.openai.com), tokens from `usage` or estimate `chars/4`

- [ ] **Step 1: Test with mock upstream HTTP server**

```ts
it("proxies chat and emits event with tokens", async () => {
  const upstream = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "chatcmpl_test",
      choices: [{ message: { role: "assistant", content: "hi" } }],
      usage: { prompt_tokens: 11, completion_tokens: 2 },
    }));
  });
  await listen(upstream);
  const events: UsageEvent[] = [];
  const proxy = await startProxy({
    listen: "127.0.0.1:0",
    upstream: `http://127.0.0.1:${port}`,
    apiKey: "sk-test",
    onEvent: (e) => events.push(e),
    machineId: "m",
    machineName: "t",
  });
  const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  expect(res.status).toBe(200);
  expect(events[0].inputTokens).toBe(11);
  expect(events[0].outputTokens).toBe(2);
  expect(events[0].app).toBe("openai-proxy");
});
```

- [ ] **Step 2: Implement proxy (undici/fetch)**

Never put upstream API key into `onEvent` payload.

After event built: `extractFeatures` → attach content from bodies → caller applies privacy before outbox.

- [ ] **Step 3: PASS + commit**

```bash
git commit -m "feat(agent): OpenAI-compatible local proxy with usage capture"
```

---

### Task 10: Flush, heartbeat, agent main loop, CLI

**Files:**
- Create: `apps/agent/src/flush.ts`, `agent-main.ts`, `cli.ts`
- Package bin: `"bin": { "tokenops": "./dist/cli.js" }`

**Interfaces:**
- `flushOutbox({ outbox, cloudUrl, ingestToken })` POST `/v1/events`
- `sendHeartbeat(...)` POST `/v1/heartbeats`
- CLI commands:
  - `tokenops init` — write default config
  - `tokenops agent run` — start proxy + flush interval (5s) + optional claude adapter
  - `tokenops status` — print queue depth, last flush error, config paths

- [ ] **Step 1: flush test with mock fetch**

```ts
it("marks sent on 200", async () => {
  // mock global fetch; enqueue 1; flush; expect pending 0
});
```

- [ ] **Step 2: Implement CLI with `node:util parseArgs`**

- [ ] **Step 3: PASS + commit**

```bash
git commit -m "feat(agent): outbox flush, heartbeats, and CLI"
```

---

### Task 11: Claude Code adapter

**Files:**
- Create: `apps/agent/src/adapters/claude-code.ts`, `apps/agent/src/adapters/claude-code.test.ts`, fixture `apps/agent/test/fixtures/claude-code-usage.jsonl`

**Approach (locked for Phase 1):**
1. Support **JSONL import path**: each line `{ timestamp, model, inputTokens, outputTokens, sessionId?, requestPreview?, responsePreview? }`.
2. Support **directory watch** of a configured `sources.claude_code_path` for new `.jsonl` lines (append-only).
3. Document how to wire Claude Code: user configures logging or a small wrapper; if official hooks exist in repo environment, prefer them in a follow-up — Phase 1 ships file-based adapter so ledger works with fixtures today.

**Interfaces:**
- `parseClaudeCodeLine(line: string): UsageEvent | null`
- `watchClaudeCodeLog(path, onEvent): { close() }`

- [ ] **Step 1: Tests with fixture file**

```ts
it("parses fixture lines into claude-code events", () => {
  const events = parseClaudeCodeLog(fixtureText);
  expect(events[0].app).toBe("claude-code");
  expect(events[0].inputTokens).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Implement + wire into `agent run` when `sources.claude_code = true`**

- [ ] **Step 3: PASS + commit**

```bash
git commit -m "feat(agent): Claude Code JSONL usage adapter"
```

---

### Task 12: Web dashboard

**Files:**
- Create: entire `apps/web` Vite React app as in file map
- Env: `VITE_API_URL`

**Screens (functional, clean, not fancy):**
1. Login
2. Overview — totals today/7d/30d from `/v1/aggregates`, top models table
3. Explore — filters + event table from `/v1/events`
4. Recommendations — list + dismiss button
5. Machines — from heartbeats/machines endpoint (add `GET /v1/machines` if missing in Task 7 — **add now**: session `GET /v1/machines`)
6. Settings — show budget field `PUT /v1/settings` `{ budgetUsdMonthly }` (add thin route)

**API client:** `fetch` with `credentials: "include"` for session cookie.

- [ ] **Step 1: Add any missing API routes (`GET /v1/machines`, `PUT /v1/settings`) with tests**

- [ ] **Step 2: Build pages; manual typecheck `pnpm --filter @tokenops/web build`**

- [ ] **Step 3: Optional Playwright later — not required if API covered; smoke: build succeeds**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(web): dashboard for overview, explore, recs, machines"
```

---

### Task 13: Deploy (Compose + Railway) + content TTL job

**Files:**
- Create: `deploy/docker-compose.yml`, `deploy/api.Dockerfile`, `deploy/web.Dockerfile`, `deploy/railway.toml`, `apps/api/src/jobs/expire-content.ts`
- Modify: `apps/api/src/index.ts` to run expire job interval hourly

**Compose services:** `db` (postgres:16), `api` (migrate on start), `web` (nginx or vite preview)

**Expire jobs (hourly):**
1. `DELETE FROM event_content WHERE expires_at < now()`; set matching `usage_events.has_content=false`.
2. If `HOSTED_LIMITS=true` (or `RAW_EVENT_RETENTION_DAYS` set): delete `usage_events` older than retention (default **30 days** on hosted, unlimited/self-host when unset). Aggregates rows are kept.

**Railway:** API service Dockerfile; attach Postgres plugin; `DATABASE_URL`; web static or separate service.

- [ ] **Step 1: `docker compose -f deploy/docker-compose.yml build` succeeds**

- [ ] **Step 2: Document env vars in README**

- [ ] **Step 3: Commit**

```bash
git commit -m "chore(deploy): docker compose, Dockerfiles, content TTL job"
```

---

### Task 14: README + HTML + end-to-end fixture path

**Files:**
- Create: `README.md`, `README.html`, `scripts/seed-demo-events.ts` (optional), update `tasks/todo.md`

**README must include:**
1. What TokenOps is
2. Architecture diagram (short)
3. Quick start Compose
4. `tokenops init` + `agent run`
5. Point OpenAI SDK at `http://127.0.0.1:8787/v1`
6. Claude Code JSONL path config
7. Privacy modes
8. Free tier / self-host notes
9. Development (`pnpm install`, `pnpm test`)

- [ ] **Step 1: Write README.md + README.html (standalone CSS like design HTML)**

- [ ] **Step 2: Run full `pnpm test` — all green**

- [ ] **Step 3: Final commit**

```bash
git commit -m "docs: README and phase 1 quick start"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Local agent + proxy + Claude Code | 9, 10, 11 |
| Privacy off/local/cloud_ttl | 3, 8, 9, 13 |
| Offline outbox | 8, 10 |
| Keys never leave machine | 9, 10 (assert in proxy tests) |
| Cloud ingest + aggregates | 7 |
| Three rules | 4, 7 |
| Multi-machine | 7 heartbeats/machines, 8 identity |
| Dashboard screens | 12 |
| OSS MIT + Compose + Railway | 1, 13, 14 |
| Estimated cost | 2, 7, 12 |
| Single-user auth + PAT | 6 |
| Content TTL | 13 |
| Free tier limits | Document in README (enforce soft machine count optional Task 7: max 3 machines on hosted via `HOSTED_LIMITS=true` env — implement simple check in heartbeat) |

### Hosted limit (include in Task 7)

If `process.env.HOSTED_LIMITS === "true"` and user already has 3 machines with different ids, reject new machine_id on heartbeat/ingest with 403 `{ error: "machine_limit" }`.

---

## Type consistency notes

- CamelCase in JSON API and shared package (`eventId`, `inputTokens`).
- Drizzle columns snake_case mapped in repositories.
- Rule IDs: `frontier_trivial` | `full_document_io` | `context_bloat` only.
- Apps: `openai-proxy` | `claude-code`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-27-tokenops-phase1.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration  
2. **Inline Execution** — execute tasks in this session with executing-plans and checkpoints  

Which approach?
