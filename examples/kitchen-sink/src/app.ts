/**
 * Every brick Oven ships, in one app.
 *
 * This is the integration test for the framework: if a change breaks how two bricks compose,
 * it breaks here rather than in someone's project. It is also the honest answer to "what does a
 * real Oven app look like" — the whole file is configuration, and every route below is business
 * logic with no wiring in it.
 *
 *   bun run --cwd examples/kitchen-sink dev
 */
import { Database } from 'bun:sqlite'
import { auth } from '@theoven/auth'
import { authSchema, basicAuth } from '@theoven/auth-basic'
import { createApp, env, loadRoutes, openapi, requestLogger, securityHeaders } from '@theoven/core'
import { db } from '@theoven/db'
import { drizzleSqlite } from '@theoven/db-drizzle'
import { consoleMail, mail } from '@theoven/mail'
import { memoryQueue, queue } from '@theoven/queue'
import { diskStorage, storage } from '@theoven/storage'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { notifyAuthor } from './jobs'
import * as schema from './schema'

/** Kept beside the schema it mirrors, so the two are changed together. */
const MIGRATION = `
create table if not exists notes (
  id text primary key, author_id text not null, title text not null,
  body text, attachment text, created_at integer not null
);
create table if not exists auth_users (
  id text primary key, email text not null, name text not null,
  password_hash text not null, email_verified_at integer, created_at integer not null
);
create unique index if not exists auth_users_email_idx on auth_users (email);
create table if not exists auth_refresh_tokens (
  id text primary key, user_id text not null references auth_users(id) on delete cascade,
  token_hash text not null, expires_at integer not null, created_at integer not null
);
create unique index if not exists auth_refresh_token_hash_idx on auth_refresh_tokens (token_hash);
create table if not exists auth_reset_tokens (
  id text primary key, user_id text not null references auth_users(id) on delete cascade,
  token_hash text not null, expires_at integer not null, used_at integer
);
create unique index if not exists auth_reset_token_hash_idx on auth_reset_tokens (token_hash);
`

const DATABASE_URL = env.string('DATABASE_URL', ':memory:')

/**
 * One connection, shared.
 *
 * `auth-basic` builds its store at construction, before an app exists, so it needs a client of
 * its own — and the db brick would otherwise open a second one. Two connections to a file waste
 * a handle; two to `:memory:` are two separate databases, which surfaces as "no such table" on
 * a schema you can watch being created. So the connection is opened here and the brick adopts it.
 */
const sqlite = new Database(DATABASE_URL, { create: true })
const client = drizzle(sqlite, { schema })

// An in-memory database starts empty. A file-backed one uses `oven db migrate` instead.
if (DATABASE_URL === ':memory:') sqlite.exec(MIGRATION)

export const app = createApp({
  logLevel: env.oneOf('LOG_LEVEL', ['debug', 'info', 'warn', 'error'], 'info'),
})
  .use(requestLogger())
  .use(securityHeaders())
  .use(db(drizzleSqlite({ client: sqlite, schema })))
  .use(storage(diskStorage({ dir: env.string('STORAGE_DIR', './uploads') })))
  .use(queue(memoryQueue(), { jobs: [notifyAuthor], worker: false }))
  .use(mail(consoleMail(), { from: 'notes@example.com' }))
  .use(
    auth(basicAuth({ db: client, secret: env.string('AUTH_SECRET', 'kitchen-sink-dev-secret') })),
  )
  .use(openapi({ info: { title: 'Kitchen sink', version: '0.1.0' } }))

await loadRoutes(app, `${import.meta.dir}/routes`)

export default app
