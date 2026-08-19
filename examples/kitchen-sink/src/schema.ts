import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * This app's own tables.
 *
 * `auth-basic`'s three tables are re-exported below so `oven db generate` writes migrations for
 * them alongside these — without that line, signup fails at runtime with "no such table".
 */
export const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  authorId: text('author_id').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  attachment: text('attachment'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

export * from '@theoven/auth-basic/schema'
