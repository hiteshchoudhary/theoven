import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * The tables `auth-basic` owns.
 *
 * Yours to migrate — `oven db generate` will pick these up alongside your own schema. They are
 * listed on the brick's documentation page by name, because a brick that quietly creates tables
 * in someone's database is a brick they discover during an incident.
 *
 * Timestamps are stored as integers (epoch milliseconds) rather than SQLite's `text` dates: they
 * sort correctly, compare cheaply, and do not depend on a string format everyone gets slightly
 * wrong.
 */

export const users = sqliteTable(
  'auth_users',
  {
    id: text('id').primaryKey(),
    /** Stored lowercased. The unique index is what actually prevents duplicates. */
    email: text('email').notNull(),
    name: text('name').notNull(),
    /** argon2id. */
    passwordHash: text('password_hash').notNull(),
    emailVerifiedAt: integer('email_verified_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [uniqueIndex('auth_users_email_idx').on(table.email)],
)

export const refreshTokens = sqliteTable(
  'auth_refresh_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      // Deleting a user must not leave sessions that outlive them.
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the token. The token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    // Every refresh is a lookup by hash, so this index is on the hot path.
    uniqueIndex('auth_refresh_token_hash_idx').on(table.tokenHash),
    // "Sign out everywhere" and password changes delete by user.
    index('auth_refresh_user_idx').on(table.userId),
  ],
)

export const resetTokens = sqliteTable(
  'auth_reset_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    /** Set when redeemed. Single-use is enforced by checking this. */
    usedAt: integer('used_at', { mode: 'timestamp_ms' }),
  },
  (table) => [uniqueIndex('auth_reset_token_hash_idx').on(table.tokenHash)],
)

/** Everything this brick owns, for `oven db generate`. */
export const authSchema = { users, refreshTokens, resetTokens }
