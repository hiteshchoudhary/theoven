import { afterEach, describe, expect, test } from 'bun:test'
import { createApp, silentLogger } from '@theoven/core'
import { cache } from './brick'
import { describeCacheDriver } from './conformance'
import { memoryCache } from './memory'
import { redisCache } from './redis'

describeCacheDriver('memory', () => memoryCache())

const REDIS_URL = process.env.REDIS_URL
if (REDIS_URL) {
  describeCacheDriver('redis', () =>
    redisCache({ url: REDIS_URL, prefix: `oven:test:${crypto.randomUUID()}` }),
  )
} else {
  console.info('[cache] REDIS_URL not set — Redis conformance tests skipped.')
}

const opened: Array<{ close(options?: { timeout?: number }): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 0 })))
})

function withCache(options = {}, development = true) {
  const app = createApp({ logger: silentLogger, development }).use(
    memoryCache && cache(memoryCache(), options),
  )
  opened.push(app)
  return app
}

describe('memory driver eviction', () => {
  test('the least recently used entry is evicted at the limit', async () => {
    const driver = memoryCache({ max: 2 })

    await driver.set('a', { value: 1 }, {})
    await driver.set('b', { value: 2 }, {})
    await driver.get('a') // touch a, so b is now the oldest
    await driver.set('c', { value: 3 }, {})

    expect((await driver.get('a'))?.value).toBe(1)
    expect(await driver.get('b')).toBeUndefined()
    expect((await driver.get('c'))?.value).toBe(3)
  })

  // An unbounded in-process cache is a memory leak with a friendly name.
  test('it never exceeds its limit', async () => {
    const driver = memoryCache({ max: 5 })
    for (let index = 0; index < 50; index++) await driver.set(`k${index}`, { value: index }, {})

    expect((driver.raw as Map<string, unknown>).size).toBeLessThanOrEqual(5)
  })
})

describe('the cache brick', () => {
  test('cached() computes once and serves from cache after', async () => {
    let calls = 0
    const app = withCache()
    app.get('/x', (ctx) => ctx.cache.cached('k', () => ++calls))
    await app.ready()

    const first = await (await app.fetch(new Request('https://x/x'))).json()
    const second = await (await app.fetch(new Request('https://x/x'))).json()

    expect(first).toBe(1)
    expect(second).toBe(1)
    expect(calls).toBe(1)
  })

  /**
   * The reason a cache can make an outage worse: a popular key expires and every in-flight
   * request recomputes it at once.
   */
  test('concurrent misses share one computation', async () => {
    let calls = 0
    const app = withCache()
    app.get('/x', (ctx) =>
      ctx.cache.cached('k', async () => {
        calls++
        await Bun.sleep(30)
        return { value: 'computed' }
      }),
    )
    await app.ready()

    const results = await Promise.all(
      Array.from({ length: 20 }, () => app.fetch(new Request('https://x/x'))),
    )

    expect(await Promise.all(results.map((r) => r.json()))).toEqual(
      Array(20).fill({ value: 'computed' }),
    )
    expect(calls).toBe(1)
  })

  // A rejected producer must not wedge the key for every later caller.
  test('a producer that throws does not poison the key', async () => {
    let attempt = 0
    const app = withCache()
    app.get('/x', (ctx) =>
      ctx.cache.cached('k', () => {
        if (++attempt === 1) throw new Error('first attempt fails')
        return { state: 'recovered' }
      }),
    )
    await app.ready()

    expect((await app.fetch(new Request('https://x/x'))).status).toBe(500)
    expect(await (await app.fetch(new Request('https://x/x'))).json()).toEqual({
      state: 'recovered',
    })
  })

  test('tags invalidate a group', async () => {
    const app = withCache()
    app.get('/a', (ctx) => ctx.cache.cached('a', () => Math.random(), { tags: ['user:1'] }))
    app.post('/bust', (ctx) => ({ removed: ctx.cache.invalidate('user:1') }))
    await app.ready()

    const first = await (await app.fetch(new Request('https://x/a'))).json()
    expect(await (await app.fetch(new Request('https://x/a'))).json()).toBe(first)

    await app.fetch(new Request('https://x/bust', { method: 'POST' }))
    expect(await (await app.fetch(new Request('https://x/a'))).json()).not.toBe(first)
  })

  test('a default ttl applies when a call does not give one', async () => {
    const app = withCache({ ttl: 40 })
    app.get('/x', (ctx) => ctx.cache.cached('k', () => Date.now()))
    await app.ready()

    const first = await (await app.fetch(new Request('https://x/x'))).json()
    await Bun.sleep(90)
    expect(await (await app.fetch(new Request('https://x/x'))).json()).not.toBe(first)
  })

  /**
   * Per-process caches disagree, so a user sees one value, refreshes, and sees another — a bug
   * that reproduces only under load.
   */
  test('the memory driver is refused in production', async () => {
    const app = createApp({ logger: silentLogger, development: false }).use(cache(memoryCache()))
    opened.push(app)
    expect(app.ready()).rejects.toThrow(/refused in production/)
  })

  test('it can be allowed deliberately', async () => {
    const app = createApp({ logger: silentLogger, development: false }).use(
      cache(memoryCache(), { allowMemoryInProduction: true }),
    )
    opened.push(app)
    await app.ready()
  })
})
