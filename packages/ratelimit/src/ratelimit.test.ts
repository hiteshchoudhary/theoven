import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { type App, createApp, silentLogger } from '@theoven/core'
import { memoryStore } from './memory'
import { rateLimit } from './middleware'
import { redisStore } from './redis'
import type { RateLimitStore } from './types'

const opened: App[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 100 })))
})

function make(store: RateLimitStore, limit: number, window = 60_000): App {
  const app = createApp({ logger: silentLogger, development: true })
  opened.push(app)
  app.use(rateLimit({ limit, window, store, key: () => 'everyone' }))
  app.get('/x', () => 'ok')
  return app
}

const get = (app: App) => app.fetch(new Request('https://app.test/x'))

/**
 * The behaviours every store owes, run against each one.
 *
 * The same shape as `describeAuthStore` — two implementations answering to one suite is what
 * makes the contract a contract rather than a description of whichever was written first.
 */
function describeStore(name: string, makeStore: () => RateLimitStore | Promise<RateLimitStore>) {
  describe(`RateLimitStore: ${name}`, () => {
    let store: RateLimitStore

    beforeEach(async () => {
      store = await makeStore()
    })

    afterEach(async () => {
      await store.close?.()
    })

    test('counts up', async () => {
      const key = `count-${Math.random()}`
      expect((await store.hit(key, 60_000, Date.now())).count).toBe(1)
      expect((await store.hit(key, 60_000, Date.now())).count).toBe(2)
      expect((await store.hit(key, 60_000, Date.now())).count).toBe(3)
    })

    test('separate keys do not share a budget', async () => {
      const now = Date.now()
      const a = `a-${Math.random()}`
      const b = `b-${Math.random()}`

      await store.hit(a, 60_000, now)
      await store.hit(a, 60_000, now)

      expect((await store.hit(b, 60_000, now)).count).toBe(1)
    })

    test('a later window starts fresh', async () => {
      const key = `window-${Math.random()}`
      const now = Date.now()

      await store.hit(key, 1000, now)
      await store.hit(key, 1000, now)

      // Two windows on, so nothing from the first is still weighted in.
      const later = await store.hit(key, 1000, now + 2000)
      expect(later.count).toBe(1)
    })

    /**
     * The reason this package exists.
     *
     * Twenty requests arriving together must produce twenty distinct counts. A store that reads
     * and then writes loses some of them, and a limit of 20 admits far more — silently, and only
     * under the load it was meant to protect against.
     */
    test('concurrent hits are not lost', async () => {
      const key = `race-${Math.random()}`
      const now = Date.now()

      const results = await Promise.all(
        Array.from({ length: 20 }, () => store.hit(key, 60_000, now)),
      )

      const counts = results.map((result) => result.count).sort((a, b) => a - b)
      expect(counts).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
    })

    test('the reset is inside the window', async () => {
      const result = await store.hit(`reset-${Math.random()}`, 60_000, Date.now())
      expect(result.resetMs).toBeGreaterThan(0)
      expect(result.resetMs).toBeLessThanOrEqual(60_000)
    })

    /**
     * A fixed window lets someone spend the whole allowance at the end of one window and again at
     * the start of the next — 2x the limit across the boundary. The sliding weight is what stops
     * that, so it gets a test rather than a comment.
     */
    test('the previous window still counts, weighted', async () => {
      const key = `slide-${Math.random()}`
      const window = 10_000
      const start = Math.floor(Date.now() / window) * window

      // Five requests late in one window.
      for (let index = 0; index < 5; index++) await store.hit(key, window, start + 9000)

      // One request just into the next: the five have barely decayed, so it must not read as 1.
      const next = await store.hit(key, window, start + window + 500)
      expect(next.count).toBeGreaterThan(1)
      expect(next.count).toBeLessThanOrEqual(6)
    })
  })
}

describeStore('memory', () => memoryStore())

// Redis is the point of the package, so it is tested against a real server when one is reachable.
const REDIS = Bun.env.REDIS_TEST_URL
if (REDIS) {
  describeStore('redis', () => redisStore({ url: REDIS, prefix: `test:${Date.now()}` }))
} else {
  console.log('[ratelimit] REDIS_TEST_URL not set — Redis store tests skipped.')
}

describe('the middleware', () => {
  test('allows up to the limit and refuses past it', async () => {
    const app = make(memoryStore(), 3)

    expect((await get(app)).status).toBe(200)
    expect((await get(app)).status).toBe(200)
    expect((await get(app)).status).toBe(200)
    expect((await get(app)).status).toBe(429)
  })

  test('sets the standard headers', async () => {
    const app = make(memoryStore(), 5)
    const response = await get(app)

    expect(response.headers.get('ratelimit-limit')).toBe('5')
    expect(response.headers.get('ratelimit-remaining')).toBe('4')
    expect(Number(response.headers.get('ratelimit-reset'))).toBeGreaterThan(0)
  })

  test('a refusal carries Retry-After', async () => {
    const app = make(memoryStore(), 1)
    await get(app)
    const refused = await get(app)

    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  test('remaining does not go negative', async () => {
    const app = make(memoryStore(), 1)
    await get(app)
    await get(app)
    const third = await get(app)

    expect(third.headers.get('ratelimit-remaining')).toBe('0')
  })

  test('skip bypasses counting entirely', async () => {
    const app = createApp({ logger: silentLogger, development: true })
    opened.push(app)
    app.use(rateLimit({ limit: 1, store: memoryStore(), key: () => 'k', skip: () => true }))
    app.get('/x', () => 'ok')

    for (let index = 0; index < 5; index++) expect((await get(app)).status).toBe(200)
  })

  /** No key means no way to attribute a request; one shared bucket would limit the whole world. */
  test('an undefined key is not limited', async () => {
    const app = createApp({ logger: silentLogger, development: true })
    opened.push(app)
    app.use(rateLimit({ limit: 1, store: memoryStore(), key: () => undefined }))
    app.get('/x', () => 'ok')

    expect((await get(app)).status).toBe(200)
    expect((await get(app)).status).toBe(200)
  })

  test('different keys have separate budgets', async () => {
    const app = createApp({ logger: silentLogger, development: true })
    opened.push(app)
    let who = 'ada'
    app.use(rateLimit({ limit: 1, store: memoryStore(), key: () => who }))
    app.get('/x', () => 'ok')

    expect((await get(app)).status).toBe(200)
    expect((await get(app)).status).toBe(429)

    who = 'grace'
    expect((await get(app)).status).toBe(200)
  })
})

describe('when the store is unreachable', () => {
  const broken: RateLimitStore = {
    name: 'broken',
    hit: () => Promise.reject(new Error('connection refused')),
  }

  /** A Redis outage should not take the application down with it. */
  test('fails open by default', async () => {
    const app = make(broken, 1)
    expect((await get(app)).status).toBe(200)
  })

  /** But for an endpoint that exists to stop abuse, failing open means the abuse succeeds. */
  test('fails closed when asked', async () => {
    const app = createApp({ logger: silentLogger, development: true })
    opened.push(app)
    app.use(rateLimit({ limit: 1, store: broken, key: () => 'k', onStoreError: 'deny' }))
    app.get('/x', () => 'ok')

    expect((await get(app)).status).toBe(429)
  })
})
