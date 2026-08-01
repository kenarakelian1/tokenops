# Clerk authentication — design

**Date:** 2026-08-01
**Status:** Approved, not yet implemented
**Supersedes:** the password/session auth introduced in the Phase 1 design

## Problem

TokenOps authenticates the dashboard with an email/password pair and a
server-side `sessions` table. That design has no recovery path and no way to
add a second account:

- `POST /v1/auth/register` returns `403 registration_closed` once any user
  exists, so an instance admits exactly one account, forever.
- There is no reset endpoint, no change-password endpoint, and no email
  transport. A forgotten password stranded the owner of the production
  instance on 2026-07-31.
- `BOOTSTRAP_EMAIL` and `BOOTSTRAP_PASSWORD` are parsed by `env.ts` and were
  documented in the README, but no code reads them. They cannot bootstrap or
  rescue anything.

`apps/api/scripts/set-password.mjs` restored access by writing a scrypt hash
directly to Postgres. That unblocks an operator with shell and database
access. It does nothing for a paying customer.

TokenOps is moving to an open-core model: the repository stays MIT and
self-hostable, and a hosted deployment sells the same product as a service.
The hosted side needs self-serve signup, password reset, and MFA. Building
those means running email infrastructure — deliverability, expiring tokens,
rate limiting — which is a poor use of effort for a usage-observability
product.

## Decision

Delegate all human authentication to Clerk and delete the local password
stack outright. Clerk becomes a hard dependency for every deployment,
self-hosted included.

The alternative considered was a pluggable provider — Clerk when
`CLERK_SECRET_KEY` is set, passwords otherwise — which would keep
`docker compose up` working with no third-party account. It was rejected in
favour of a single auth path: two mechanisms means two sets of middleware,
two migration states, and two test matrices, permanently.

**Accepted cost:** a self-hoster must create a free Clerk application and set
two environment variables before they can sign in. The README and Compose
docs must say so plainly, and the API must fail fast when the keys are
absent.

## Non-goals

- **Billing and paid plans.** `HOSTED_LIMITS` already caps the free tier at
  three machines. Plan enforcement and payment belong in a separate spec.
- **Organisations and team accounts.** One Clerk user maps to one TokenOps
  account. Clerk Organisations are available later without schema churn.
- **Replacing PATs.** Agents are headless daemons; a bearer token they own is
  the correct primitive. PATs stay exactly as they are.
- **Webhook-driven provisioning.** Just-in-time creation covers signup.
  `user.deleted` webhooks arrive when account deletion is needed.

## Architecture

### Request flow

Two credential types share the `Authorization` header and are unambiguous,
because PATs carry a `tok_` prefix that a JWT cannot:

| Caller | Credential | Middleware | Resolves to |
|--------|-----------|------------|-------------|
| Dashboard SPA | Clerk session JWT | `requireUser` | `users.id` |
| Local agent | `tok_…` PAT | `requirePat` | `users.id` |

Both set the same `userId` context variable that every route already reads.
This is what keeps the change small: routes consume `userId` and nothing
else, so swapping the browser mechanism touches one middleware and one
mapping function, not the eight route groups.

The SPA obtains its token from `useAuth().getToken()` and attaches it to each
API call. The API verifies it with `@clerk/backend`.

Bearer tokens rather than Clerk's session cookie: the token is explicit,
survives a future split of web and API onto separate origins, and avoids
depending on cookie forwarding through the nginx `/v1/` proxy.

### Verification port

Token verification sits behind an injectable interface, matching the existing
`authRepo` / `eventsRepo` dependency injection in `createApp`:

```ts
export type ClerkVerifier = {
  /** Returns the Clerk user id and primary email, or null when invalid. */
  verify(token: string): Promise<{ clerkUserId: string; email: string } | null>;
};
```

The production implementation wraps `@clerk/backend`. Tests inject a fake, so
the suite stays offline and fast — the current tests make no network calls and
that must not regress.

### Just-in-time provisioning

On each verified request, `requireUser` resolves the Clerk identity to a local
user:

1. `select … from users where clerk_user_id = $1` — hit, done.
2. Miss: `select … from users where email = $1 and clerk_user_id is null` —
   hit means this is the pre-Clerk account. Adopt it by setting
   `clerk_user_id`, preserving its id and therefore its PATs, machines,
   events, aggregates, and recommendations.
3. Miss: insert a new user row with the Clerk id and email.

Step 2 is the migration path for the live production account and runs at most
once per legacy row. It is safe to leave in place permanently; a row can only
be adopted while `clerk_user_id` is null.

Email is stored for display only. Clerk remains the source of truth, and the
stored copy refreshes whenever a verified token presents a different address.

## Data model

```sql
ALTER TABLE users ADD COLUMN clerk_user_id text UNIQUE;   -- nullable for adoption
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
DROP TABLE sessions;
```

`password_hash` is loosened rather than dropped in this migration so a
rollback does not destroy credentials. A follow-up migration drops the column
and sets `clerk_user_id NOT NULL` once adoption is confirmed in production.

### Tenant isolation fixes

These ship in the same change. They are latent today because one account
exists; open signup makes them exploitable.

**`machines` primary key.** `machine_id` is currently a global primary key,
and `upsertMachine` conflicts on `machines.machineId` alone while setting
`name` and `lastSeenAt` without scoping to the owner
(`apps/api/src/services/events-repo.ts:321`). A second user heartbeating a
colliding id silently overwrites the first user's row. Ownership does not
move, so the victim sees a stranger's machine name and the attacker's machine
never registers.

Fix: composite primary key `(user_id, machine_id)`, with the conflict target
changed to match.

**Machine id entropy.** `apps/agent/src/identity.ts` mints `randomUUID()`, but
the Windows installer writes `machine.json` itself using
`GetDateTimeString('yyyymmddhhnnsszzz')` — a low-entropy, guessable
timestamp. Two generators for one identifier, and the weaker one is
predictable. It also feeds `buildEventId`, which hashes `machineId` into every
event id, so weak machine ids weaken event ids.

Fix: the installer stops generating identity and lets the agent create it on
first run.

## Removals

| Path | Reason |
|------|--------|
| `apps/api/src/auth/password.ts` | scrypt hashing, unused |
| `apps/api/src/auth/session.ts` | session issuance and lookup |
| `apps/api/scripts/set-password.mjs` | recovery script, obsolete |
| `apps/api/src/auth/set-password-script.test.ts` | pins the above |
| `POST /v1/auth/register`, `POST /v1/auth/login` | Clerk owns both |
| `sessions` table | dropped in this migration; nothing reads it once Clerk lands |
| `users.password_hash` | loosened now, dropped in the follow-up migration |
| Password form in `apps/web/src/pages/Login.tsx` | replaced by Clerk |

`requireSession` is renamed `requireUser` at its new call sites rather than
kept as an alias; the name described a mechanism that no longer exists.

## Error handling

- **Missing `CLERK_SECRET_KEY` at boot** — the process exits with a message
  naming the variable and linking the setup docs. `env.ts` already validates
  with Zod; the key joins the required set. Failing at boot rather than on the
  first request is the difference between a ten-second fix and an hour of
  debugging for a self-hoster.
- **Invalid, expired, or malformed token** — `401 {"error":"unauthorized"}`,
  matching the current shape so the SPA's `ApiError` handling is unchanged.
- **Valid token, provisioning fails** — `500`, logged with the Clerk user id.
  Never fall through to an unauthenticated state.
- **Clerk unreachable** — the implementation must use Clerk's networkless
  verification path, checking the JWT signature against a cached JWKS rather
  than calling Clerk per request, so an outage does not break already
  signed-in dashboards mid-session. Fresh sign-in still requires Clerk. The
  exact SDK call is confirmed against current Clerk docs during
  implementation, not assumed here.

## Testing

Existing `auth.test.ts` cases for register, login, and session lifecycle are
deleted with the code they cover. New coverage:

**Provisioning**
- New Clerk identity creates exactly one user row
- Repeated requests reuse the row rather than duplicating
- Legacy row with matching email and null `clerk_user_id` is adopted, and its
  id is unchanged so PATs keep resolving
- A legacy row already carrying a different `clerk_user_id` is not re-adopted

**Credentials**
- Clerk JWT authenticates a dashboard route
- `tok_…` PAT continues to authenticate ingest and heartbeat routes
- A PAT is rejected on dashboard-only routes and a JWT on PAT-only routes
- Invalid and expired tokens return `401`

**Tenant isolation** — new, and the reason the isolation fixes ship here
- User B cannot read A's events, machines, aggregates, or recommendations
- B's heartbeat against A's `machine_id` does not mutate A's row
- B cannot dismiss A's recommendation

Verification is faked through the `ClerkVerifier` port; the suite stays
offline.

## Rollout

1. Merge behind the migration that adds `clerk_user_id` as nullable.
2. Deploy the API with `CLERK_SECRET_KEY`, and the web build with
   `VITE_CLERK_PUBLISHABLE_KEY`.
3. Sign in with Clerk using the address on the existing account; confirm
   adoption preserved the PAT by checking that the running agent still ships.
4. Follow-up migration: `clerk_user_id NOT NULL`, drop `password_hash`.

The agent requires no update and no re-install at any point.

## Follow-ups

- Billing and plan enforcement — separate spec
- `user.deleted` webhook for account deletion
- Clerk Organisations if team accounts are ever wanted
- `README.html` regeneration, which is currently stale against `README.md`
