# Clerk Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace TokenOps' email/password + session-table authentication with Clerk, and close the two tenant-isolation defects that open signup would make exploitable.

**Architecture:** Routes already consume only a `userId` context variable, so the browser auth mechanism swaps behind one middleware plus a provisioning function — the eight route groups are untouched. The dashboard sends a Clerk session JWT as `Authorization: Bearer <jwt>`; agents keep sending `tok_…` PATs on the same header, and the `tok_` prefix keeps the two unambiguous. Clerk identities map to local `users` rows just-in-time, adopting the pre-Clerk row by email so the production account keeps its PAT and ledger.

**Tech Stack:** Hono, Drizzle ORM, Postgres, Vitest, React 19 + Vite, `@clerk/backend`, `@clerk/react`.

**Spec:** `docs/superpowers/specs/2026-08-01-clerk-auth-design.md`

## Global Constraints

- Package manager is **pnpm 9.15.0**; Node **22**. Use `pnpm --filter <pkg>` for per-package commands.
- **Tests must never make network calls.** Clerk verification goes behind an injectable port, matching how `authRepo` and `eventsRepo` are already injected in `createApp`.
- Run the full suite with `pnpm test` from the repo root. It must stay green at every commit.
- Migrations are generated with `pnpm --filter @tokenops/api db:generate` (drizzle-kit), never hand-written into `drizzle/`.
- Commit messages use Conventional Commits. End every commit body with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- CI runs two jobs: `test` (ubuntu) and `installer-windows`. Both must pass before merge.
- The **agent requires no changes and no re-install** at any point in this plan. If a task appears to require an agent release, stop — something is wrong.

## Spec refinements adopted here

Two corrections found while verifying Clerk's current API. Both are improvements over the approved spec.

1. **The verifier is two methods, not one.** The spec's `verify()` returned `{ clerkUserId, email }`. Clerk's default session token does **not** contain an email claim, so that shape would force a Backend API call on every request. Split into `verifyToken()` (networkless signature check, every request) and `fetchEmail()` (Backend API, only when provisioning a row).
2. **Only the Inno installer mints weak machine IDs.** The spec said "the Windows installer". `installer/windows/install.ps1` already uses `[guid]::NewGuid()`; only `TokenOpsAgent.iss` uses a timestamp. Task 9 is correspondingly smaller.

Package names verified against current docs: the React SDK is **`@clerk/react`** (not `@clerk/clerk-react`), and `<Show when="signed-in">` has replaced `<SignedIn>` / `<SignedOut>`.

## File Structure

**Created**

| File | Responsibility |
|------|----------------|
| `apps/api/src/auth/clerk.ts` | `ClerkVerifier` port + production implementation |
| `apps/api/src/auth/clerk.test.ts` | Verifier contract against a fake |
| `apps/api/src/auth/provision.ts` | Clerk identity → local `users.id`, incl. legacy adoption |
| `apps/api/src/auth/provision.test.ts` | JIT create, reuse, adopt, refuse re-adopt |
| `apps/api/src/routes/tenant-isolation.test.ts` | Cross-tenant reads and writes across every route group |

**Modified**

| File | Change |
|------|--------|
| `apps/api/src/db/schema.ts` | `users.clerkUserId`; drop `sessions`; `machines` composite PK |
| `apps/api/src/auth/repo.ts` | Clerk lookup methods; drop session methods; `AuthUser` reshaped |
| `apps/api/src/auth/middleware.ts` | `requireSession` → `requireUser` |
| `apps/api/src/routes/auth.ts` | Delete register/login; `/me` and `/pats` behind `requireUser` |
| `apps/api/src/app.ts` | Inject `clerkVerifier` dependency |
| `apps/api/src/env.ts` | Require `CLERK_SECRET_KEY`; drop `BOOTSTRAP_*` |
| `apps/api/src/services/events-repo.ts` | `upsertMachine` conflict target scoped to owner |
| `apps/web/src/main.tsx` | `<ClerkProvider>` |
| `apps/web/src/App.tsx` | `<Show when=…>`, `<UserButton/>` |
| `apps/web/src/pages/Login.tsx` | Clerk `<SignIn/>` |
| `apps/web/src/api/client.ts` | Attach bearer token |
| `installer/windows/TokenOpsAgent.iss` | Stop writing `machine.json` |
| `README.md`, `deploy/env.example` | Clerk setup; correct `BOOTSTRAP_*` |

**Deleted**

`apps/api/src/auth/password.ts`, `apps/api/src/auth/session.ts`, `apps/api/scripts/set-password.mjs`, `apps/api/src/auth/set-password-script.test.ts`, and the register/login/session cases in `apps/api/src/auth/auth.test.ts`.

---

### Task 1: Scope machine upserts to their owner

`machines.machine_id` is a global primary key, and `upsertMachine` conflicts on it alone while setting `name` and `lastSeenAt` without checking `userId` (`apps/api/src/services/events-repo.ts:321`). A second user heartbeating a colliding ID silently rewrites the first user's row. Ownership never moves, so the victim sees a stranger's machine name and the attacker's machine never registers.

This ships first because it is independently valuable and must land before signup opens.

**Files:**
- Modify: `apps/api/src/db/schema.ts` (machines table)
- Modify: `apps/api/src/services/events-repo.ts:310-331` (`upsertMachine`, both Drizzle and in-memory)
- Test: `apps/api/src/services/events-repo.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `machines` keyed by `(userId, machineId)`. `upsertMachine(userId, machineId, name, queueDepth)` signature is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/events-repo.test.ts`:

```ts
it("does not let one user's heartbeat mutate another user's machine row", async () => {
  const repo = createInMemoryEventsRepo();

  await repo.upsertMachine("user-a", "machine-1", "alice-laptop", 0);
  await repo.upsertMachine("user-b", "machine-1", "mallory-laptop", 5);

  const alice = await repo.listMachines("user-a");
  expect(alice).toHaveLength(1);
  expect(alice[0]!.name).toBe("alice-laptop");
  expect(alice[0]!.lastQueueDepth).toBe(0);

  const mallory = await repo.listMachines("user-b");
  expect(mallory).toHaveLength(1);
  expect(mallory[0]!.name).toBe("mallory-laptop");
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @tokenops/api test -- events-repo`

Expected: FAIL. The in-memory repo keys machines by `machineId`, so `user-a` sees `mallory-laptop`, or one of the two users sees zero machines.

> If this test **passes** before you change anything, the in-memory repo already keys by owner while Postgres does not. That is worse, not better — the memory repo would be hiding the production bug from every test. Fix the memory repo to mirror the real key anyway, and keep going.

- [ ] **Step 3: Key the in-memory repo by owner**

In `apps/api/src/services/events-repo.ts`, inside `createInMemoryEventsRepo`, change the machine map key to include the owner:

```ts
// Mirrors the (user_id, machine_id) primary key. Keying on machineId alone
// would let this fake pass tests that production fails.
const machineKey = (userId: string, machineId: string) => `${userId}|${machineId}`;
```

Use `machineKey(userId, machineId)` for every get/set in the in-memory `upsertMachine`, `hasMachine`, and `listMachines`.

- [ ] **Step 4: Make the schema composite**

In `apps/api/src/db/schema.ts`, replace the `machines` table definition:

```ts
export const machines = pgTable(
  "machines",
  {
    machineId: text("machine_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    lastQueueDepth: integer("last_queue_depth").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.machineId] })],
);
```

`primaryKey` is already imported in this file.

- [ ] **Step 5: Scope the Drizzle conflict target**

In `apps/api/src/services/events-repo.ts`, in the Drizzle `upsertMachine`:

```ts
.onConflictDoUpdate({
  target: [machines.userId, machines.machineId],
  set: {
    name,
    lastSeenAt: now,
    ...(queueDepth !== undefined ? { lastQueueDepth: queueDepth } : {}),
  },
});
```

- [ ] **Step 6: Generate the migration**

Run: `pnpm --filter @tokenops/api db:generate`

Expected: a new file under `apps/api/drizzle/` dropping the old primary key and adding `PRIMARY KEY (user_id, machine_id)`. Open it and confirm it does **not** drop the table.

- [ ] **Step 7: Run the full suite**

Run: `pnpm test`

Expected: PASS, including the new test.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/src/services/events-repo.ts apps/api/src/services/events-repo.test.ts apps/api/drizzle
git commit -m "fix(api): scope machine upserts to their owner

machines.machine_id was a global primary key and upsertMachine conflicted
on it alone, so a second user heartbeating a colliding id silently rewrote
the first user's row. Ownership did not move, so the victim saw a
stranger's machine name and the attacker's machine never registered.

Latent while one account exists; exploitable the moment signup opens.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Add `clerk_user_id`, drop `sessions`

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/auth/repo.ts`
- Test: `apps/api/src/auth/repo.test.ts` (create if absent)

**Interfaces:**
- Consumes: Task 1's schema file
- Produces:
  ```ts
  export type AuthUser = {
    id: string;
    email: string;
    clerkUserId: string | null;
    budgetUsdMonthly: string | null;
  };

  // added to AuthRepo
  getUserByClerkId(clerkUserId: string): Promise<AuthUser | null>;
  getUnlinkedUserByEmail(email: string): Promise<AuthUser | null>;
  linkClerkId(userId: string, clerkUserId: string): Promise<void>;
  insertClerkUser(email: string, clerkUserId: string | null): Promise<AuthUser>;
  ```
  `clerkUserId` is nullable so tests (and the migration) can represent a
  pre-Clerk row that Task 4 later adopts.
  `insertSession`, `getSession`, `deleteSession`, and the old `insertUser(email, passwordHash)` are removed. `passwordHash` leaves `AuthUser`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/auth/repo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createMemoryAuthRepo } from "./repo.js";

describe("AuthRepo Clerk lookups", () => {
  it("finds a user by clerk id", async () => {
    const repo = createMemoryAuthRepo();
    const created = await repo.insertClerkUser("a@example.com", "user_clerk_a");

    const found = await repo.getUserByClerkId("user_clerk_a");
    expect(found?.id).toBe(created.id);
    expect(found?.email).toBe("a@example.com");
  });

  it("returns null for an unknown clerk id", async () => {
    const repo = createMemoryAuthRepo();
    expect(await repo.getUserByClerkId("user_nobody")).toBeNull();
  });

  it("finds only unlinked users by email", async () => {
    const repo = createMemoryAuthRepo();
    const legacy = await repo.insertClerkUser("legacy@example.com", null);

    expect((await repo.getUnlinkedUserByEmail("legacy@example.com"))?.id).toBe(
      legacy.id,
    );

    await repo.linkClerkId(legacy.id, "user_clerk_legacy");
    expect(await repo.getUnlinkedUserByEmail("legacy@example.com")).toBeNull();
  });
});
```

> `insertClerkUser` accepts `null` so tests can create a pre-Clerk row. Type it `clerkUserId: string | null`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @tokenops/api test -- repo`

Expected: FAIL — `insertClerkUser is not a function`.

- [ ] **Step 3: Update the schema**

In `apps/api/src/db/schema.ts`, add the column to `users` and delete the `sessions` table and its exported `Session` type:

```ts
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  clerkUserId: text("clerk_user_id").unique(),
  passwordHash: text("password_hash"),
  budgetUsdMonthly: numeric("budget_usd_monthly", { precision: 12, scale: 4 }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
```

`passwordHash` loses `.notNull()` but stays for one release so a rollback does not destroy credentials. `sessions` is dropped now — nothing reads it after Task 6.

- [ ] **Step 4: Implement the repo methods**

In `apps/api/src/auth/repo.ts`, reshape `AuthUser` per the Interfaces block, delete `insertSession`/`getSession`/`deleteSession` from both implementations, and add to the Drizzle repo:

```ts
async getUserByClerkId(clerkUserId) {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);
  return row ? toAuthUser(row) : null;
},

async getUnlinkedUserByEmail(email) {
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNull(users.clerkUserId)))
    .limit(1);
  return row ? toAuthUser(row) : null;
},

async linkClerkId(userId, clerkUserId) {
  await db.update(users).set({ clerkUserId }).where(eq(users.id, userId));
},

async insertClerkUser(email, clerkUserId) {
  const [row] = await db.insert(users).values({ email, clerkUserId }).returning();
  return toAuthUser(row);
},
```

Add `and` and `isNull` to the `drizzle-orm` import. Add a local helper:

```ts
function toAuthUser(row: typeof users.$inferSelect): AuthUser {
  return {
    id: row.id,
    email: row.email,
    clerkUserId: row.clerkUserId,
    budgetUsdMonthly: row.budgetUsdMonthly,
  };
}
```

Mirror all four in `createMemoryAuthRepo`.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm --filter @tokenops/api test -- repo`

Expected: PASS.

- [ ] **Step 6: Generate the migration**

Run: `pnpm --filter @tokenops/api db:generate`

Expected: adds `clerk_user_id text UNIQUE`, makes `password_hash` nullable, drops `sessions`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/src/auth/repo.ts apps/api/src/auth/repo.test.ts apps/api/drizzle
git commit -m "feat(api): add clerk_user_id and drop the sessions table

password_hash is loosened rather than dropped so a rollback does not
destroy credentials; a follow-up migration removes it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Clerk verification port

**Files:**
- Create: `apps/api/src/auth/clerk.ts`
- Create: `apps/api/src/auth/clerk.test.ts`
- Modify: `apps/api/package.json` (add `@clerk/backend`)

**Interfaces:**
- Consumes: nothing
- Produces:
  ```ts
  export type ClerkVerifier = {
    /** Networkless JWT signature check. Returns null when invalid or expired. */
    verifyToken(token: string): Promise<{ clerkUserId: string } | null>;
    /** Backend API call. Only used when provisioning a row. */
    fetchEmail(clerkUserId: string): Promise<string>;
  };
  export function createClerkVerifier(opts: {
    secretKey: string;
    jwtKey?: string;
  }): ClerkVerifier;
  export function createFakeVerifier(
    users: Record<string, { clerkUserId: string; email: string }>,
  ): ClerkVerifier;
  ```

- [ ] **Step 1: Install the dependency**

Run: `pnpm --filter @tokenops/api add @clerk/backend`

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/auth/clerk.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createFakeVerifier } from "./clerk.js";

describe("createFakeVerifier", () => {
  const verifier = createFakeVerifier({
    "token-alice": { clerkUserId: "user_alice", email: "alice@example.com" },
  });

  it("resolves a known token to its clerk user id", async () => {
    expect(await verifier.verifyToken("token-alice")).toEqual({
      clerkUserId: "user_alice",
    });
  });

  it("returns null for an unknown token", async () => {
    expect(await verifier.verifyToken("token-nope")).toBeNull();
  });

  it("returns the email for a known clerk user id", async () => {
    expect(await verifier.fetchEmail("user_alice")).toBe("alice@example.com");
  });

  it("throws when asked for an unknown user's email", async () => {
    await expect(verifier.fetchEmail("user_nope")).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `pnpm --filter @tokenops/api test -- clerk`

Expected: FAIL — module `./clerk.js` not found.

- [ ] **Step 4: Implement the port**

Create `apps/api/src/auth/clerk.ts`:

```ts
import { createClerkClient, verifyToken } from "@clerk/backend";

export type ClerkIdentity = { clerkUserId: string };

export type ClerkVerifier = {
  /**
   * Verify a Clerk session JWT. Networkless when `jwtKey` is configured;
   * otherwise Clerk fetches and caches the JWKS. Either way this must not
   * call Clerk on every request.
   */
  verifyToken(token: string): Promise<ClerkIdentity | null>;
  /**
   * Look up a user's primary email. Clerk's default session token carries no
   * email claim, so this is a Backend API call — only ever made when a local
   * user row is being created or adopted, never on a cache hit.
   */
  fetchEmail(clerkUserId: string): Promise<string>;
};

export function createClerkVerifier(opts: {
  secretKey: string;
  jwtKey?: string;
}): ClerkVerifier {
  const client = createClerkClient({ secretKey: opts.secretKey });

  return {
    async verifyToken(token) {
      try {
        const payload = await verifyToken(token, {
          secretKey: opts.secretKey,
          jwtKey: opts.jwtKey,
        });
        return payload.sub ? { clerkUserId: payload.sub } : null;
      } catch {
        // Invalid signature, expired, malformed: all are simply "not authed".
        return null;
      }
    },

    async fetchEmail(clerkUserId) {
      const user = await client.users.getUser(clerkUserId);
      const primary = user.emailAddresses.find(
        (e) => e.id === user.primaryEmailAddressId,
      );
      const email = primary?.emailAddress ?? user.emailAddresses[0]?.emailAddress;
      if (!email) {
        throw new Error(`Clerk user ${clerkUserId} has no email address`);
      }
      return email.toLowerCase();
    },
  };
}

/** In-memory verifier for tests. Keeps the suite offline. */
export function createFakeVerifier(
  users: Record<string, { clerkUserId: string; email: string }>,
): ClerkVerifier {
  const byClerkId = new Map(
    Object.values(users).map((u) => [u.clerkUserId, u.email]),
  );
  return {
    async verifyToken(token) {
      const hit = users[token];
      return hit ? { clerkUserId: hit.clerkUserId } : null;
    },
    async fetchEmail(clerkUserId) {
      const email = byClerkId.get(clerkUserId);
      if (!email) throw new Error(`no fake user ${clerkUserId}`);
      return email;
    },
  };
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm --filter @tokenops/api test -- clerk`

Expected: PASS.

- [ ] **Step 6: Verify the real User shape once**

`user.emailAddresses[].emailAddress` and `user.primaryEmailAddressId` are the documented Clerk backend shape, but confirm before trusting it in production. Either use the `clerk-cli` skill to fetch a real user as JSON, or run a one-off script with a real `CLERK_SECRET_KEY` printing `Object.keys(user)` and the email array. Delete the script afterwards.

If the field names differ, fix `fetchEmail` and note it here. Do not proceed on an assumption.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth/clerk.ts apps/api/src/auth/clerk.test.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add Clerk verification port

verifyToken is networkless per request; fetchEmail hits the Backend API and
is only called when provisioning a row, since Clerk's default session token
carries no email claim.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Just-in-time user provisioning

The migration path for the live production account lives here. Get it wrong and the owner signs in to an empty dashboard while their agent keeps shipping to an orphaned row.

**Files:**
- Create: `apps/api/src/auth/provision.ts`
- Create: `apps/api/src/auth/provision.test.ts`

**Interfaces:**
- Consumes: `AuthRepo` (Task 2), `ClerkVerifier` (Task 3)
- Produces: `export async function resolveUserId(repo: AuthRepo, verifier: ClerkVerifier, clerkUserId: string): Promise<string>`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/auth/provision.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createFakeVerifier } from "./clerk.js";
import { createMemoryAuthRepo } from "./repo.js";
import { resolveUserId } from "./provision.js";

const verifier = createFakeVerifier({
  "token-alice": { clerkUserId: "user_alice", email: "alice@example.com" },
  "token-legacy": { clerkUserId: "user_legacy", email: "owner@example.com" },
});

describe("resolveUserId", () => {
  it("creates a row for an unseen clerk identity", async () => {
    const repo = createMemoryAuthRepo();
    const id = await resolveUserId(repo, verifier, "user_alice");

    const row = await repo.getUserByClerkId("user_alice");
    expect(row?.id).toBe(id);
    expect(row?.email).toBe("alice@example.com");
  });

  it("reuses the row on later requests instead of duplicating", async () => {
    const repo = createMemoryAuthRepo();
    const first = await resolveUserId(repo, verifier, "user_alice");
    const second = await resolveUserId(repo, verifier, "user_alice");
    expect(second).toBe(first);
  });

  it("adopts a pre-Clerk row with the same email, preserving its id", async () => {
    const repo = createMemoryAuthRepo();
    const legacy = await repo.insertClerkUser("owner@example.com", null);

    const id = await resolveUserId(repo, verifier, "user_legacy");

    // Same id means PATs, machines, events and aggregates still resolve.
    expect(id).toBe(legacy.id);
    expect((await repo.getUserByClerkId("user_legacy"))?.id).toBe(legacy.id);
  });

  it("does not steal a row already linked to a different clerk identity", async () => {
    const repo = createMemoryAuthRepo();
    const taken = await repo.insertClerkUser("owner@example.com", "user_someone_else");

    const id = await resolveUserId(repo, verifier, "user_legacy");

    expect(id).not.toBe(taken.id);
    expect((await repo.getUserByClerkId("user_someone_else"))?.id).toBe(taken.id);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @tokenops/api test -- provision`

Expected: FAIL — module `./provision.js` not found.

- [ ] **Step 3: Implement provisioning**

Create `apps/api/src/auth/provision.ts`:

```ts
import type { ClerkVerifier } from "./clerk.js";
import type { AuthRepo } from "./repo.js";

/**
 * Map a verified Clerk identity onto a local users row.
 *
 * Three cases, in order:
 *   1. Already linked — the common path, one indexed lookup, no Clerk call.
 *   2. A pre-Clerk row with the same email and no clerk_user_id — adopt it.
 *      This preserves the id, and therefore the PATs, machines, events,
 *      aggregates and recommendations that foreign-key to it. It is how the
 *      production account survives the cutover. A row can only be adopted
 *      while its clerk_user_id is null, so this runs at most once per row.
 *   3. Neither — create a new user.
 */
export async function resolveUserId(
  repo: AuthRepo,
  verifier: ClerkVerifier,
  clerkUserId: string,
): Promise<string> {
  const linked = await repo.getUserByClerkId(clerkUserId);
  if (linked) return linked.id;

  const email = (await verifier.fetchEmail(clerkUserId)).toLowerCase();

  const adoptable = await repo.getUnlinkedUserByEmail(email);
  if (adoptable) {
    await repo.linkClerkId(adoptable.id, clerkUserId);
    return adoptable.id;
  }

  const created = await repo.insertClerkUser(email, clerkUserId);
  return created.id;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @tokenops/api test -- provision`

Expected: PASS, all four.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/provision.ts apps/api/src/auth/provision.test.ts
git commit -m "feat(api): just-in-time Clerk user provisioning

Adopts a pre-Clerk row by email when its clerk_user_id is null, preserving
the row id so existing PATs, machines and events keep resolving. This is the
cutover path for the production account.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `requireUser` middleware, app wiring, env

**Files:**
- Modify: `apps/api/src/auth/middleware.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/src/env.test.ts`
- Test: `apps/api/src/auth/middleware.test.ts` (create)

**Interfaces:**
- Consumes: `resolveUserId` (Task 4), `ClerkVerifier` (Task 3)
- Produces: `export const requireUser: MiddlewareHandler<AuthEnv>`; `AppDeps` gains `clerkVerifier?: ClerkVerifier`; `AppVariables` gains `clerkVerifier: ClerkVerifier`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/auth/middleware.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createFakeVerifier } from "./clerk.js";
import { createMemoryAuthRepo } from "./repo.js";
import { requireUser } from "./middleware.js";

function appWith(repo = createMemoryAuthRepo()) {
  const verifier = createFakeVerifier({
    "token-alice": { clerkUserId: "user_alice", email: "alice@example.com" },
  });
  const app = new Hono<any>();
  app.use("*", async (c, next) => {
    c.set("authRepo", repo);
    c.set("clerkVerifier", verifier);
    await next();
  });
  app.get("/who", requireUser, (c) => c.json({ userId: c.get("userId") }));
  return app;
}

describe("requireUser", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await appWith().request("/who");
    expect(res.status).toBe(401);
  });

  it("rejects an invalid token", async () => {
    const res = await appWith().request("/who", {
      headers: { Authorization: "Bearer token-bogus" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a PAT on a dashboard route", async () => {
    const res = await appWith().request("/who", {
      headers: { Authorization: "Bearer tok_looks_like_a_pat" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts a Clerk token and sets userId", async () => {
    const repo = createMemoryAuthRepo();
    const res = await appWith(repo).request("/who", {
      headers: { Authorization: "Bearer token-alice" },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { userId: string };
    expect((await repo.getUserByClerkId("user_alice"))?.id).toBe(body.userId);
  });

  it("fails loudly when provisioning breaks rather than falling through", async () => {
    // A valid token whose row cannot be created must not become an
    // unauthenticated request: that would silently downgrade auth.
    const repo = createMemoryAuthRepo();
    repo.insertClerkUser = async () => {
      throw new Error("database down");
    };

    const res = await appWith(repo).request("/who", {
      headers: { Authorization: "Bearer token-alice" },
    });
    expect(res.status).toBe(500);
    expect(res.status).not.toBe(401);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @tokenops/api test -- middleware`

Expected: FAIL — `requireUser` is not exported.

- [ ] **Step 3: Replace `requireSession` with `requireUser`**

In `apps/api/src/auth/middleware.ts`, delete `requireSession` and its `getCookie`/`getSession`/`SESSION_COOKIE` imports, keep `requirePat` exactly as-is, and add:

```ts
export type AuthVariables = {
  authRepo: AuthRepo;
  clerkVerifier: ClerkVerifier;
  userId: string;
};

/**
 * Require a Clerk session JWT on `Authorization: Bearer`.
 *
 * PATs share this header, so `tok_`-prefixed values are rejected outright
 * rather than handed to Clerk — an agent credential must never authenticate
 * a dashboard route.
 */
export const requireUser: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const token = header.slice("Bearer ".length).trim();
  if (token.startsWith("tok_")) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const verifier = c.get("clerkVerifier");
  const identity = await verifier.verifyToken(token);
  if (!identity) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const userId = await resolveUserId(
    c.get("authRepo"),
    verifier,
    identity.clerkUserId,
  );
  c.set("userId", userId);
  await next();
};
```

Import `resolveUserId` from `./provision.js` and `ClerkVerifier` from `./clerk.js`.

- [ ] **Step 4: Wire the verifier into the app**

In `apps/api/src/app.ts`: add `clerkVerifier?: ClerkVerifier` to `AppDeps` and `clerkVerifier: ClerkVerifier` to `AppVariables`; construct the default from env; set it in the existing context middleware alongside `authRepo`:

```ts
const clerkVerifier =
  deps.clerkVerifier ??
  createClerkVerifier({
    secretKey: process.env.CLERK_SECRET_KEY!,
    jwtKey: process.env.CLERK_JWT_KEY,
  });
```

Then inside the `app.use("*", …)` block: `c.set("clerkVerifier", clerkVerifier);`

Update the re-export at the bottom to `export { requireUser, requirePat } from "./auth/middleware.js";`

- [ ] **Step 5: Make the secret key required at boot**

In `apps/api/src/env.ts`, add `CLERK_SECRET_KEY: z.string().min(1)` and `CLERK_JWT_KEY: z.string().optional()` to the schema, and delete `BOOTSTRAP_EMAIL` and `BOOTSTRAP_PASSWORD` — nothing has ever read them.

Ensure the failure message names the variable and points at setup docs, so a self-hoster sees the cause in ten seconds rather than a 500 on first request.

In `apps/api/src/env.test.ts`, delete the four `BOOTSTRAP_*` cases and add:

```ts
it("rejects a missing CLERK_SECRET_KEY", () => {
  const { CLERK_SECRET_KEY, ...withoutKey } = { ...base, CLERK_SECRET_KEY: "sk_test_x" };
  expect(() => loadEnv(withoutKey)).toThrow();
});
```

Add `CLERK_SECRET_KEY: "sk_test_x"` to the shared `base` fixture so existing cases still pass.

- [ ] **Step 6: Run the suite**

Run: `pnpm test`

Expected: the middleware and env tests PASS. `auth.test.ts` and route tests still FAIL — they reference `requireSession`, register, and login. Task 6 fixes them. Do not patch them here.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth/middleware.ts apps/api/src/auth/middleware.test.ts apps/api/src/app.ts apps/api/src/env.ts apps/api/src/env.test.ts
git commit -m "feat(api): requireUser middleware backed by Clerk

PATs share the Authorization header, so tok_-prefixed values are rejected
before reaching Clerk: an agent credential must never authenticate a
dashboard route.

CLERK_SECRET_KEY is now required at boot. Drops BOOTSTRAP_EMAIL and
BOOTSTRAP_PASSWORD, which env.ts parsed but no code ever read.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Remove the password stack

**Files:**
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/auth/auth.test.ts`
- Modify: every route file importing `requireSession` (`aggregates.ts`, `events.ts`, `machines.ts`, `recommendations.ts`, `settings.ts`)
- Delete: `apps/api/src/auth/password.ts`, `apps/api/src/auth/session.ts`, `apps/api/src/auth/set-password-script.test.ts`, `apps/api/scripts/set-password.mjs`

**Interfaces:**
- Consumes: `requireUser` (Task 5)
- Produces: `/v1/auth` exposes only `GET /me` and `POST /pats`, both behind `requireUser`.

- [ ] **Step 1: Swap the middleware at every call site**

In each of `aggregates.ts`, `events.ts`, `machines.ts`, `recommendations.ts`, `settings.ts`, and `auth.ts`, replace the `requireSession` import and usage with `requireUser`. Leave every `requirePat` usage untouched — `POST /v1/events` and `POST /v1/heartbeats` stay PAT-only so agents are unaffected.

Confirm none remain: `grep -rn "requireSession" apps/api/src` returns nothing.

- [ ] **Step 2: Strip the auth routes**

In `apps/api/src/routes/auth.ts`, delete the `/register` and `/login` handlers, the `credentialsSchema`, and the `hashPassword`/`verifyPassword`/session-cookie imports. Keep `/me` and `/pats`, now using `requireUser`. If a `/logout` handler exists, delete it — Clerk owns sign-out.

- [ ] **Step 3: Delete the dead files**

```bash
git rm apps/api/src/auth/password.ts apps/api/src/auth/session.ts apps/api/src/auth/set-password-script.test.ts apps/api/scripts/set-password.mjs
```

- [ ] **Step 4: Rewrite the auth tests**

In `apps/api/src/auth/auth.test.ts`, delete every register, login, and session-lifecycle case. Keep and adapt the PAT cases, building the app with a fake verifier:

```ts
const app = createApp({
  db: undefined as never,
  authRepo,
  eventsRepo,
  clerkVerifier: createFakeVerifier({
    "token-alice": { clerkUserId: "user_alice", email: "alice@example.com" },
  }),
});

const res = await app.request("/v1/auth/pats", {
  method: "POST",
  headers: {
    Authorization: "Bearer token-alice",
    "content-type": "application/json",
  },
  body: JSON.stringify({ name: "laptop-agent" }),
});
expect(res.status).toBe(200);
const { token } = (await res.json()) as { token: string };
expect(token.startsWith("tok_")).toBe(true);
```

Then assert that token still authenticates `POST /v1/events` — proving the agent path is untouched by the auth swap.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`

Expected: PASS. If anything still imports `password.js` or `session.js`, the build fails loudly — fix the import, do not restore the file.

- [ ] **Step 6: Commit**

```bash
git add -A apps/api
git commit -m "feat(api)!: delete the password and session stack

Clerk owns human authentication. Removes password.ts, session.ts, the
register and login routes, and the set-password recovery script that
existed only because there was no reset flow.

PAT routes are untouched: agents need no update and no re-install.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Cross-tenant isolation tests

Open signup makes every route a potential leak. Task 1 fixed the write path; this proves the read paths.

**Files:**
- Create: `apps/api/src/routes/tenant-isolation.test.ts`

**Interfaces:**
- Consumes: `createApp`, `createFakeVerifier`, memory repos
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/tenant-isolation.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createFakeVerifier } from "../auth/clerk.js";
import { createMemoryAuthRepo } from "../auth/repo.js";
import { createInMemoryEventsRepo } from "../services/events-repo.js";

const verifier = createFakeVerifier({
  "token-a": { clerkUserId: "user_a", email: "a@example.com" },
  "token-b": { clerkUserId: "user_b", email: "b@example.com" },
});

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("tenant isolation", () => {
  let app: ReturnType<typeof createApp>;
  let eventsRepo: ReturnType<typeof createInMemoryEventsRepo>;

  beforeEach(async () => {
    const authRepo = createMemoryAuthRepo();
    eventsRepo = createInMemoryEventsRepo();
    app = createApp({
      db: undefined as never,
      authRepo,
      eventsRepo,
      clerkVerifier: verifier,
    });

    // Provision both users, then give A a machine.
    await app.request("/v1/auth/me", { headers: bearer("token-a") });
    await app.request("/v1/auth/me", { headers: bearer("token-b") });

    const me = await app.request("/v1/auth/me", { headers: bearer("token-a") });
    const userA = ((await me.json()) as { id: string }).id;
    await eventsRepo.upsertMachine(userA, "machine-a", "alice-laptop", 0);
  });

  it("does not show one user another user's machines", async () => {
    const res = await app.request("/v1/machines", { headers: bearer("token-b") });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("does not show one user another user's events", async () => {
    const res = await app.request("/v1/events", { headers: bearer("token-b") });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("does not show one user another user's aggregates", async () => {
    const res = await app.request("/v1/aggregates", { headers: bearer("token-b") });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("does not show one user another user's recommendations", async () => {
    const res = await app.request("/v1/recommendations", {
      headers: bearer("token-b"),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("does not let one user dismiss another user's recommendation", async () => {
    // dismissRecommendation is scoped by userId; prove it, because a write
    // that ignores the owner is worse than a read that does.
    const me = await app.request("/v1/auth/me", { headers: bearer("token-a") });
    const userA = ((await me.json()) as { id: string }).id;

    const recId = await seedRecommendationFor(eventsRepo, userA);

    const res = await app.request(`/v1/recommendations/${recId}/dismiss`, {
      method: "POST",
      headers: bearer("token-b"),
    });
    expect([403, 404]).toContain(res.status);

    const still = await eventsRepo.listRecommendations(userA, "open");
    expect(still.map((r) => r.id)).toContain(recId);
  });
});
```

Add the seed helper at the top of the file, matching whatever
`createInMemoryEventsRepo` exposes for inserting recommendations — read the
repo's `insertRecommendations` signature before writing it rather than
guessing at the row shape:

```ts
async function seedRecommendationFor(
  repo: ReturnType<typeof createInMemoryEventsRepo>,
  userId: string,
): Promise<string> {
  await repo.insertRecommendations(userId, [
    {
      ruleId: "frontier_for_trivial",
      severity: "medium",
      title: "seed",
      detail: "seed",
      estimatedWastedTokens: 1,
      estimatedWastedUsd: "0",
      eventIds: ["evt-1"],
      dedupeKey: "evt-1",
    },
  ]);
  const [rec] = await repo.listRecommendations(userId, "open");
  return rec!.id;
}
```

> Adjust the expected empty shapes to match each route's actual DTO — some return `{ rows: [] }` rather than a bare array. Read the route before asserting; a test that expects the wrong shape passes for the wrong reason.

- [ ] **Step 2: Run and confirm they pass or expose a real leak**

Run: `pnpm --filter @tokenops/api test -- tenant-isolation`

Expected: PASS. These routes already filter by `userId`, so this is a regression harness, not a bug hunt. **If any fails, stop and fix the route** — a real cross-tenant leak outranks the rest of this plan.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/tenant-isolation.test.ts
git commit -m "test(api): pin cross-tenant isolation on every dashboard route

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Clerk in the dashboard

**Files:**
- Modify: `apps/web/package.json` (add `@clerk/react`)
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/pages/Login.tsx`

**Interfaces:**
- Consumes: the API's bearer-token contract from Task 5
- Produces: `setAuthTokenGetter(getter: () => Promise<string | null>): void` exported from `apps/web/src/api/client.ts`

- [ ] **Step 1: Install the SDK**

Run: `pnpm --filter @tokenops/web add @clerk/react`

> The package is `@clerk/react`, **not** `@clerk/clerk-react`. The older name is a different, deprecated package.

- [ ] **Step 2: Teach the API client to send a token**

In `apps/web/src/api/client.ts`, above `api()`:

```ts
/**
 * Supplies the Clerk session token. Set once at app start; `api()` is a plain
 * module function and cannot call React hooks itself.
 */
let authTokenGetter: (() => Promise<string | null>) | null = null;

export function setAuthTokenGetter(getter: () => Promise<string | null>): void {
  authTokenGetter = getter;
}
```

Inside `api()`, after the Content-Type block and before `fetch`:

```ts
const token = await authTokenGetter?.();
if (token) {
  headers.set("Authorization", `Bearer ${token}`);
}
```

Remove `credentials: "include"` from the `fetch` options — the API no longer reads cookies.

- [ ] **Step 3: Wrap the app in ClerkProvider**

In `apps/web/src/main.tsx`:

```tsx
import { ClerkProvider } from "@clerk/react";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ClerkProvider afterSignOutUrl="/">
      <App />
    </ClerkProvider>
  </StrictMode>,
);
```

Vite reads `VITE_CLERK_PUBLISHABLE_KEY` automatically; do not pass `publishableKey` by hand.

- [ ] **Step 4: Gate the app and register the token getter**

In `apps/web/src/App.tsx`, replace the hand-rolled logged-in state:

```tsx
import { Show, UserButton, useAuth } from "@clerk/react";
import { useEffect } from "react";
import { setAuthTokenGetter } from "./api/client";
import { Login } from "./pages/Login";

export function App() {
  const { getToken } = useAuth();

  useEffect(() => {
    setAuthTokenGetter(() => getToken());
  }, [getToken]);

  return (
    <>
      <Show when="signed-out">
        <Login />
      </Show>
      <Show when="signed-in">
        {/* existing dashboard shell; add <UserButton /> to the header */}
      </Show>
    </>
  );
}
```

`<Show when=…>` replaces the older `<SignedIn>` / `<SignedOut>` components. Delete the `onLoggedIn` prop threading and any `getMe()`-on-mount session probe — Clerk owns that state now.

- [ ] **Step 5: Replace the login page**

Rewrite `apps/web/src/pages/Login.tsx` as Clerk's prebuilt component, keeping the existing page chrome:

```tsx
import { SignIn } from "@clerk/react";

export function Login() {
  return (
    <div className="login-page">
      <div className="login-card">
        <h1>TokenOps</h1>
        <p className="tagline">Sign in to view your usage ledger</p>
        <SignIn />
      </div>
    </div>
  );
}
```

The email/password form, its state, and its `ApiError` handling all go. Sign-up, reset, and MFA now come from Clerk.

- [ ] **Step 6: Build the web app**

Run: `pnpm --filter @tokenops/web build`

Expected: succeeds. Type errors about the removed `onLoggedIn` prop or `UserMe` mean a call site still expects the old flow — fix the call site.

- [ ] **Step 7: Run the full suite**

Run: `pnpm test`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): sign in with Clerk

The API client gains a token getter because api() is a module function and
cannot call hooks; App registers Clerk's getToken once at start.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Stop the Inno installer minting machine IDs

`apps/agent/src/identity.ts` mints `randomUUID()`, and `install.ps1` uses `[guid]::NewGuid()`. Only `TokenOpsAgent.iss` writes `machine.json` itself using `GetDateTimeString('yyyymmddhhnnsszzz')` — a low-entropy, guessable timestamp that also feeds `buildEventId`, which hashes `machineId` into every event ID.

**Files:**
- Modify: `installer/windows/TokenOpsAgent.iss` (`WriteConfig`, machine identity block)
- Test: `apps/agent/test/installer-iss.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: nothing

- [ ] **Step 1: Write the failing test**

Append to `apps/agent/test/installer-iss.test.ts`:

```ts
it("does not mint machine ids in the installer", () => {
  const source = readFileSync(ISS_PATH, "utf8");

  // The agent owns identity: identity.ts uses randomUUID() on first run.
  // A timestamp-derived id here is guessable and also weakens every event id,
  // since buildEventId hashes machineId.
  expect(source).not.toMatch(/machineId/i);
  expect(source).not.toMatch(/GuidStr/);
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @tokenops/agent test -- installer-iss`

Expected: FAIL — `GuidStr` and `machineId` are both present.

- [ ] **Step 3: Delete the identity block**

In `installer/windows/TokenOpsAgent.iss`, remove the whole `{ machine identity }` block in `WriteConfig` — the `GuidStr` assignment, the `SetArrayLength(Lines, 4)` JSON write, and the `IdentityPath` variable and its declaration. Leave `config.toml` writing untouched.

Add a comment where the block was:

```pascal
{ Machine identity is created by the agent on first run (randomUUID in
  identity.ts). The installer must not mint one: a timestamp-derived id is
  guessable, and buildEventId hashes machineId into every event id. }
```

- [ ] **Step 4: Run and confirm it passes**

Run: `pnpm --filter @tokenops/agent test -- installer-iss`

Expected: PASS, including the pre-existing wizard-page guards.

- [ ] **Step 5: Verify the installer still compiles**

The `.iss` cannot be compiled locally unless Inno Setup 6 is installed. CI's `installer-windows` job compiles it on every PR — rely on that, and do not merge until it is green.

- [ ] **Step 6: Commit**

```bash
git add installer/windows/TokenOpsAgent.iss apps/agent/test/installer-iss.test.ts
git commit -m "fix(installer): let the agent own machine identity

The Inno installer minted machine ids from a timestamp, unlike identity.ts
(randomUUID) and install.ps1 (NewGuid). Guessable ids are a cross-tenant
hazard once signup opens, and they weaken every event id because
buildEventId hashes machineId.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md`
- Modify: `deploy/env.example`
- Modify: `deploy/docker-compose.yml`

**Interfaces:**
- Consumes: env var names from Task 5
- Produces: nothing

- [ ] **Step 1: Replace the accounts section in the README**

Delete the "Accounts and lost passwords" section added on 2026-07-31 — the script it documents no longer exists. Replace with:

```markdown
### Authentication

TokenOps uses [Clerk](https://clerk.com) for all human sign-in. **Every
deployment needs a Clerk application, including self-hosted ones.** Sign-up,
password reset, and MFA are handled by Clerk, so TokenOps runs no email
infrastructure.

1. Create a free application at [dashboard.clerk.com](https://dashboard.clerk.com)
2. Set `CLERK_SECRET_KEY` on the API
3. Set `VITE_CLERK_PUBLISHABLE_KEY` on the web build

Agents authenticate separately with PATs and are unaffected by Clerk. Create
one under **Settings → Agent access token**.
```

Update the register/PAT curl instructions in the quick-start, which no longer work — there is no `/v1/auth/register`.

- [ ] **Step 2: Correct the env table**

In the API env table, delete the `BOOTSTRAP_EMAIL` and `BOOTSTRAP_PASSWORD` rows and add:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLERK_SECRET_KEY` | yes | — | Clerk secret key; the API refuses to boot without it |
| `CLERK_JWT_KEY` | no | unset | PEM public key for networkless JWT verification |

Add `VITE_CLERK_PUBLISHABLE_KEY` to the web env table.

- [ ] **Step 3: Update Compose**

Add `CLERK_SECRET_KEY` to `deploy/env.example` and pass it through in `deploy/docker-compose.yml` alongside `SESSION_SECRET`. Note in `env.example` that Compose will not sign in without it.

- [ ] **Step 4: Regenerate the README HTML**

`README.html` is already stale from 2026-07-31. Regenerate it with the same converter used for the spec:

```bash
npx -y marked@15 -i README.md -o /tmp/readme-body.html --gfm
node scripts/build-doc-html.mjs /tmp/readme-body.html README.html
```

If `scripts/build-doc-html.mjs` does not exist yet, promote the scratchpad version used for the Clerk spec into the repo as part of this task — a doc build step that lives only in a temp directory will rot.

- [ ] **Step 5: Verify**

Run: `pnpm test` and confirm CI is green on both jobs.

- [ ] **Step 6: Commit**

```bash
git add README.md README.html deploy/env.example deploy/docker-compose.yml scripts/build-doc-html.mjs
git commit -m "docs: Clerk setup, and drop the removed recovery script

States plainly that self-hosters need their own Clerk application.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Post-merge

Not part of this plan; each needs its own change.

1. **Cutover check.** After deploying, sign in with the address on the existing account and confirm adoption preserved the PAT — the running agent should keep shipping with no reconfiguration. Verify by checking `machines.last_seen_at` advances.
2. **Follow-up migration.** Once adoption is confirmed in production: `clerk_user_id NOT NULL`, drop `password_hash`.
3. **Billing.** `HOSTED_LIMITS` already caps the free tier at three machines. Paid plans need their own spec.
4. **`user.deleted` webhook** for account deletion.
