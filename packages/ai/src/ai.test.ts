import { describe, expect, test } from 'bun:test'
import { createApp } from '@theoven/core'
import { MockEmbeddingModelV4, MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { ai } from './brick'
import { cacheKey, UNCACHEABLE } from './key'
import type { AiCache } from './types'
import { computeCost, normaliseUsage } from './usage'

/**
 * JSON with property access. `Response.json()` is typed `unknown`, which strict mode rejects on
 * every `body.usage.inputTokens` below.
 */
// biome-ignore lint/suspicious/noExplicitAny: a decoded test body is arbitrary JSON
type Json = Record<string, any>

const readJson = async (response: Response): Promise<Json> => (await response.json()) as Json

/**
 * Usage in the shape the **provider spec** requires, which is not the shape the `ai` facade
 * hands back. The spec nests (`inputTokens: { total }`); the facade flattens
 * (`inputTokens: number`). A fixture built in the flat shape is silently discarded by the
 * mapper — no error, just zero tokens everywhere — so these helpers exist to stop this file
 * from testing against a fiction.
 */
const specUsage = (input: number, output: number, cacheRead = 0) => ({
  inputTokens: { total: input, noCache: input - cacheRead, cacheRead, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
  totalTokens: input + output,
})

const stop = { unified: 'stop' as const, raw: 'stop' }

function textModel(
  text: string,
  options: { input?: number; output?: number; onCall?: () => void } = {},
) {
  return new MockLanguageModelV4({
    modelId: 'test-model',
    doGenerate: async () => {
      options.onCall?.()
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: stop,
        usage: specUsage(options.input ?? 10, options.output ?? 5),
        warnings: [],
      }
    },
  })
}

function streamingModel(chunks: string[], options: { onCall?: () => void } = {}) {
  return new MockLanguageModelV4({
    modelId: 'test-model',
    doStream: async () => {
      options.onCall?.()
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start' as const, id: '0' },
            ...chunks.map((delta) => ({ type: 'text-delta' as const, id: '0', delta })),
            { type: 'text-end' as const, id: '0' },
            { type: 'finish' as const, finishReason: stop, usage: specUsage(10, 5) },
          ],
        }),
      }
    },
  })
}

/** A cache with the two methods the brick asks for, plus counters the tests assert on. */
function fakeCache() {
  const entries = new Map<string, unknown>()
  let writes = 0
  return {
    entries,
    get writes() {
      return writes
    },
    store: {
      async get<Value>(key: string) {
        return entries.get(key) as Value | undefined
      },
      async set<Value>(key: string, value: Value) {
        writes += 1
        entries.set(key, value)
      },
    } satisfies AiCache,
  }
}

describe('usage normalisation', () => {
  test('reads the AI SDK v7 nested details shape', () => {
    const usage = normaliseUsage({
      inputTokens: 100,
      inputTokenDetails: { noCacheTokens: 80, cacheReadTokens: 20, cacheWriteTokens: 0 },
      outputTokens: 50,
      outputTokenDetails: { textTokens: 40, reasoningTokens: 10 },
      totalTokens: 150,
    })
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedInputTokens: 20,
      reasoningTokens: 10,
    })
  })

  test('reads the flat v5 shape, so the peer range does not silently lose counts', () => {
    const usage = normaliseUsage({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedInputTokens: 20,
      reasoningTokens: 10,
    })
    expect(usage.cachedInputTokens).toBe(20)
    expect(usage.reasoningTokens).toBe(10)
  })

  test('a provider reporting nothing yields undefined, never zero', () => {
    const usage = normaliseUsage({})
    expect(usage.inputTokens).toBeUndefined()
    expect(usage.totalTokens).toBeUndefined()
    // The distinction that matters: a zero here would read as a free call and price at $0.00.
    expect(usage.inputTokens).not.toBe(0)
  })

  test('derives a total only when both halves are known', () => {
    expect(normaliseUsage({ inputTokens: 10, outputTokens: 5 }).totalTokens).toBe(15)
    expect(normaliseUsage({ inputTokens: 10 }).totalTokens).toBeUndefined()
  })
})

describe('cost', () => {
  const pricing = { input: 1, output: 2 }

  test('prices per million tokens', () => {
    const usage = normaliseUsage({ inputTokens: 1_000_000, outputTokens: 500_000 })
    expect(computeCost(usage, pricing)).toBe(1 + 1)
  })

  test('is undefined without pricing rather than zero', () => {
    expect(computeCost(normaliseUsage({ inputTokens: 100 }), undefined)).toBeUndefined()
  })

  test('is undefined when the provider reported no tokens', () => {
    expect(computeCost(normaliseUsage({}), pricing)).toBeUndefined()
  })

  test('bills provider-cached input at its own rate', () => {
    const usage = normaliseUsage({
      inputTokens: 1_000_000,
      inputTokenDetails: { cacheReadTokens: 900_000 },
      outputTokens: 0,
    })
    // 100k uncached at $1/M plus 900k cached at $0.10/M.
    expect(computeCost(usage, { input: 1, output: 2, cachedInput: 0.1 })).toBeCloseTo(
      0.1 + 0.09,
      10,
    )
    // Without a cached rate the whole input bills at the full rate — an order of magnitude more.
    expect(computeCost(usage, pricing)).toBe(1)
  })

  test('never charges negative when cache reads exceed reported input', () => {
    const usage = normaliseUsage({
      inputTokens: 10,
      inputTokenDetails: { cacheReadTokens: 999 },
      outputTokens: 0,
    })
    expect(computeCost(usage, { input: 1, output: 2, cachedInput: 0 })).toBeGreaterThanOrEqual(0)
  })
})

describe('cache keys', () => {
  test('do not depend on the order the options were written in', () => {
    const a = cacheKey('generate', 'm', { prompt: 'hi', system: 'be brief' })
    const b = cacheKey('generate', 'm', { system: 'be brief', prompt: 'hi' })
    expect(a).toBe(b)
  })

  test('differ for different prompts, models and operations', () => {
    const base = cacheKey('generate', 'm', { prompt: 'hi' })
    expect(cacheKey('generate', 'm', { prompt: 'bye' })).not.toBe(base)
    expect(cacheKey('generate', 'other', { prompt: 'hi' })).not.toBe(base)
    expect(cacheKey('stream', 'm', { prompt: 'hi' })).not.toBe(base)
  })

  test('ignore options that cannot change the answer', () => {
    const plain = cacheKey('generate', 'm', { prompt: 'hi' })
    const withSignal = cacheKey('generate', 'm', {
      prompt: 'hi',
      abortSignal: AbortSignal.timeout(1000),
      headers: { 'x-request-id': 'abc' },
      maxRetries: 3,
    })
    expect(withSignal).toBe(plain)
  })

  test('refuse to key a call carrying a function', () => {
    const key = cacheKey('generate', 'm', {
      prompt: 'hi',
      tools: { search: { execute: () => 'result' } },
    })
    // Two tool sets differing only in what `execute` does would otherwise share a key, and one
    // caller would be served the other's answer.
    expect(key).toBe(UNCACHEABLE)
  })

  test('refuse to key binary content', () => {
    expect(cacheKey('generate', 'm', { prompt: new Uint8Array([1, 2, 3]) })).toBe(UNCACHEABLE)
  })
})

describe('generate', () => {
  test('returns text with usage and cost', async () => {
    const app = createApp().use(
      ai({ model: textModel('hello'), pricing: { 'test-model': { input: 1, output: 2 } } }),
    )
    app.get('/', async (ctx) => {
      const result = await ctx.ai.generate({ prompt: 'hi' })
      return { text: result.text, usage: result.usage, cost: result.cost, cached: result.cached }
    })

    const body = await readJson(await app.fetch(new Request('http://localhost/')))
    expect(body.text).toBe('hello')
    expect(body.usage.inputTokens).toBe(10)
    expect(body.usage.outputTokens).toBe(5)
    expect(body.cost).toBeCloseTo(10 / 1e6 + (5 * 2) / 1e6, 12)
    expect(body.cached).toBe(false)
  })

  test('a second identical call is served from the cache without a provider call', async () => {
    let calls = 0
    const cache = fakeCache()
    const app = createApp().use(
      ai({
        model: textModel('hello', { onCall: () => (calls += 1) }),
        cache: { store: cache.store },
      }),
    )
    app.get('/', async (ctx) => {
      const first = await ctx.ai.generate({ prompt: 'same' })
      const second = await ctx.ai.generate({ prompt: 'same' })
      return { calls, firstCached: first.cached, secondCached: second.cached, text: second.text }
    })

    const body = await readJson(await app.fetch(new Request('http://localhost/')))
    expect(body.calls).toBe(1)
    expect(body.firstCached).toBe(false)
    expect(body.secondCached).toBe(true)
    expect(body.text).toBe('hello')
  })

  test('cache: false reaches the provider every time', async () => {
    let calls = 0
    const cache = fakeCache()
    const app = createApp().use(
      ai({
        model: textModel('hello', { onCall: () => (calls += 1) }),
        cache: { store: cache.store },
      }),
    )
    app.get('/', async (ctx) => {
      await ctx.ai.generate({ prompt: 'same', cache: false })
      await ctx.ai.generate({ prompt: 'same', cache: false })
      return { calls }
    })

    expect((await readJson(await app.fetch(new Request('http://localhost/')))).calls).toBe(2)
  })

  test('a tool-carrying call is never cached', async () => {
    let writes = 0
    const cache = fakeCache()
    const app = createApp().use(ai({ model: textModel('hi'), cache: { store: cache.store } }))
    app.get('/', async (ctx) => {
      await ctx.ai.generate({
        prompt: 'hi',
        tools: { now: { execute: () => Date.now() } } as never,
      })
      writes = cache.writes
      return { writes }
    })

    await app.fetch(new Request('http://localhost/'))
    expect(writes).toBe(0)
  })

  test('concurrent identical calls share one provider call', async () => {
    let calls = 0
    const cache = fakeCache()
    const app = createApp().use(
      ai({
        model: new MockLanguageModelV4({
          modelId: 'test-model',
          doGenerate: async () => {
            calls += 1
            await Bun.sleep(20)
            return {
              content: [{ type: 'text' as const, text: 'shared' }],
              finishReason: stop,
              usage: specUsage(10, 5),
              warnings: [],
            }
          },
        }),
        cache: { store: cache.store },
      }),
    )
    app.get('/', async (ctx) => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => ctx.ai.generate({ prompt: 'stampede' })),
      )
      return { calls, texts: [...new Set(results.map((r) => r.text))] }
    })

    const body = await readJson(await app.fetch(new Request('http://localhost/')))
    // Without in-flight deduplication all ten miss the cold cache and all ten bill.
    expect(body.calls).toBe(1)
    expect(body.texts).toEqual(['shared'])
  })

  test('the raw SDK result is present on a live call and absent on a cache hit', async () => {
    const cache = fakeCache()
    const app = createApp().use(ai({ model: textModel('hello'), cache: { store: cache.store } }))
    app.get('/', async (ctx) => {
      const live = await ctx.ai.generate({ prompt: 'p' })
      const hit = await ctx.ai.generate({ prompt: 'p' })
      return { liveHasRaw: live.raw !== undefined, hitHasRaw: hit.raw !== undefined }
    })

    const body = await readJson(await app.fetch(new Request('http://localhost/')))
    expect(body.liveHasRaw).toBe(true)
    expect(body.hitHasRaw).toBe(false)
  })
})

describe('cache wiring', () => {
  /** Stands in for `@theoven/cache`, which is a sibling and so is never imported here. */
  const cacheBrick = (store: AiCache) => ({ name: 'cache' as const, setup: () => store })

  test('picks up a registered cache brick without being handed a store', async () => {
    let calls = 0
    const cache = fakeCache()
    const app = createApp()
      .use(cacheBrick(cache.store))
      .use(
        ai({ model: textModel('hello', { onCall: () => (calls += 1) }), cache: { ttl: 60_000 } }),
      )

    app.get('/', async (ctx) => {
      await ctx.ai.generate({ prompt: 'p' })
      const second = await ctx.ai.generate({ prompt: 'p' })
      return { calls, cached: second.cached }
    })

    const body = await readJson(await app.fetch(new Request('http://localhost/')))
    expect(body.calls).toBe(1)
    expect(body.cached).toBe(true)
  })

  test('requesting a cache with none available fails at boot, not at request time', async () => {
    const app = createApp().use(ai({ model: textModel('hello'), cache: true }))
    // The failure names the fix. Discovering this from a bill instead would be the bad outcome.
    expect(app.ready()).rejects.toThrow(/no cache is available/i)
  })

  test('no cache configured means every call reaches the provider', async () => {
    let calls = 0
    const app = createApp().use(ai({ model: textModel('hello', { onCall: () => (calls += 1) }) }))
    app.get('/', async (ctx) => {
      await ctx.ai.generate({ prompt: 'p' })
      await ctx.ai.generate({ prompt: 'p' })
      return { calls }
    })

    expect((await readJson(await app.fetch(new Request('http://localhost/')))).calls).toBe(2)
  })
})

describe('per-request scope', () => {
  test('usage totals do not leak between requests', async () => {
    const app = createApp().use(ai({ model: textModel('hello') }))
    app.get('/', async (ctx) => {
      await ctx.ai.generate({ prompt: 'hi', cache: false })
      return ctx.ai.usage
    })

    const first = await readJson(await app.fetch(new Request('http://localhost/')))
    const second = await readJson(await app.fetch(new Request('http://localhost/')))
    expect(first.totalTokens).toBe(15)
    // The bug this guards: a shared accumulator would report 30 on the second request.
    expect(second.totalTokens).toBe(15)
    expect(second.calls).toBe(1)
  })

  test('a cache hit adds no tokens and no cost, because none were billed', async () => {
    const cache = fakeCache()
    const app = createApp().use(
      ai({
        model: textModel('hello'),
        cache: { store: cache.store },
        pricing: { 'test-model': { input: 1, output: 2 } },
      }),
    )
    app.get('/', async (ctx) => {
      const live = await ctx.ai.generate({ prompt: 'p' })
      const hit = await ctx.ai.generate({ prompt: 'p' })
      return { liveCost: live.cost, hitCost: hit.cost, usage: ctx.ai.usage }
    })

    const body = await readJson(await app.fetch(new Request('http://localhost/')))
    expect(body.liveCost).toBeCloseTo(10 / 1e6 + 10 / 1e6, 12)
    // Free, not unknown: `undefined` would mean "cannot be determined".
    expect(body.hitCost).toBe(0)
    // Two answers, one purchase.
    expect(body.usage.totalTokens).toBe(15)
    expect(body.usage.cost).toBeCloseTo(10 / 1e6 + 10 / 1e6, 12)
    expect(body.usage.calls).toBe(2)
    expect(body.usage.cachedCalls).toBe(1)
  })

  test('a budget is not burned by calls served from cache', async () => {
    const cache = fakeCache()
    const app = createApp().use(
      ai({ model: textModel('hello'), cache: { store: cache.store }, budget: { tokens: 20 } }),
    )
    app.get('/', async (ctx) => {
      // One purchase at 15 tokens, then three free replays. Counting the replays would trip the
      // 20-token budget on spend that never happened.
      for (let index = 0; index < 4; index += 1) await ctx.ai.generate({ prompt: 'same' })
      return ctx.ai.usage
    })

    const response = await app.fetch(new Request('http://localhost/'))
    expect(response.status).toBe(200)
    const usage = await readJson(response)
    expect(usage.calls).toBe(4)
    expect(usage.totalTokens).toBe(15)
  })

  test('counts cache hits separately from provider calls', async () => {
    const cache = fakeCache()
    const app = createApp().use(ai({ model: textModel('hello'), cache: { store: cache.store } }))
    app.get('/', async (ctx) => {
      await ctx.ai.generate({ prompt: 'x' })
      await ctx.ai.generate({ prompt: 'x' })
      return ctx.ai.usage
    })

    const usage = await readJson(await app.fetch(new Request('http://localhost/')))
    expect(usage.calls).toBe(2)
    expect(usage.cachedCalls).toBe(1)
  })
})

describe('budget', () => {
  test('refuses further calls once the request has spent its allowance', async () => {
    const app = createApp().use(ai({ model: textModel('hello'), budget: { tokens: 20 } }))
    app.get('/', async (ctx) => {
      await ctx.ai.generate({ prompt: '1', cache: false })
      await ctx.ai.generate({ prompt: '2', cache: false })
      // 30 tokens spent, over the 20 allowed, so this third call must not happen.
      await ctx.ai.generate({ prompt: '3', cache: false })
      return { reached: true }
    })

    const response = await app.fetch(new Request('http://localhost/'))
    expect(response.status).toBe(429)
    const problem = await readJson(response)
    expect(problem.title).toBe('Token budget exceeded')
    expect(problem.spent).toBe(30)
    expect(problem.budget).toBe(20)
  })

  test('a fresh request starts with the full budget', async () => {
    const app = createApp().use(ai({ model: textModel('hello'), budget: { tokens: 20 } }))
    app.get('/', async (ctx) => {
      await ctx.ai.generate({ prompt: 'once', cache: false })
      return { ok: true }
    })

    expect((await app.fetch(new Request('http://localhost/'))).status).toBe(200)
    expect((await app.fetch(new Request('http://localhost/'))).status).toBe(200)
  })

  test('scope() gives work with no request behind it its own ceiling', async () => {
    const app = createApp().use(ai({ model: textModel('hello') }))
    await app.ready()
    const worker = app.service('ai').scope({ budget: 20 })

    await worker.generate({ prompt: '1', cache: false })
    await worker.generate({ prompt: '2', cache: false })
    expect(worker.generate({ prompt: '3', cache: false })).rejects.toThrow(/budget/i)

    // The app-level service is a different scope and is unaffected.
    expect(app.service('ai').usage.calls).toBe(0)
  })
})

describe('streaming', () => {
  test('emits delta events and a final done carrying usage', async () => {
    const app = createApp().use(
      ai({
        model: streamingModel(['Hel', 'lo ', 'world']),
        pricing: { 'test-model': { input: 1, output: 2 } },
      }),
    )
    app.get('/', (ctx) => ctx.ai.stream({ prompt: 'hi' }))

    const response = await app.fetch(new Request('http://localhost/'))
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const body = await response.text()

    expect(body).toContain('event: delta')
    expect(body).toContain('"text":"Hel"')

    const done = body.split('event: done')[1]
    expect(done).toBeDefined()
    const payload = JSON.parse((done as string).split('data: ')[1]?.split('\n')[0] as string)
    expect(payload.text).toBe('Hello world')
    expect(payload.usage.inputTokens).toBe(10)
    expect(payload.cost).toBeCloseTo(10 / 1e6 + 10 / 1e6, 12)
    expect(payload.cached).toBe(false)
  })

  test('a budget failure is a 429 problem document, not a 200 carrying an error event', async () => {
    const app = createApp().use(ai({ model: streamingModel(['hi']), budget: { tokens: 1 } }))
    app.get('/', (ctx) => {
      // Spend the allowance without needing a non-streaming model behind it.
      ctx.ai.record({ inputTokens: 5, outputTokens: 5, totalTokens: 10 }, 'generate', 'test-model')
      return ctx.ai.stream({ prompt: 'hi' })
    })

    const response = await app.fetch(new Request('http://localhost/'))
    // Raising this inside the SSE producer would have committed a 200 before anyone noticed.
    expect(response.status).toBe(429)
    expect(response.headers.get('content-type')).toContain('problem+json')
  })

  test('a cached answer replays without touching the provider', async () => {
    let calls = 0
    const cache = fakeCache()
    const app = createApp().use(
      ai({
        model: streamingModel(['ca', 'ched'], { onCall: () => (calls += 1) }),
        cache: { store: cache.store },
      }),
    )
    app.get('/', (ctx) => ctx.ai.stream({ prompt: 'same' }))

    const first = await (await app.fetch(new Request('http://localhost/'))).text()
    expect(first).toContain('"text":"cached"')

    const second = await (await app.fetch(new Request('http://localhost/'))).text()
    expect(calls).toBe(1)
    expect(second).toContain('"cached":true')
    expect(second).toContain('"text":"cached"')
  })

  test('a client hanging up aborts the provider call', async () => {
    let handed: AbortSignal | undefined
    let firedDuringCall = false

    const model = new MockLanguageModelV4({
      modelId: 'test-model',
      doStream: async (options: { abortSignal?: AbortSignal }) => {
        handed = options.abortSignal
        options.abortSignal?.addEventListener('abort', () => {
          firedDuringCall = true
        })
        return {
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: 'text-start', id: '0' })
              for (let index = 0; index < 50; index += 1) {
                controller.enqueue({ type: 'text-delta', id: '0', delta: `c${index} ` })
                await Bun.sleep(20)
              }
              controller.close()
            },
          }),
        }
      },
    })

    const app = createApp().use(ai({ model }))
    app.get('/', (ctx) => ctx.ai.stream({ prompt: 'hi' }))
    const server = await app.listen(0)

    try {
      const controller = new AbortController()
      const response = await fetch(`http://localhost:${server.port}/`, {
        signal: controller.signal,
      })
      const reader = response.body?.getReader()
      await reader?.read()
      controller.abort()
      await Bun.sleep(200)
    } finally {
      await server.stop(true)
    }

    // This is the whole mechanism: a real provider bills until its HTTP request is cancelled, and
    // nothing cancels it unless the request's signal reaches the model.
    expect(handed).toBeDefined()
    expect(firedDuringCall).toBe(true)
  })

  test('streamRaw hands back the SDK result for its own protocol', async () => {
    const app = createApp().use(ai({ model: streamingModel(['a', 'b']) }))
    app.get('/', (ctx) => ctx.ai.streamRaw({ prompt: 'hi' }).toTextStreamResponse())

    expect(await (await app.fetch(new Request('http://localhost/'))).text()).toBe('ab')
  })

  test('accounts for a raw stream the caller consumed itself', async () => {
    const app = createApp().use(ai({ model: streamingModel(['a', 'b']) }))
    app.get('/', async (ctx) => {
      const result = ctx.ai.streamRaw({ prompt: 'hi' })
      await result.consumeStream()
      await result.usage
      // Usage settles asynchronously; yield once so the accounting callback runs.
      await Bun.sleep(0)
      return ctx.ai.usage
    })

    const usage = await readJson(await app.fetch(new Request('http://localhost/')))
    expect(usage.totalTokens).toBe(15)
  })
})

describe('embed', () => {
  const model = new MockEmbeddingModelV4({
    modelId: 'test-embed',
    doEmbed: async () => ({ embeddings: [[0.1, 0.2, 0.3]], usage: { tokens: 8 }, warnings: [] }),
  })

  test('returns the vector with token usage priced at the input rate', async () => {
    const app = createApp().use(
      ai({ embeddingModel: model, pricing: { 'test-embed': { input: 10, output: 0 } } }),
    )
    app.get('/', async (ctx) => {
      const result = await ctx.ai.embed({ value: 'hello' })
      return { embedding: result.embedding, usage: result.usage, cost: result.cost }
    })

    const body = await readJson(await app.fetch(new Request('http://localhost/')))
    expect(body.embedding).toEqual([0.1, 0.2, 0.3])
    expect(body.usage.inputTokens).toBe(8)
    expect(body.cost).toBeCloseTo((8 * 10) / 1e6, 12)
  })

  test('caches, which is where caching is unambiguously right', async () => {
    let calls = 0
    const cache = fakeCache()
    const app = createApp().use(
      ai({
        embeddingModel: new MockEmbeddingModelV4({
          modelId: 'test-embed',
          doEmbed: async () => {
            calls += 1
            return { embeddings: [[1, 2]], usage: { tokens: 8 }, warnings: [] }
          },
        }),
        cache: { store: cache.store },
      }),
    )
    app.get('/', async (ctx) => {
      await ctx.ai.embed({ value: 'stable text' })
      const second = await ctx.ai.embed({ value: 'stable text' })
      return { calls, cached: second.cached, embedding: second.embedding }
    })

    const body = await readJson(await app.fetch(new Request('http://localhost/')))
    expect(body.calls).toBe(1)
    expect(body.cached).toBe(true)
    expect(body.embedding).toEqual([1, 2])
  })
})

describe('reporting', () => {
  test('onUsage sees every call, cache hits included', async () => {
    const seen: Array<{ operation: string; cached: boolean; model: string }> = []
    const cache = fakeCache()
    const app = createApp().use(
      ai({
        model: textModel('hello'),
        cache: { store: cache.store },
        onUsage: (record) => {
          seen.push({ operation: record.operation, cached: record.cached, model: record.model })
        },
      }),
    )
    app.get('/', async (ctx) => {
      await ctx.ai.generate({ prompt: 'p' })
      await ctx.ai.generate({ prompt: 'p' })
      return { ok: true }
    })

    await app.fetch(new Request('http://localhost/'))
    expect(seen).toEqual([
      { operation: 'generate', cached: false, model: 'test-model' },
      { operation: 'generate', cached: true, model: 'test-model' },
    ])
  })

  test('a throwing onUsage does not fail the request that produced it', async () => {
    const app = createApp().use(
      ai({
        model: textModel('hello'),
        onUsage: () => {
          throw new Error('metrics backend is down')
        },
      }),
    )
    app.get('/', async (ctx) => {
      const result = await ctx.ai.generate({ prompt: 'hi', cache: false })
      return { text: result.text }
    })

    const response = await app.fetch(new Request('http://localhost/'))
    expect(response.status).toBe(200)
    expect((await readJson(response)).text).toBe('hello')
  })

  test('record() folds in a call made straight through the SDK', async () => {
    const app = createApp().use(
      ai({ model: textModel('hello'), pricing: { 'gpt-4o': { input: 1, output: 2 } } }),
    )
    app.get('/', (ctx) => {
      ctx.ai.record(
        { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
        'generate',
        'gpt-4o',
      )
      return ctx.ai.usage
    })

    const usage = await readJson(await app.fetch(new Request('http://localhost/')))
    expect(usage.calls).toBe(1)
    expect(usage.cost).toBeCloseTo(1, 10)
  })
})

describe('configuration', () => {
  test('calling without a model fails with a clear message', async () => {
    const app = createApp().use(ai({}))
    app.get('/', (ctx) => ctx.ai.generate({ prompt: 'hi' }))

    const response = await app.fetch(new Request('http://localhost/'))
    expect(response.status).toBe(500)
    expect((await readJson(response)).detail ?? '').toMatch(/no model configured/i)
  })

  test('a per-call model overrides the configured default', async () => {
    const app = createApp().use(ai({ model: textModel('default') }))
    app.get('/', async (ctx) => {
      const result = await ctx.ai.generate({
        prompt: 'hi',
        model: textModel('override'),
        cache: false,
      })
      return { text: result.text }
    })

    expect((await readJson(await app.fetch(new Request('http://localhost/')))).text).toBe(
      'override',
    )
  })
})
