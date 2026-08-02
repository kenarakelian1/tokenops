import type { ClerkVerifier } from "./clerk.js";
import type { AuthRepo } from "./repo.js";

/**
 * Thrown when a Clerk identity's email is already associated with a
 * different, already-linked local user — i.e. adoption or creation would
 * require stealing or duplicating someone else's row. Follows the
 * `MachineLimitError` pattern (see `services/ingest.ts`): a typed, tagged
 * error the route layer maps to a clean HTTP response (409
 * `{ error: "email_conflict" }`) via `instanceof`, instead of sniffing a
 * message string.
 */
export class EmailConflictError extends Error {
  readonly code = "email_conflict" as const;
  constructor(message = "email already associated with a different account") {
    super(message);
    this.name = "EmailConflictError";
  }
}

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
 *
 * Both case 2 and case 3 are racy: two concurrent requests for the same new
 * (or newly-adoptable) identity can both pass their read checks before
 * either writes. `repo.linkClerkId` and `repo.insertClerkUser` carry the
 * real invariants (clerk_user_id and email are both unique, and linking
 * only succeeds while clerk_user_id is still NULL), so a lost race surfaces
 * as either `linkClerkId` returning false or `insertClerkUser` throwing.
 * Rather than let that reach the caller as a raw driver-level error, we
 * re-check `getUserByClerkId` once: if this identity's row now exists (a
 * concurrent request for the *same* identity won), resolve to it. If some
 * *other* identity won the row instead, that is the account-takeover this
 * function exists to prevent — throw `EmailConflictError`, never adopt.
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
    const didLink = await repo.linkClerkId(adoptable.id, clerkUserId);
    if (didLink) return adoptable.id;

    // Lost the adopt race: `linkClerkId` only succeeds while clerk_user_id
    // is still NULL, and it is no longer NULL. Find out who won.
    const winner = await repo.getUserByClerkId(clerkUserId);
    if (winner) return winner.id; // a concurrent request for *this* identity won
    throw new EmailConflictError(
      `Cannot provision Clerk user ${clerkUserId}: email ${email} was adopted by a different account during a concurrent request`,
    );
  }

  // `email` is globally unique on the users table. If a row with this email
  // exists but wasn't adoptable (i.e. it's already linked to a different
  // Clerk identity), inserting a new row with the same email would either
  // violate that constraint or, worse, silently hand someone else's email
  // to a new account. Fail loudly instead of letting the repo's low-level
  // uniqueness error (or a duplicate-email row) leak out.
  const existing = await repo.getUserByEmail(email);
  if (existing) {
    throw new EmailConflictError(
      `Cannot provision Clerk user ${clerkUserId}: email ${email} is already associated with a different account`,
    );
  }

  try {
    const created = await repo.insertClerkUser(email, clerkUserId);
    return created.id;
  } catch (err) {
    // Lost a create race: a concurrent request for this same new identity
    // already inserted the row (same email, same clerk_user_id — both
    // unique on the users table). Resolve to its row instead of surfacing
    // a raw unique-violation.
    const winner = await repo.getUserByClerkId(clerkUserId);
    if (winner) return winner.id;
    throw err;
  }
}
