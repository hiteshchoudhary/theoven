import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { VectorStore } from './types'

/**
 * The behaviours every vector store owes.
 *
 * ```ts
 * describeVectorStore('sqlite', () => sqliteVector({ url: ':memory:' }))
 * ```
 *
 * The same shape as `describeAuthStore`. A contract is only real when structurally different
 * implementations answer to one suite — an in-process scan, pgvector and a hosted HTTP service
 * are about as different as three implementations get, and that is the point.
 */
export function describeVectorStore(
  name: string,
  makeStore: () => VectorStore | Promise<VectorStore>,
): void {
  describe(`VectorStore conformance: ${name}`, () => {
    let store: VectorStore
    let namespace: string

    beforeEach(async () => {
      store = await makeStore()
      // A fresh namespace per test, because a shared server keeps whatever the last run left.
      namespace = `test-${Math.random().toString(36).slice(2)}`
    })

    /**
     * Closed after every test, and the namespace cleaned up.
     *
     * Without this the suite leaks a connection per test: a store that opens a pool lazily never
     * gets told to release it, and Postgres refuses the run partway through with "sorry, too many
     * clients already". A server-backed store is exactly where that bites and an in-process one
     * never shows it, which is why it survived until the second adapter.
     */
    afterEach(async () => {
      await store.clear(namespace).catch(() => {})
      await store.close?.()
    })

    /** Unit vectors along axes: orthogonal, so the expected ranking is unambiguous. */
    const records = [
      { id: 'x', embedding: [1, 0, 0, 0], metadata: { kind: 'axis', index: 1 } },
      { id: 'y', embedding: [0, 1, 0, 0], metadata: { kind: 'axis', index: 2 } },
      { id: 'z', embedding: [0, 0, 1, 0], metadata: { kind: 'other', index: 3 } },
    ]

    describe('writing and reading', () => {
      test('an upserted vector is findable', async () => {
        await store.upsert(namespace, records)

        const matches = await store.query(namespace, [1, 0, 0, 0], { k: 1 })
        expect(matches[0]?.id).toBe('x')
      })

      test('an empty namespace returns nothing rather than failing', async () => {
        expect(await store.query(namespace, [1, 0, 0, 0])).toEqual([])
      })

      test('count reflects what was written', async () => {
        expect(await store.count(namespace)).toBe(0)
        await store.upsert(namespace, records)
        expect(await store.count(namespace)).toBe(3)
      })

      test('upserting the same id replaces rather than duplicating', async () => {
        await store.upsert(namespace, [{ id: 'a', embedding: [1, 0, 0, 0] }])
        await store.upsert(namespace, [{ id: 'a', embedding: [0, 1, 0, 0] }])

        expect(await store.count(namespace)).toBe(1)
        // The replacement is what is found, not the original.
        const matches = await store.query(namespace, [0, 1, 0, 0], { k: 1 })
        expect(matches[0]?.id).toBe('a')
        expect(matches[0]?.score).toBeGreaterThan(0.99)
      })

      test('an empty batch is not an error', async () => {
        expect(store.upsert(namespace, [])).resolves.toBeUndefined()
      })
    })

    describe('ranking', () => {
      /**
       * The property the whole contract turns on. Engines disagree about whether their number is
       * a distance or a similarity, so an adapter that forwards it untouched makes `score` mean
       * opposite things depending on which one is registered.
       */
      test('higher score is more similar, on every engine', async () => {
        await store.upsert(namespace, records)

        const matches = await store.query(namespace, [1, 0, 0, 0], { k: 3 })

        expect(matches[0]?.id).toBe('x')
        expect(matches[0]?.score).toBeGreaterThan(matches[1]?.score ?? 1)
        expect(matches[1]?.score).toBeGreaterThanOrEqual(matches[2]?.score ?? 1)
      })

      test('an identical vector scores about 1', async () => {
        await store.upsert(namespace, records)

        const [best] = await store.query(namespace, [1, 0, 0, 0], { k: 1 })
        expect(best?.score).toBeGreaterThan(0.99)
      })

      test('an orthogonal vector scores about 0', async () => {
        await store.upsert(namespace, [{ id: 'x', embedding: [1, 0, 0, 0] }])

        const [only] = await store.query(namespace, [0, 1, 0, 0], { k: 1 })
        expect(Math.abs(only?.score ?? 1)).toBeLessThan(0.01)
      })

      test('magnitude does not change the ranking, only direction does', async () => {
        await store.upsert(namespace, [
          { id: 'near', embedding: [1, 0.1, 0, 0] },
          { id: 'far', embedding: [0, 1, 0, 0] },
        ])

        // A query 100x longer than the stored vectors must rank them identically.
        const matches = await store.query(namespace, [100, 0, 0, 0], { k: 2 })
        expect(matches[0]?.id).toBe('near')
      })

      test('k limits the results', async () => {
        await store.upsert(namespace, records)
        expect(await store.query(namespace, [1, 0, 0, 0], { k: 2 })).toHaveLength(2)
      })

      test('minScore drops weak matches', async () => {
        await store.upsert(namespace, records)

        const matches = await store.query(namespace, [1, 0, 0, 0], { k: 10, minScore: 0.5 })
        expect(matches).toHaveLength(1)
        expect(matches[0]?.id).toBe('x')
      })
    })

    describe('metadata', () => {
      test('comes back with the match', async () => {
        await store.upsert(namespace, records)

        const [best] = await store.query(namespace, [1, 0, 0, 0], { k: 1 })
        expect(best?.metadata).toMatchObject({ kind: 'axis', index: 1 })
      })

      test('an equality filter narrows the search', async () => {
        await store.upsert(namespace, records)

        const matches = await store.query(namespace, [1, 0, 0, 0], {
          k: 10,
          filter: { kind: 'other' },
        })
        expect(matches.map((match) => match.id)).toEqual(['z'])
      })

      test('a filter matching nothing returns nothing', async () => {
        await store.upsert(namespace, records)
        expect(await store.query(namespace, [1, 0, 0, 0], { filter: { kind: 'absent' } })).toEqual(
          [],
        )
      })

      test('a numeric filter matches on value, not string', async () => {
        await store.upsert(namespace, records)

        const matches = await store.query(namespace, [0, 1, 0, 0], { k: 10, filter: { index: 2 } })
        expect(matches.map((match) => match.id)).toEqual(['y'])
      })
    })

    describe('removing', () => {
      test('a removed vector is gone', async () => {
        await store.upsert(namespace, records)
        await store.remove(namespace, ['x'])

        expect(await store.count(namespace)).toBe(2)
        expect(
          (await store.query(namespace, [1, 0, 0, 0], { k: 3 })).map((m) => m.id),
        ).not.toContain('x')
      })

      test('removing something absent is not an error', async () => {
        expect(store.remove(namespace, ['nobody'])).resolves.toBeUndefined()
      })

      test('clear empties the namespace', async () => {
        await store.upsert(namespace, records)
        await store.clear(namespace)
        expect(await store.count(namespace)).toBe(0)
      })
    })

    describe('namespaces', () => {
      test('are isolated from each other', async () => {
        const other = `${namespace}-other`
        await store.upsert(namespace, [{ id: 'a', embedding: [1, 0, 0, 0] }])
        await store.upsert(other, [{ id: 'b', embedding: [1, 0, 0, 0] }])

        expect((await store.query(namespace, [1, 0, 0, 0])).map((m) => m.id)).toEqual(['a'])
        expect((await store.query(other, [1, 0, 0, 0])).map((m) => m.id)).toEqual(['b'])

        await store.clear(other)
      })

      test('clearing one does not touch another', async () => {
        const other = `${namespace}-other`
        await store.upsert(namespace, [{ id: 'a', embedding: [1, 0, 0, 0] }])
        await store.upsert(other, [{ id: 'b', embedding: [1, 0, 0, 0] }])

        await store.clear(other)

        expect(await store.count(namespace)).toBe(1)
      })
    })
  })
}
