import type {
  AuthStore,
  StoredAccount,
  StoredRefreshToken,
  StoredResetToken,
  StoredUser,
} from '@theoven/auth'
import { and, eq, lt, or } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { refreshTokens, resetTokens, users } from './schema'
import { accounts } from './schema-accounts'

export interface DrizzleStoreOptions {
  /**
   * Expose the linked-account methods, for social sign-in.
   *
   * Off by default, and not a preference: the `auth_accounts` table lives on a separate schema
   * export, so an application that has not added it has no such table. Offering the methods
   * anyway would turn a missing migration into a runtime failure at the first callback instead
   * of a refusal at boot (D19).
   */
  accounts?: boolean
}

/**
 * `AuthStore` over Drizzle.
 *
 * The whole storage half of the brick. Everything security-critical — hashing, token
 * generation, expiry rules — lives in `@theoven/auth` and is shared with every other storage
 * brick (D26). This file only moves rows.
 */
export function drizzleStore(
  db: BunSQLiteDatabase<Record<string, unknown>>,
  options: DrizzleStoreOptions = {},
): AuthStore {
  return {
    ...(options.accounts ? accountMethods(db) : {}),
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

export type { StoredAccount, StoredRefreshToken, StoredResetToken, StoredUser }

/** The linked-account half, spread in only when the application asked for it. */
function accountMethods(
  db: BunSQLiteDatabase<Record<string, unknown>>,
): Pick<AuthStore, 'findAccount' | 'linkAccount' | 'findAccountsByUser' | 'unlinkAccount'> {
  return {
    findAccount: async (provider, providerAccountId) => {
      const [row] = await db
        .select()
        .from(accounts)
        .where(
          and(eq(accounts.provider, provider), eq(accounts.providerAccountId, providerAccountId)),
        )
      return row ? toAccount(row) : null
    },

    linkAccount: async (account) => {
      // Explicit nulls rather than absent keys: the column is nullable, and Drizzle's insert type
      // asks for the difference to be stated rather than inferred.
      const row = {
        ...account,
        accessToken: account.accessToken ?? null,
        refreshToken: account.refreshToken ?? null,
        expiresAt: account.expiresAt ?? null,
        createdAt: new Date(),
      }
      // The unique index on (provider, providerAccountId) is what actually prevents a double
      // link, so a race between two callbacks fails here rather than producing two rows.
      await db.insert(accounts).values(row)
      return toAccount(row)
    },

    findAccountsByUser: async (userId) => {
      const rows = await db.select().from(accounts).where(eq(accounts.userId, userId))
      return rows.map(toAccount)
    },

    unlinkAccount: async (userId, provider) => {
      await db
        .delete(accounts)
        .where(and(eq(accounts.userId, userId), eq(accounts.provider, provider)))
    },
  }
}

function toAccount(row: typeof accounts.$inferSelect): StoredAccount {
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    providerAccountId: row.providerAccountId,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }
}

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
