import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { users, sessions, pats } from "../db/schema.js";

export type AuthUser = {
  id: string;
  email: string;
  passwordHash: string;
  budgetUsdMonthly: string | null;
};

export type AuthRepo = {
  countUsers(): Promise<number>;
  insertUser(email: string, passwordHash: string): Promise<AuthUser>;
  getUserByEmail(email: string): Promise<AuthUser | null>;
  getUserById(id: string): Promise<AuthUser | null>;
  updateBudgetUsdMonthly(
    userId: string,
    budgetUsdMonthly: string | null,
  ): Promise<void>;
  insertSession(id: string, userId: string, expiresAt: Date): Promise<void>;
  getSession(
    id: string,
  ): Promise<{ userId: string; expiresAt: Date } | null>;
  deleteSession(id: string): Promise<void>;
  insertPat(
    userId: string,
    name: string,
    tokenHash: string,
  ): Promise<{ id: string }>;
  getPatByTokenHash(
    tokenHash: string,
  ): Promise<{ userId: string; revokedAt: Date | null } | null>;
};

/** Drizzle-backed AuthRepo for production. */
export function createDrizzleAuthRepo(db: Db): AuthRepo {
  return {
    async countUsers() {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(users);
      return rows[0]?.count ?? 0;
    },

    async insertUser(email, passwordHash) {
      const [row] = await db
        .insert(users)
        .values({ email, passwordHash })
        .returning();
      return {
        id: row.id,
        email: row.email,
        passwordHash: row.passwordHash,
        budgetUsdMonthly: row.budgetUsdMonthly,
      };
    },

    async getUserByEmail(email) {
      const [row] = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        email: row.email,
        passwordHash: row.passwordHash,
        budgetUsdMonthly: row.budgetUsdMonthly,
      };
    },

    async getUserById(id) {
      const [row] = await db
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        email: row.email,
        passwordHash: row.passwordHash,
        budgetUsdMonthly: row.budgetUsdMonthly,
      };
    },

    async updateBudgetUsdMonthly(userId, budgetUsdMonthly) {
      await db
        .update(users)
        .set({ budgetUsdMonthly })
        .where(eq(users.id, userId));
    },

    async insertSession(id, userId, expiresAt) {
      await db.insert(sessions).values({ id, userId, expiresAt });
    },

    async getSession(id) {
      const [row] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, id))
        .limit(1);
      if (!row) return null;
      return { userId: row.userId, expiresAt: row.expiresAt };
    },

    async deleteSession(id) {
      await db.delete(sessions).where(eq(sessions.id, id));
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
  };
}

/** In-memory AuthRepo for unit/route tests (no Postgres). */
export function createMemoryAuthRepo(): AuthRepo {
  const userMap = new Map<string, AuthUser>();
  const emailIndex = new Map<string, string>();
  const sessionMap = new Map<string, { userId: string; expiresAt: Date }>();
  const patMap = new Map<
    string,
    { id: string; userId: string; name: string; revokedAt: Date | null }
  >();
  let patSeq = 0;

  return {
    async countUsers() {
      return userMap.size;
    },

    async insertUser(email, passwordHash) {
      if (emailIndex.has(email.toLowerCase())) {
        throw new Error("email already exists");
      }
      const id = crypto.randomUUID();
      const user: AuthUser = {
        id,
        email,
        passwordHash,
        budgetUsdMonthly: null,
      };
      userMap.set(id, user);
      emailIndex.set(email.toLowerCase(), id);
      return user;
    },

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

    async insertSession(id, userId, expiresAt) {
      sessionMap.set(id, { userId, expiresAt });
    },

    async getSession(id) {
      return sessionMap.get(id) ?? null;
    },

    async deleteSession(id) {
      sessionMap.delete(id);
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
  };
}
