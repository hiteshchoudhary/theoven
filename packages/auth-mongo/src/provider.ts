import type {
  AuthProvider,
  PasswordAuthOptions,
  PasswordAuthService,
  StoredUser,
} from '@theoven/auth'
import { passwordAuthProvider } from '@theoven/auth'
import type { Connection } from 'mongoose'
import { mongooseStore } from './store'

/**
 * Everything except where the documents live.
 *
 * The flows, endpoints, cookies and rate limits come from `@theoven/auth`, shared with
 * `auth-basic` and every other storage brick (D26). This package's job is the Mongoose half.
 */
export interface MongoAuthOptions extends Omit<PasswordAuthOptions, 'store' | 'name'> {
  /**
   * The Mongoose connection. Usually `ctx.db` from
   * [`db-mongoose`](/docs/bricks/db-mongoose/) — the same one the rest of your app uses.
   */
  connection: Connection
}

/** Everything `auth-mongo` exposes on `ctx.auth`. */
export type MongoAuthService = PasswordAuthService

/**
 * Email-and-password auth, stored in MongoDB.
 *
 * Identical to [`auth-basic`](/docs/bricks/auth-basic/) in every observable way — the same eight
 * endpoints, the same tokens, the same rate limits, the same refusals. Only the storage differs,
 * which is the whole claim `AuthStore` makes.
 */
export function mongoAuth(options: MongoAuthOptions): AuthProvider<StoredUser> & MongoAuthService {
  const { connection, ...rest } = options
  // Configuring `oauth` is the opt-in, exactly as in auth-basic.
  const accounts = Boolean(rest.oauth && Object.keys(rest.oauth).length > 0)
  return passwordAuthProvider({
    ...rest,
    name: 'mongo',
    store: mongooseStore(connection, { accounts }),
  })
}
