import { beforeEach, describe, expect, test } from 'bun:test'
import { type AuthStore, supportsAccounts } from './store'

/**
 * The conformance suite every `AuthStore` must pass.
 *
 * Exported from `@theoven/auth` rather than copied into each storage brick, for the same reason
 * the flows are: two copies of a contract test drift, and the one that drifts is the one nobody
 * is looking at. `auth-basic` runs this against Drizzle, `auth-mongo` against Mongoose, and a
 * third-party brick can run it against anything.
 *
 * It checks the behaviours the flows actually depend on — case-insensitive email lookup, the
 * refusal to delete every session on an empty filter, tokens found by hash — rather than that
 * each method returns something. A store that satisfies these can run the security-critical
 * flows unchanged.
 *
 * ```ts
 * describeAuthStore('drizzle', async () => drizzleStore(freshDatabase()))
 * ```
 */
export function describeAuthStore(
  name: string,
  makeStore: () => AuthStore | Promise<AuthStore>,
): void {
  describe(`AuthStore conformance: ${name}`, () => {
    let store: AuthStore

    beforeEach(async () => {
      store = await makeStore()
    })

    const user = {
      id: 'user-1',
      email: 'ada@example.com',
      name: 'Ada',
      passwordHash: 'not-a-real-hash',
    }

    describe('users', () => {
      test('a created user comes back by id and by email', async () => {
        const created = await store.createUser(user)
        expect(created.id).toBe(user.id)
        expect(created.createdAt).toBeInstanceOf(Date)

        expect((await store.findUserById(user.id))?.email).toBe(user.email)
        expect((await store.findUserByEmail(user.email))?.id).toBe(user.id)
      })

      // People type their email however they like; the flows rely on this being handled here.
      test('email lookup is case-insensitive', async () => {
        await store.createUser(user)
        expect((await store.findUserByEmail('ADA@EXAMPLE.COM'))?.id).toBe(user.id)
        expect((await store.findUserByEmail('  Ada@Example.com  '.trim()))?.id).toBe(user.id)
      })

      test('a missing user is null, not an error', async () => {
        expect(await store.findUserById('nobody')).toBeNull()
        expect(await store.findUserByEmail('nobody@example.com')).toBeNull()
      })

      test('emailVerifiedAt defaults to null rather than undefined', async () => {
        const created = await store.createUser(user)
        expect(created.emailVerifiedAt).toBeNull()
        expect((await store.findUserById(user.id))?.emailVerifiedAt).toBeNull()
      })

      test('a password update is visible on the next read', async () => {
        await store.createUser(user)
        await store.updateUserPassword(user.id, 'a-new-hash')
        expect((await store.findUserById(user.id))?.passwordHash).toBe('a-new-hash')
      })
    })

    describe('refresh tokens', () => {
      const token = {
        id: 'refresh-1',
        userId: 'user-1',
        tokenHash: 'hash-1',
        expiresAt: new Date(Date.now() + 60_000),
      }

      beforeEach(async () => {
        await store.createUser(user)
      })

      test('a token is found by its hash', async () => {
        await store.createRefreshToken(token)
        const found = await store.findRefreshToken('hash-1')
        expect(found?.id).toBe('refresh-1')
        expect(found?.userId).toBe('user-1')
        expect(found?.expiresAt.getTime()).toBe(token.expiresAt.getTime())
      })

      test('an unknown hash is null', async () => {
        expect(await store.findRefreshToken('never-issued')).toBeNull()
      })

      test('deleting by id removes exactly one session', async () => {
        await store.createRefreshToken(token)
        await store.createRefreshToken({ ...token, id: 'refresh-2', tokenHash: 'hash-2' })

        await store.deleteRefreshTokens({ id: 'refresh-1' })

        expect(await store.findRefreshToken('hash-1')).toBeNull()
        expect(await store.findRefreshToken('hash-2')).not.toBeNull()
      })

      // What "sign out everywhere" and a password change both rely on.
      test('deleting by user removes every session they have', async () => {
        await store.createRefreshToken(token)
        await store.createRefreshToken({ ...token, id: 'refresh-2', tokenHash: 'hash-2' })

        await store.deleteRefreshTokens({ userId: 'user-1' })

        expect(await store.findRefreshToken('hash-1')).toBeNull()
        expect(await store.findRefreshToken('hash-2')).toBeNull()
      })

      /**
       * The one that matters. A store that treats an empty filter as "match everything" signs
       * out every user in the database the first time a caller forgets an argument.
       */
      test('deleting with no filter deletes nothing', async () => {
        await store.createRefreshToken(token)
        await store.deleteRefreshTokens({})
        expect(await store.findRefreshToken('hash-1')).not.toBeNull()
      })
    })

    describe('reset tokens', () => {
      const reset = {
        id: 'reset-1',
        userId: 'user-1',
        tokenHash: 'reset-hash',
        expiresAt: new Date(Date.now() + 60_000),
      }

      beforeEach(async () => {
        await store.createUser(user)
      })

      test('a token is found by its hash and starts unused', async () => {
        await store.createResetToken(reset)
        const found = await store.findResetToken('reset-hash')
        expect(found?.id).toBe('reset-1')
        expect(found?.usedAt).toBeNull()
      })

      // Single-use is enforced by the flow reading this field, so it has to actually persist.
      test('marking a token used persists', async () => {
        await store.createResetToken(reset)
        await store.markResetTokenUsed('reset-1')

        const found = await store.findResetToken('reset-hash')
        expect(found?.usedAt).toBeInstanceOf(Date)
      })

      test('an unknown hash is null', async () => {
        expect(await store.findResetToken('never-issued')).toBeNull()
      })
    })
  })

  /**
   * Linked accounts, for social sign-in.
   *
   * Skipped rather than failed for a store that does not implement them — they are optional on
   * the contract (D19), and a third-party store written before social sign-in existed is not
   * broken, it simply cannot do it.
   */
  describe(`AuthStore accounts: ${name}`, () => {
    let store: AuthStore
    let supported = false

    beforeEach(async () => {
      store = await makeStore()
      supported = supportsAccounts(store)
      if (supported) {
        await store.createUser({
          id: 'user-1',
          email: 'ada@example.com',
          name: 'Ada',
          passwordHash: 'not-a-real-hash',
        })
      }
    })

    const account = {
      id: 'account-1',
      userId: 'user-1',
      provider: 'google',
      providerAccountId: 'g-1',
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
    }

    test('a linked account comes back by provider and account id', async () => {
      if (!supported) return
      await store.linkAccount?.({ ...account })

      const found = await store.findAccount?.('google', 'g-1')
      expect(found).toMatchObject({ userId: 'user-1', provider: 'google' })
    })

    test('an unknown account is null, not an error', async () => {
      if (!supported) return
      expect(await store.findAccount?.('google', 'nobody')).toBeNull()
    })

    test('a different provider with the same account id is a different account', async () => {
      if (!supported) return
      await store.linkAccount?.({ ...account })

      expect(await store.findAccount?.('github', 'g-1')).toBeNull()
    })

    /**
     * The database is what prevents a double link, not the application. Two callbacks racing for
     * the same provider account must not both succeed and produce two rows pointing at different
     * users.
     */
    test('linking the same provider account twice is refused', async () => {
      if (!supported) return
      await store.linkAccount?.({ ...account })

      expect(
        store.linkAccount?.({ ...account, id: 'account-2', userId: 'user-2' }),
      ).rejects.toThrow()
    })

    test('a user’s accounts come back together', async () => {
      if (!supported) return
      await store.linkAccount?.({ ...account })
      await store.linkAccount?.({
        ...account,
        id: 'account-2',
        provider: 'github',
        providerAccountId: 'h-1',
      })

      const found = (await store.findAccountsByUser?.('user-1')) ?? []
      expect(found.map((entry) => entry.provider).sort()).toEqual(['github', 'google'])
    })

    test('unlinking removes exactly that provider', async () => {
      if (!supported) return
      await store.linkAccount?.({ ...account })
      await store.linkAccount?.({
        ...account,
        id: 'account-2',
        provider: 'github',
        providerAccountId: 'h-1',
      })

      await store.unlinkAccount?.('user-1', 'google')

      const found = (await store.findAccountsByUser?.('user-1')) ?? []
      expect(found.map((entry) => entry.provider)).toEqual(['github'])
    })

    test('unlinking something absent is not an error', async () => {
      if (!supported) return
      expect(store.unlinkAccount?.('user-1', 'google')).resolves.toBeUndefined()
    })
  })
}
