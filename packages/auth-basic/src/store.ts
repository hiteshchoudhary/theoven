import type { AuthStore, StoredRefreshToken, StoredResetToken, StoredUser } from '@theoven/auth'
import { and, eq, lt, or } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { refreshTokens, resetTokens, users } from './schema'

/**
 * `AuthStore` over Drizzle.
 *
 * The whole storage half of the brick. Everything security-critical — hashing, token
 * generation, expiry rules — lives in `@theoven/auth` and is shared with every other storage
 * brick (D26). This file only moves rows.
 */
export function drizzleStore(db: BunSQLiteDatabase<Record<string, unknown>>): AuthStore {
  return {
    findUserByEmail: async (email) => {
      const [row] = await db.select().from(users).where(eq(users.email, email.toLowerCase()))
      return row ? toUser(row) : null
    },

    findUserById: async (id) => {
      const [row] = await db.select().from(users).where(eq(users.id, id))
      return row ? toUser(row) : null
    },

    createUser: async (user) => {
      const row = { ...user, emailVerifiedAt: user.emailVerifiedAt ?? null, createdAt: new Date() }
      await db.insert(users).values(row)
      return toUser(row)
    },

    updateUserPassword: async (userId, passwordHash) => {
      await db.update(users).set({ passwordHash }).where(eq(users.id, userId))
    },

    createRefreshToken: async (token) => {
      await db.insert(refreshTokens).values({ ...token, createdAt: new Date() })
    },

    findRefreshToken: async (tokenHash) => {
      const [row] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash))
      return row ?? null
    },

    deleteRefreshTokens: async (where) => {
      const conditions = []
      if (where.id) conditions.push(eq(refreshTokens.id, where.id))
      if (where.userId) conditions.push(eq(refreshTokens.userId, where.userId))
      // Deleting with no condition would wipe every session in the database. Refusing is the
      // only safe reading of a call that forgot to say what to delete.
      if (conditions.length === 0) return

      await db
        .delete(refreshTokens)
        .where(conditions.length === 1 ? conditions[0] : or(...conditions))
    },

    createResetToken: async (token) => {
      await db.insert(resetTokens).values({ ...token, usedAt: null })
    },

    findResetToken: async (tokenHash) => {
      const [row] = await db.select().from(resetTokens).where(eq(resetTokens.tokenHash, tokenHash))
      return row ?? null
    },

    markResetTokenUsed: async (id) => {
      await db.update(resetTokens).set({ usedAt: new Date() }).where(eq(resetTokens.id, id))
    },
  }
}

type UserRow = typeof users.$inferSelect

function toUser(row: UserRow): StoredUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.passwordHash,
    emailVerifiedAt: row.emailVerifiedAt,
    createdAt: row.createdAt,
  }
}

export type { StoredRefreshToken, StoredResetToken, StoredUser }

/**
 * Deletes expired refresh and reset tokens.
 *
 * Nothing calls this automatically. Expired tokens are already refused on use, so this is
 * housekeeping rather than a security control — run it from a cron job when the table starts
 * to bother you.
 */
export async function pruneExpiredTokens(
  db: BunSQLiteDatabase<Record<string, unknown>>,
  now = new Date(),
): Promise<void> {
  await db.delete(refreshTokens).where(lt(refreshTokens.expiresAt, now))
  await db.delete(resetTokens).where(and(lt(resetTokens.expiresAt, now)))
}
