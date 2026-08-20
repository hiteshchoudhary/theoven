import type {
  AuthProvider,
  PasswordAuthOptions,
  PasswordAuthService,
  StoredUser,
} from '@theoven/auth'
import { passwordAuthProvider } from '@theoven/auth'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { drizzleStore } from './store'

/**
 * Everything except where the rows live.
 *
 * The flows, endpoints, cookies and rate limits come from `@theoven/auth`, shared with every
 * other storage brick (D26). This package's job is the Drizzle half: `store.ts` and `schema.ts`.
 */
export interface BasicAuthOptions extends Omit<PasswordAuthOptions, 'store' | 'name'> {
  /** The Drizzle client. Usually the same one the rest of your app uses. */
  db: BunSQLiteDatabase<Record<string, unknown>>
}

/** Everything `auth-basic` exposes on `ctx.auth`. */
export type BasicAuthService = PasswordAuthService

/**
 * Email-and-password auth, stored with Drizzle.
 *
 * Mounts the whole flow at `/auth/*` and identifies requests from a short-lived access JWT.
 * Sessions are revocable: logout deletes the refresh row, and the access token expires within
 * its window (D20).
 */
export function basicAuth(options: BasicAuthOptions): AuthProvider<StoredUser> & BasicAuthService {
  const { db, ...rest } = options
  // Configuring `oauth` is the opt-in: it turns on the store's account methods, and the provider
  // then checks at boot that the schema was added too.
  const accounts = Boolean(rest.oauth && Object.keys(rest.oauth).length > 0)
  return passwordAuthProvider({ ...rest, name: 'basic', store: drizzleStore(db, { accounts }) })
}
