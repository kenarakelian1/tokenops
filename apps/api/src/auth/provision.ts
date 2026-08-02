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

  // `email` is globally unique on the users table. If a row with this email
  // exists but wasn't adoptable (i.e. it's already linked to a different
  // Clerk identity), inserting a new row with the same email would either
  // violate that constraint or, worse, silently hand someone else's email
  // to a new account. Fail loudly instead of letting the repo's low-level
  // uniqueness error (or a duplicate-email row) leak out.
  const existing = await repo.getUserByEmail(email);
  if (existing) {
    throw new Error(
      `Cannot provision Clerk user ${clerkUserId}: email ${email} is already associated with a different account`,
    );
  }

  const created = await repo.insertClerkUser(email, clerkUserId);
  return created.id;
}
