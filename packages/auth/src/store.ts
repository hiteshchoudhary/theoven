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
}
