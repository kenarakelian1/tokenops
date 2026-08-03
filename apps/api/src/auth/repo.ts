import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { users, pats } from "../db/schema.js";

export type AuthUser = {
  id: string;
  email: string;
  clerkUserId: string | null;
  budgetUsdMonthly: string | null;
};

export type AuthRepo = {
  getUserByEmail(email: string): Promise<AuthUser | null>;
  getUserById(id: string): Promise<AuthUser | null>;
  updateBudgetUsdMonthly(
    userId: string,
    budgetUsdMonthly: string | null,
  ): Promise<void>;
  insertPat(
    userId: string,
    name: string,
    tokenHash: string,
  ): Promise<{ id: string }>;
  getPatByTokenHash(
    tokenHash: string,
  ): Promise<{ userId: string; revokedAt: Date | null } | null>;
  getUserByClerkId(clerkUserId: string): Promise<AuthUser | null>;
  getUnlinkedUserByEmail(email: string): Promise<AuthUser | null>;
  /**
   * Link a clerk_user_id to a user row, but only while that row's
   * clerk_user_id is still NULL. Returns whether the link actually
   * happened. This is the write-side of the adopt-at-most-once invariant:
   * a read check (`getUnlinkedUserByEmail`) is not enough on its own,
   * because two concurrent callers can both pass the read before either
   * writes. Returning `false` (rather than silently overwriting or
   * throwing) lets the caller detect a lost race and resolve it instead of
   * one write clobbering the other — the previous unconditional `SET`
   * allowed a second, different Clerk identity to steal an already-linked
   * row via last-write-wins.
   */
  linkClerkId(userId: string, clerkUserId: string): Promise<boolean>;
  insertClerkUser(
    email: string,
    clerkUserId: string | null,
  ): Promise<AuthUser>;
};

function toAuthUser(row: typeof users.$inferSelect): AuthUser {
  return {
    id: row.id,
    email: row.email,
    clerkUserId: row.clerkUserId,
    budgetUsdMonthly: row.budgetUsdMonthly,
  };
}

/** Drizzle-backed AuthRepo for production. */
export function createDrizzleAuthRepo(db: Db): AuthRepo {
  return {
    async getUserByEmail(email) {
      const [row] = await db
        .select()
        .from(users)
        .where(eq(users.email, email.toLowerCase()))
        .limit(1);
      return row ? toAuthUser(row) : null;
    },

    async getUserById(id) {
      const [row] = await db
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      return row ? toAuthUser(row) : null;
    },

    async updateBudgetUsdMonthly(userId, budgetUsdMonthly) {
      await db
        .update(users)
        .set({ budgetUsdMonthly })
        .where(eq(users.id, userId));
    },

    async insertPat(userId, name, tokenHash) {
      const [row] = await db
        .insert(pats)
        .values({ userId, name, tokenHash })
        .returning({ id: pats.id });
      return { id: row.id };
    },

    async getPatByTokenHash(tokenHash) {
      const [row] = await db
        .select({
          userId: pats.userId,
          revokedAt: pats.revokedAt,
        })
        .from(pats)
        .where(eq(pats.tokenHash, tokenHash))
        .limit(1);
      if (!row) return null;
      return { userId: row.userId, revokedAt: row.revokedAt };
    },

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
        .where(
          and(eq(users.email, email.toLowerCase()), isNull(users.clerkUserId)),
        )
        .limit(1);
      return row ? toAuthUser(row) : null;
    },

    async linkClerkId(userId, clerkUserId) {
      const rows = await db
        .update(users)
        .set({ clerkUserId })
        .where(and(eq(users.id, userId), isNull(users.clerkUserId)))
        .returning({ id: users.id });
      return rows.length > 0;
    },

    async insertClerkUser(email, clerkUserId) {
      const [row] = await db
        .insert(users)
        .values({ email: email.toLowerCase(), clerkUserId })
        .returning();
      return toAuthUser(row);
    },
  };
}

/** In-memory AuthRepo for unit/route tests (no Postgres). */
export function createMemoryAuthRepo(): AuthRepo {
  const userMap = new Map<string, AuthUser>();
  const emailIndex = new Map<string, string>();
  const clerkIndex = new Map<string, string>();
  const patMap = new Map<
    string,
    { id: string; userId: string; name: string; revokedAt: Date | null }
  >();
  let patSeq = 0;

  function insert(email: string, clerkUserId: string | null): AuthUser {
    const normalizedEmail = email.toLowerCase();
    if (emailIndex.has(normalizedEmail)) {
      throw new Error("email already exists");
    }
    if (clerkUserId && clerkIndex.has(clerkUserId)) {
      throw new Error("clerk_user_id already exists");
    }
    const id = crypto.randomUUID();
    const user: AuthUser = {
      id,
      email: normalizedEmail,
      clerkUserId,
      budgetUsdMonthly: null,
    };
    userMap.set(id, user);
    emailIndex.set(normalizedEmail, id);
    if (clerkUserId) {
      clerkIndex.set(clerkUserId, id);
    }
    return user;
  }

  return {
    async getUserByEmail(email) {
      const id = emailIndex.get(email.toLowerCase());
      if (!id) return null;
      return userMap.get(id) ?? null;
    },

    async getUserById(id) {
      return userMap.get(id) ?? null;
    },

    async updateBudgetUsdMonthly(userId, budgetUsdMonthly) {
      const user = userMap.get(userId);
      if (user) {
        user.budgetUsdMonthly = budgetUsdMonthly;
      }
    },

    async insertPat(userId, name, tokenHash) {
      patSeq += 1;
      const id = `00000000-0000-4000-8000-${String(patSeq).padStart(12, "0")}`;
      patMap.set(tokenHash, { id, userId, name, revokedAt: null });
      return { id };
    },

    async getPatByTokenHash(tokenHash) {
      const row = patMap.get(tokenHash);
      if (!row) return null;
      return { userId: row.userId, revokedAt: row.revokedAt };
    },

    async getUserByClerkId(clerkUserId) {
      const id = clerkIndex.get(clerkUserId);
      if (!id) return null;
      return userMap.get(id) ?? null;
    },

    async getUnlinkedUserByEmail(email) {
      const id = emailIndex.get(email.toLowerCase());
      if (!id) return null;
      const user = userMap.get(id);
      if (!user || user.clerkUserId) return null;
      return user;
    },

    async linkClerkId(userId, clerkUserId) {
      const user = userMap.get(userId);
      if (!user) return false;
      // Mirrors the Drizzle repo's `isNull(users.clerkUserId)` predicate:
      // linking only succeeds while this row is still unlinked. Once set,
      // it is immutable via this method — adoption runs at most once per
      // row, and a second caller (a lost race, not a deliberate relink)
      // gets `false` instead of silently overwriting the first link.
      if (user.clerkUserId !== null) return false;
      const existingOwner = clerkIndex.get(clerkUserId);
      if (existingOwner && existingOwner !== userId) {
        throw new Error("clerk_user_id already exists");
      }
      user.clerkUserId = clerkUserId;
      clerkIndex.set(clerkUserId, userId);
      return true;
    },

    async insertClerkUser(email, clerkUserId) {
      return insert(email, clerkUserId);
    },
  };
}
