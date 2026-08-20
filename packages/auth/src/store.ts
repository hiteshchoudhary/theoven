/**
 * What a storage brick must provide.
 *
 * Seven methods, shaped for exactly these flows. This is **not** a general ORM abstraction and
 * db bricks do not implement it — `ctx.db` stays the native client and your queries stay native
 * (D16). This exists so the security-critical flows can be written once and run on Drizzle,
 * Mongoose, or anything else (D26).
 *
 * A third-party storage brick is roughly a hundred lines: implement these, ship the schema.
 */

export interface StoredUser {
  id: string
  email: string
  name: string
  /** argon2id. Never leaves the storage layer. */
  passwordHash: string
  emailVerifiedAt?: Date | null
  createdAt: Date
}

export interface StoredRefreshToken {
  id: string
  userId: string
  /** SHA-256 of the token. The token itself is never stored (D26). */
  tokenHash: string
  expiresAt: Date
  createdAt: Date
}

export interface StoredResetToken {
  id: string
  userId: string
  tokenHash: string
  expiresAt: Date
  usedAt?: Date | null
}

/**
 * A credential from an identity provider, linked to a user.
 *
 * `providerAccountId` is the provider's own stable id — Google's `sub`, GitHub's numeric id — and
 * **not** the email. An email can change hands; the subject identifier cannot, and keying on it is
 * what stops a renamed account being mistaken for a different person.
 */
export interface StoredAccount {
  id: string
  userId: string
  /** `google`, `github`, … */
  provider: string
  providerAccountId: string
  /**
   * The provider's access and refresh tokens, when the application asked for them to be kept.
   *
   * Absent by default (D35). Storing credentials for someone else's service is a liability an
   * app should take on deliberately, not by inheriting a library's default.
   */
  accessToken?: string | null
  refreshToken?: string | null
  expiresAt?: Date | null
  createdAt: Date
}

export interface AuthStore {
  // --- users ---------------------------------------------------------------------------
  /** Case-insensitive lookup. Emails are compared lowercased, because people type both. */
  findUserByEmail(email: string): Promise<StoredUser | null>
  findUserById(id: string): Promise<StoredUser | null>
  createUser(user: Omit<StoredUser, 'createdAt'>): Promise<StoredUser>
  updateUserPassword(userId: string, passwordHash: string): Promise<void>

  // --- refresh tokens ------------------------------------------------------------------
  createRefreshToken(token: Omit<StoredRefreshToken, 'createdAt'>): Promise<void>
  findRefreshToken(tokenHash: string): Promise<StoredRefreshToken | null>
  /**
   * Deletes refresh tokens.
   *
   * By id for a single logout; by user for "sign out everywhere", which is also what a password
   * change must do — a changed password that leaves old sessions alive has not actually locked
   * anyone out.
   */
  deleteRefreshTokens(where: { id?: string; userId?: string }): Promise<void>

  // --- reset tokens --------------------------------------------------------------------
  createResetToken(token: Omit<StoredResetToken, 'usedAt'>): Promise<void>
  findResetToken(tokenHash: string): Promise<StoredResetToken | null>
  markResetTokenUsed(id: string): Promise<void>

  // --- linked accounts (optional) ------------------------------------------------------
  /**
   * These three are **optional**, and social sign-in declares a capability that is checked at
   * boot (D19).
   *
   * `AuthStore` is a public contract — the docs invite third-party storage bricks and give them a
   * conformance suite to run — so adding required methods would break every one of them for a
   * feature they never asked for. A store without these is a store that cannot do social sign-in,
   * and configuring `oauth` against it fails at startup naming the store, rather than at the first
   * callback.
   */
  findAccount?(provider: string, providerAccountId: string): Promise<StoredAccount | null>
  /** @throws when the pair is already linked — the caller turns that into a refusal, not a steal. */
  linkAccount?(account: Omit<StoredAccount, 'createdAt'>): Promise<StoredAccount>
  /** Every account a user has, so the last-credential check can be made before unlinking one. */
  findAccountsByUser?(userId: string): Promise<StoredAccount[]>
  unlinkAccount?(userId: string, provider: string): Promise<void>
}

/** An `AuthStore` that can hold linked accounts. Narrowed at boot, so the flows need no guards. */
export type AccountCapableStore = AuthStore &
  Required<Pick<AuthStore, 'findAccount' | 'linkAccount' | 'findAccountsByUser' | 'unlinkAccount'>>

/** Whether a store can hold linked accounts. */
export function supportsAccounts(store: AuthStore): store is AccountCapableStore {
  return (
    typeof store.findAccount === 'function' &&
    typeof store.linkAccount === 'function' &&
    typeof store.findAccountsByUser === 'function' &&
    typeof store.unlinkAccount === 'function'
  )
}
