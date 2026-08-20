import type {
  AuthStore,
  StoredAccount,
  StoredRefreshToken,
  StoredResetToken,
  StoredUser,
} from '@theoven/auth'
import type { Connection } from 'mongoose'
import { type AuthModels, authModels } from './schema'

/**
 * `AuthStore` over Mongoose.
 *
 * The whole storage half of the brick, and the entire difference between `auth-mongo` and
 * `auth-basic`. Everything security-critical — hashing, token generation, expiry rules, the
 * endpoints, the rate limits — lives in `@theoven/auth` and is shared (D26). This file only
 * moves documents.
 *
 * It is also the test of whether `AuthStore` is a real contract or a description of Drizzle. It
 * fit without changes.
 */
export interface MongooseStoreOptions {
  /**
   * Expose the linked-account methods, for social sign-in.
   *
   * Off by default, matching `auth-basic`. Mongo would create the collection on first write
   * rather than failing, which is precisely why this is explicit: a typo in a provider name
   * should not silently create `auth_accounts` in a database that was never meant to have one.
   */
  accounts?: boolean
}

export function mongooseStore(
  connection: Connection,
  options: MongooseStoreOptions = {},
): AuthStore {
  /**
   * Compiled on first use, not at construction.
   *
   * Building a store should not require a live connection — and eagerly compiling models here
   * meant a configuration error like a missing signing secret surfaced as a Mongoose crash
   * instead of the sentence that says what to fix.
   */
  let compiled: AuthModels | undefined
  const models = (): AuthModels => {
    compiled ??= authModels(connection)
    return compiled
  }

  const accountMethods: Pick<
    AuthStore,
    'findAccount' | 'linkAccount' | 'findAccountsByUser' | 'unlinkAccount'
  > = {
    findAccount: async (provider, providerAccountId) => {
      const doc = await models().accounts.findOne({ provider, providerAccountId }).lean()
      return doc ? toAccount(doc) : null
    },

    linkAccount: async (account) => {
      const doc = {
        _id: account.id,
        userId: account.userId,
        provider: account.provider,
        providerAccountId: account.providerAccountId,
        accessToken: account.accessToken ?? null,
        refreshToken: account.refreshToken ?? null,
        expiresAt: account.expiresAt ?? null,
        createdAt: new Date(),
      }
      // The unique index rejects a second link for the same provider account, which is what
      // makes the refusal a database guarantee rather than a check we might forget.
      await models().accounts.create(doc)
      return toAccount(doc)
    },

    findAccountsByUser: async (userId) => {
      const docs = await models().accounts.find({ userId }).lean()
      return docs.map(toAccount)
    },

    unlinkAccount: async (userId, provider) => {
      await models().accounts.deleteOne({ userId, provider })
    },
  }

  return {
    ...(options.accounts ? accountMethods : {}),
    findUserByEmail: async (email) => {
      const doc = await models().users.findOne({ email: email.toLowerCase() }).lean()
      return doc ? toUser(doc) : null
    },

    findUserById: async (id) => {
      const doc = await models().users.findById(id).lean()
      return doc ? toUser(doc) : null
    },

    createUser: async (user) => {
      const createdAt = new Date()
      const { id, ...rest } = user
      await models().users.create({
        _id: id,
        ...rest,
        emailVerifiedAt: user.emailVerifiedAt ?? null,
        createdAt,
      })
      return { ...user, emailVerifiedAt: user.emailVerifiedAt ?? null, createdAt }
    },

    updateUserPassword: async (userId, passwordHash) => {
      await models().users.updateOne({ _id: userId }, { $set: { passwordHash } })
    },

    createRefreshToken: async (token) => {
      const { id, ...rest } = token
      await models().refreshTokens.create({ _id: id, ...rest, createdAt: new Date() })
    },

    findRefreshToken: async (tokenHash) => {
      const doc = await models().refreshTokens.findOne({ tokenHash }).lean()
      return doc ? toRefreshToken(doc) : null
    },

    deleteRefreshTokens: async (where) => {
      const conditions: Array<Record<string, string>> = []
      if (where.id) conditions.push({ _id: where.id })
      if (where.userId) conditions.push({ userId: where.userId })
      // Deleting with no condition would wipe every session in the database. Refusing is the
      // only safe reading of a call that forgot to say what to delete.
      if (conditions.length === 0) return

      await models().refreshTokens.deleteMany(
        conditions.length === 1 ? conditions[0] : { $or: conditions },
      )
    },

    createResetToken: async (token) => {
      const { id, ...rest } = token
      await models().resetTokens.create({ _id: id, ...rest, usedAt: null })
    },

    findResetToken: async (tokenHash) => {
      const doc = await models().resetTokens.findOne({ tokenHash }).lean()
      return doc ? toResetToken(doc) : null
    },

    markResetTokenUsed: async (id) => {
      await models().resetTokens.updateOne({ _id: id }, { $set: { usedAt: new Date() } })
    },
  }
}

/**
 * Documents come back with `_id`; the rest of Oven works in `id`.
 *
 * Mapped here rather than leaked upward, so a flow written against `AuthStore` never has to know
 * which storage brick answered it.
 */
function toUser(doc: {
  _id: string
  email: string
  name: string
  passwordHash: string
  emailVerifiedAt?: Date | null
  createdAt: Date
}): StoredUser {
  return {
    id: doc._id,
    email: doc.email,
    name: doc.name,
    passwordHash: doc.passwordHash,
    emailVerifiedAt: doc.emailVerifiedAt ?? null,
    createdAt: doc.createdAt,
  }
}

function toRefreshToken(doc: {
  _id: string
  userId: string
  tokenHash: string
  expiresAt: Date
  createdAt: Date
}): StoredRefreshToken {
  return {
    id: doc._id,
    userId: doc.userId,
    tokenHash: doc.tokenHash,
    expiresAt: doc.expiresAt,
    createdAt: doc.createdAt,
  }
}

function toResetToken(doc: {
  _id: string
  userId: string
  tokenHash: string
  expiresAt: Date
  usedAt?: Date | null
}): StoredResetToken {
  return {
    id: doc._id,
    userId: doc.userId,
    tokenHash: doc.tokenHash,
    expiresAt: doc.expiresAt,
    usedAt: doc.usedAt ?? null,
  }
}

/**
 * Deletes expired refresh and reset tokens.
 *
 * Nothing calls this automatically. Expired tokens are already refused on use, so this is
 * housekeeping rather than a security control — run it from a cron job when the collections
 * start to bother you.
 */
function toAccount(doc: {
  _id: string
  userId: string
  provider: string
  providerAccountId: string
  accessToken?: string | null
  refreshToken?: string | null
  expiresAt?: Date | null
  createdAt: Date
}): StoredAccount {
  return {
    id: doc._id,
    userId: doc.userId,
    provider: doc.provider,
    providerAccountId: doc.providerAccountId,
    accessToken: doc.accessToken ?? null,
    refreshToken: doc.refreshToken ?? null,
    expiresAt: doc.expiresAt ?? null,
    createdAt: doc.createdAt,
  }
}

export async function pruneExpiredTokens(connection: Connection, now = new Date()): Promise<void> {
  const models = authModels(connection)
  await models.refreshTokens.deleteMany({ expiresAt: { $lt: now } })
  await models.resetTokens.deleteMany({ expiresAt: { $lt: now } })
}
