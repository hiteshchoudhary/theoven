import { describe, expect, test } from 'bun:test'
import { createApp, silentLogger } from '@theoven/core'
import { vector } from './brick'
import { normalise } from './math'
import { sqliteVector } from './sqlite'
import { describeVectorStore } from './store-conformance'
import { VectorDimensionError } from './types'

describeVectorStore('sqlite (in memory)', () => sqliteVector({ url: ':memory:' }))

describe('normalisation', () => {
  test('scales to unit length', () => {
    const unit = normalise([3, 4])
    expect(Math.hypot(unit[0] as number, unit[1] as number)).toBeCloseTo(1, 6)
  })

  /** Dividing by zero would produce NaN and poison every later comparison silently. */
  test('a zero vector is returned unchanged rather than becoming NaN', () => {
    const zero = normalise([0, 0, 0])
    expect([...zero]).toEqual([0, 0, 0])
  })
})

describe('sqlite specifics', () => {
  test('mixing embedding sizes in one namespace is refused', async () => {
    const store = sqliteVector({ url: ':memory:' })
    await store.upsert('ns', [{ id: 'a', embedding: [1, 0, 0, 0] }])

    // Two models produce different dimensions, and silently storing both makes every later
    // query quietly wrong rather than loudly broken.
    expect(store.upsert('ns', [{ id: 'b', embedding: [1, 0] }])).rejects.toThrow(
      VectorDimensionError,
    )
    await store.close?.()
  })

  test('metadata survives a round trip with its types intact', async () => {
    const store = sqliteVector({ url: ':memory:' })
    await store.upsert('ns', [
      { id: 'a', embedding: [1, 0], metadata: { text: 'hi', page: 7, draft: true } },
    ])

    const [match] = await store.query('ns', [1, 0], { k: 1 })
    expect(match?.metadata).toEqual({ text: 'hi', page: 7, draft: true })
    await store.close?.()
  })

  test('vectors persist across connections to the same file', async () => {
    const path = `/tmp/oven-vec-${Date.now()}.db`
    const first = sqliteVector({ url: path })
    await first.upsert('ns', [{ id: 'a', embedding: [1, 0, 0, 0] }])
    await first.close?.()

    const second = sqliteVector({ url: path })
    expect(await second.count('ns')).toBe(1)
    await second.close?.()
  })
})

describe('the brick', () => {
  test('ctx.vector uses the default namespace', async () => {
    const app = createApp({ logger: silentLogger, development: true }).use(
      vector(sqliteVector({ url: ':memory:' })),
    )
    app.post('/index', async (ctx) => {
      await ctx.vector.upsert([{ id: 'a', embedding: [1, 0, 0, 0], metadata: { s: 'x' } }])
      return ctx.vector.query([1, 0, 0, 0], { k: 1 })
    })

    const response = await app.fetch(new Request('http://x/index', { method: 'POST' }))
    expect((await response.json()) as unknown[]).toMatchObject([{ id: 'a' }])
    await app.close({ timeout: 100 })
  })

  test('namespaces passed per call are honoured', async () => {
    const app = createApp({ logger: silentLogger, development: true }).use(
      vector(sqliteVector({ url: ':memory:' })),
    )
    await app.ready()
    const service = app.service('vector')

    await service.upsert([{ id: 'a', embedding: [1, 0] }], 'tenant-1')
    await service.upsert([{ id: 'b', embedding: [1, 0] }], 'tenant-2')

    expect(await service.count('tenant-1')).toBe(1)
    expect((await service.query([1, 0], { namespace: 'tenant-2' })).map((m) => m.id)).toEqual(['b'])
    await app.close({ timeout: 100 })
  })
})
