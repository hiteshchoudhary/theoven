import { type Connection, type Model, Schema } from 'mongoose'

/**
 * The collections `auth-mongo` owns.
 *
 * Listed by name on the brick's documentation page, because a brick that quietly creates
 * collections in someone's database is a brick they discover during an incident.
 *
 * Mongo has no migration step, so these are created on first write. The indexes are not: they are
 * built when the model is compiled, which is why `authModels()` runs at boot rather than lazily.
 */

export interface UserDocument {
  _id: string
  email: string
  name: string
  passwordHash: string
  emailVerifiedAt: Date | null
  createdAt: Date
}

export interface RefreshTokenDocument {
  _id: string
  userId: string
  tokenHash: string
  expiresAt: Date
  createdAt: Date
}

export interface ResetTokenDocument {
  _id: string
  userId: string
  tokenHash: string
  expiresAt: Date
  usedAt: Date | null
}

/**
 * `_id` is the application's own id, not an ObjectId.
 *
 * The ids come from `@theoven/auth`, which generates them so every storage brick produces the
 * same shape. Letting Mongo assign an ObjectId instead would make the id type depend on which
 * storage brick you chose — visible in JWT subjects, in URLs, and in anything that stored one.
 */
const userSchema = new Schema<UserDocument>(
  {
    _id: { type: String, required: true },
    // Stored lowercased. The unique index is what actually prevents duplicates.
    email: { type: String, required: true },
    name: { type: String, required: true },
    /** argon2id. */
    passwordHash: { type: String, required: true },
    emailVerifiedAt: { type: Date, default: null },
    createdAt: { type: Date, required: true },
  },
  { collection: 'auth_users', versionKey: false, _id: false },
)
userSchema.index({ email: 1 }, { unique: true })

const refreshTokenSchema = new Schema<RefreshTokenDocument>(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true },
    /** SHA-256 of the token. The token itself is never stored. */
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    createdAt: { type: Date, required: true },
  },
  { collection: 'auth_refresh_tokens', versionKey: false, _id: false },
)
// Every refresh is a lookup by hash, so this index is on the hot path.
refreshTokenSchema.index({ tokenHash: 1 }, { unique: true })
// "Sign out everywhere" and password changes delete by user.
refreshTokenSchema.index({ userId: 1 })

const resetTokenSchema = new Schema<ResetTokenDocument>(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { collection: 'auth_reset_tokens', versionKey: false, _id: false },
)
resetTokenSchema.index({ tokenHash: 1 }, { unique: true })

export interface AuthModels {
  users: Model<UserDocument>
  refreshTokens: Model<RefreshTokenDocument>
  resetTokens: Model<ResetTokenDocument>
}

/**
 * Compiles the models against a connection.
 *
 * Off the connection rather than the `mongoose` global, so two apps in one process — or an app
 * and its test suite — do not share model state. Re-compiling the same name on the same
 * connection throws in Mongoose, so an existing model is reused.
 */
export function authModels(connection: Connection): AuthModels {
  return {
    users:
      (connection.models.AuthUser as Model<UserDocument> | undefined) ??
      connection.model('AuthUser', userSchema),
    refreshTokens:
      (connection.models.AuthRefreshToken as Model<RefreshTokenDocument> | undefined) ??
      connection.model('AuthRefreshToken', refreshTokenSchema),
    resetTokens:
      (connection.models.AuthResetToken as Model<ResetTokenDocument> | undefined) ??
      connection.model('AuthResetToken', resetTokenSchema),
  }
}
