import { beforeEach, describe, expect, test } from 'bun:test'
import type { CacheDriver } from './types'

/**
 * The suite every `CacheDriver` must pass.
 *
 * Exported so memory and Redis run the *same* tests rather than each testing itself against its
 * own reading of the contract — the same reason `@theoven/auth/testing` and
 * `@theoven/queue/testing` exist.
 */
export function describeCacheDriver(
  name: string,
  makeDriver: () => CacheDriver | Promise<CacheDriver>,
): void {
  describe(`CacheDriver conformance: ${name}`, () => {
    let driver: CacheDriver

    beforeEach(async () => {
      driver = await makeDriver()
      await driver.start?.()
      await driver.clear()
    })

    test('a stored value comes back', async () => {
      await driver.set('k', { value: { a: 1 } }, {})
      expect((await driver.get('k'))?.value).toEqual({ a: 1 })
    })

    test('a missing key is undefined, not an error', async () => {
      expect(await driver.get('never-set')).toBeUndefined()
    })

    test('values survive serialisation intact', async () => {
      const value = { s: 'x', n: 1.5, b: true, nil: null, arr: [1, 2], nested: { deep: 'y' } }
      await driver.set('k', { value }, {})
      expect((await driver.get('k'))?.value).toEqual(value)
    })

    test('setting again replaces', async () => {
      await driver.set('k', { value: 'first' }, {})
      await driver.set('k', { value: 'second' }, {})
      expect((await driver.get('k'))?.value).toBe('second')
    })

    test('delete removes it', async () => {
      await driver.set('k', { value: 1 }, {})
      await driver.delete('k')
      expect(await driver.get('k')).toBeUndefined()
    })

    test('deleting something absent is not an error', async () => {
      await expect(driver.delete('never-set')).resolves.toBeUndefined()
    })

    test('an expired entry is gone', async () => {
      await driver.set('k', { value: 1, expiresAt: Date.now() + 40 }, { ttl: 40 })
      expect((await driver.get('k'))?.value).toBe(1)

      await Bun.sleep(90)
      expect(await driver.get('k')).toBeUndefined()
    })

    test('no ttl means it stays', async () => {
      await driver.set('k', { value: 1 }, {})
      await Bun.sleep(60)
      expect((await driver.get('k'))?.value).toBe(1)
    })

    /**
     * Tagging is what makes invalidation usable: you invalidate the *thing* that changed rather
     * than remembering every key derived from it.
     */
    describe('tags', () => {
      test('invalidating a tag removes everything carrying it', async () => {
        await driver.set('a', { value: 1 }, { tags: ['user:1'] })
        await driver.set('b', { value: 2 }, { tags: ['user:1'] })
        await driver.set('c', { value: 3 }, { tags: ['user:2'] })

        expect(await driver.invalidate('user:1')).toBe(2)
        expect(await driver.get('a')).toBeUndefined()
        expect(await driver.get('b')).toBeUndefined()
        // Another tag's entries are untouched.
        expect((await driver.get('c'))?.value).toBe(3)
      })

      test('an entry can carry several tags', async () => {
        await driver.set('a', { value: 1 }, { tags: ['x', 'y'] })

        expect(await driver.invalidate('y')).toBe(1)
        expect(await driver.get('a')).toBeUndefined()
      })

      test('invalidating an unknown tag is zero, not an error', async () => {
        expect(await driver.invalidate('never-used')).toBe(0)
      })

      // A key rewritten without tags must not still be reachable through the old ones.
      test('re-setting a key without tags detaches it', async () => {
        await driver.set('a', { value: 1 }, { tags: ['t'] })
        await driver.set('a', { value: 2 }, {})

        expect(await driver.invalidate('t')).toBe(0)
        expect((await driver.get('a'))?.value).toBe(2)
      })
    })

    test('clear empties everything', async () => {
      await driver.set('a', { value: 1 }, { tags: ['t'] })
      await driver.set('b', { value: 2 }, {})
      await driver.clear()

      expect(await driver.get('a')).toBeUndefined()
      expect(await driver.get('b')).toBeUndefined()
    })
  })
}
