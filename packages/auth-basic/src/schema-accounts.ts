import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { users } from './schema'

/**
 * Linked provider accounts, for social sign-in.
 *
 * A **separate export path** from the rest of the schema, so an application that never uses
 * social sign-in never gets this table. Adding it is one line in your own `schema.ts`, which
 * means the migration follows from something you wrote rather than appearing in `git status`.
 *
 * ```ts title="src/schema.ts"
 * export * from '@theoven/auth-basic/schema'
 * export * from '@theoven/auth-basic/schema/accounts'
 * ```
 */
export const accounts = sqliteTable(
  'auth_accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      // A deleted user must not leave credentials behind that still resolve to their id.
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `google`, `github`, … */
    provider: text('provider').notNull(),
    /** The provider's own subject id. Never the email — an email can change hands. */
    providerAccountId: text('provider_account_id').notNull(),
    /** Null unless the application asked for tokens to be kept (D35). */
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    // The database enforces "one user per provider account", so a race cannot link one twice.
    uniqueIndex('auth_accounts_provider_idx').on(table.provider, table.providerAccountId),
    index('auth_accounts_user_idx').on(table.userId),
  ],
)
