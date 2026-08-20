import { describe, expect, test } from 'bun:test'
import { describeVectorStore } from '@theoven/vector/testing'
import { qdrantVector } from './qdrant'

/**
 * Against a **real Qdrant** when one is reachable.
 *
 * A double would prove the double works. The interesting question is whether a hosted service
 * with server-side collections, its own id rules and its own filter language fits the same
 * contract as scanning a SQLite table — and only the real thing answers that.
 */
const URL = Bun.env.QDRANT_TEST_URL

if (URL) {
  describeVectorStore('qdrant', () => qdrantVector({ url: URL, dimensions: 4 }))

  describe('qdrant specifics', () => {
    test('an arbitrary string id survives the uuid mapping', async () => {
      const store = qdrantVector({ url: URL, dimensions: 4 })
      const namespace = `ids-${Date.now()}`

      // Not a uuid, and Qdrant would refuse it as a point id — the mapping is what makes the
      // contract's promise of arbitrary string ids true here.
      await store.upsert(namespace, [{ id: 'handbook/page-7#para-2', embedding: [1, 0, 0, 0] }])

      const [match] = await store.query(namespace, [1, 0, 0, 0], { k: 1 })
      expect(match?.id).toBe('handbook/page-7#para-2')

      await store.clear(namespace)
    })

    test('re-upserting the same id replaces rather than duplicating', async () => {
      const store = qdrantVector({ url: URL, dimensions: 4 })
      const namespace = `dedupe-${Date.now()}`

      await store.upsert(namespace, [{ id: 'doc', embedding: [1, 0, 0, 0] }])
      await store.upsert(namespace, [{ id: 'doc', embedding: [0, 1, 0, 0] }])

      // Deterministic ids are what make this true; a random uuid per write would give 2.
      expect(await store.count(namespace)).toBe(1)
      await store.clear(namespace)
    })
  })
} else {
  console.log('[vector-qdrant] QDRANT_TEST_URL not set — Qdrant tests skipped.')
}
