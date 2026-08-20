import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { type App, type AppOptions, createApp } from './app'
import { dependency, isDependency } from './dependency'
import { BadRequest, Forbidden } from './errors'
import { silentLogger } from './logger'

const opened: App[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 100 })))
})

function make(options: AppOptions = {}): App {
  const app = createApp({ logger: silentLogger, development: true, ...options })
  opened.push(app)
  return app
}

const send = (app: App, path: string, init?: RequestInit) =>
  app.fetch(new Request(`https://theoven.app${path}`, init))

describe('resolving', () => {
  test('the value reaches the handler', async () => {
    const answer = dependency('answer', () => 42)
    const app = make().get('/x', { deps: { answer } }, (ctx) => ({ got: ctx.deps.answer }))

    expect(await (await send(app, '/x')).json()).toEqual({ got: 42 })
  })

  test('a resolver can read the request', async () => {
    const host = dependency('host', (ctx) => ctx.header('x-tenant') ?? 'none')
    const app = make().get('/x', { deps: { host } }, (ctx) => ctx.deps.host)

    const response = await send(app, '/x', { headers: { 'x-tenant': 'acme' } })
    expect(await response.text()).toBe('acme')
  })

  /** Resolution is after validation, which is what lets a resolver read validated input. */
  test('a resolver sees validated params', async () => {
    const doubled = dependency('doubled', (ctx) => (ctx.params.id as unknown as number) * 2)
    const app = make().get(
      '/x/:id',
      { params: z.object({ id: z.coerce.number() }), deps: { doubled } },
      (ctx) => ({ doubled: ctx.deps.doubled }),
    )

    expect(await (await send(app, '/x/21')).json()).toEqual({ doubled: 42 })
  })

  test('several dependencies resolve independently', async () => {
    const a = dependency('a', () => 'A')
    const b = dependency('b', () => 'B')
    const app = make().get('/x', { deps: { a, b } }, (ctx) => `${ctx.deps.a}${ctx.deps.b}`)

    expect(await (await send(app, '/x')).text()).toBe('AB')
  })

  test('a route with no deps gets no scope', async () => {
    const app = make().get('/x', (ctx) => ({ deps: (ctx as { deps?: unknown }).deps ?? null }))

    expect(await (await send(app, '/x')).json()).toEqual({ deps: null })
  })

  test('a throwing dependency rejects the request before the handler runs', async () => {
    let handlerRan = false
    const guard = dependency('guard', () => {
      throw new Forbidden('Nope.')
    })
    const app = make().get('/x', { deps: { guard } }, () => {
      handlerRan = true
      return 'ok'
    })

    expect((await send(app, '/x')).status).toBe(403)
    expect(handlerRan).toBe(false)
  })

  test('isDependency tells one from anything else', () => {
    expect(isDependency(dependency('x', () => 1))).toBe(true)
    expect(isDependency(() => 1)).toBe(false)
    expect(isDependency(null)).toBe(false)
  })

  test('a resolver is required', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately wrong call
    expect(() => dependency('x', undefined as any)).toThrow(/needs a resolver/)
  })
})

describe('sub-dependencies', () => {
  test('one dependency can use another', async () => {
    const tenant = dependency('tenant', () => ({ id: 't1' }))
    const member = dependency('member', async (_ctx, use) => {
      const current = await use(tenant)
      return `member-of-${current.id}`
    })
    const app = make().get('/x', { deps: { member } }, (ctx) => ctx.deps.member)

    expect(await (await send(app, '/x')).text()).toBe('member-of-t1')
  })

  /** The property that makes a dependency graph cheap rather than quadratic. */
  test('a shared dependency resolves once per request', async () => {
    let calls = 0
    const shared = dependency('shared', () => {
      calls++
      return calls
    })
    const a = dependency('a', (_ctx, use) => use(shared))
    const b = dependency('b', (_ctx, use) => use(shared))

    const app = make().get('/x', { deps: { a, b, shared } }, (ctx) => ({
      a: ctx.deps.a,
      b: ctx.deps.b,
      shared: ctx.deps.shared,
    }))

    expect(await (await send(app, '/x')).json()).toEqual({ a: 1, b: 1, shared: 1 })
    expect(calls).toBe(1)
  })

  test('the cache is per request, not per app', async () => {
    let calls = 0
    const counted = dependency('counted', () => ++calls)
    const app = make().get('/x', { deps: { counted } }, (ctx) => ctx.deps.counted)

    expect(await (await send(app, '/x')).text()).toBe('1')
    expect(await (await send(app, '/x')).text()).toBe('2')
  })

  test('concurrent uses of the same dependency share one resolution', async () => {
    let starts = 0
    const slow = dependency('slow', async () => {
      starts++
      await Bun.sleep(5)
      return starts
    })
    const a = dependency('a', (_ctx, use) => use(slow))
    const b = dependency('b', (_ctx, use) => use(slow))
    const app = make().get('/x', { deps: { a, b } }, (ctx) => ({ a: ctx.deps.a, b: ctx.deps.b }))

    await send(app, '/x')
    expect(starts).toBe(1)
  })
})

describe('teardown', () => {
  test('code after yield runs when the request succeeds', async () => {
    const order: string[] = []
    const scoped = dependency('scoped', async function* () {
      order.push('setup')
      yield 'value'
      order.push('teardown')
    })
    const app = make().get('/x', { deps: { scoped } }, (ctx) => {
      order.push('handler')
      return ctx.deps.scoped
    })

    await send(app, '/x')
    expect(order).toEqual(['setup', 'handler', 'teardown'])
  })

  /**
   * The case the whole generator form exists for: a transaction has to know whether to commit.
   * The request's error is thrown in at the `yield`, so `try`/`catch` is the idiom.
   */
  test('the failure is thrown into the generator, so a rollback is expressible', async () => {
    const log: string[] = []
    const tx = dependency('tx', async function* () {
      log.push('begin')
      try {
        yield 'handle'
        log.push('commit')
      } catch (error) {
        log.push('rollback')
        throw error
      }
    })
    const app = make().get('/x', { deps: { tx } }, () => {
      throw new BadRequest('no')
    })

    expect((await send(app, '/x')).status).toBe(400)
    expect(log).toEqual(['begin', 'rollback'])
  })

  test('and commits when the handler succeeds', async () => {
    const log: string[] = []
    const tx = dependency('tx', async function* () {
      try {
        yield 'handle'
        log.push('commit')
      } catch {
        log.push('rollback')
      }
    })
    const app = make().get('/x', { deps: { tx } }, () => 'ok')

    expect((await send(app, '/x')).status).toBe(200)
    expect(log).toEqual(['commit'])
  })

  test('teardown runs in reverse order of resolution', async () => {
    const order: string[] = []
    const outer = dependency('outer', async function* () {
      yield 'outer'
      order.push('outer')
    })
    const inner = dependency('inner', async function* (_ctx, use) {
      await use(outer)
      yield 'inner'
      order.push('inner')
    })
    const app = make().get('/x', { deps: { inner } }, () => 'ok')

    await send(app, '/x')
    // `outer` resolved first, so it is torn down last.
    expect(order).toEqual(['inner', 'outer'])
  })

  /**
   * A resolver that threw before yielding built nothing, so calling back into it would run
   * cleanup against state that does not exist. The one that *did* yield must still be torn down.
   */
  test('a resolver that throws before yielding is not torn down; earlier ones still are', async () => {
    const order: string[] = []

    const good = dependency('good', async function* () {
      order.push('good:setup')
      try {
        yield 'value'
      } finally {
        // `finally`, so cleanup is guaranteed on the failure path too — see the test below.
        order.push('good:teardown')
      }
    })
    const broken = dependency('broken', async function* (_ctx, use) {
      await use(good)
      order.push('broken:setup')
      throw new BadRequest('cannot start')
    })

    const app = make().get('/x', { deps: { broken } }, () => {
      order.push('handler')
      return 'ok'
    })

    expect((await send(app, '/x')).status).toBe(400)
    // `good` was torn down; `broken` never yielded so it contributed no teardown; the handler
    // never ran at all.
    expect(order).toEqual(['good:setup', 'broken:setup', 'good:teardown'])
  })

  /** A commit that fails means the response about to go out would be a lie. */
  test('a teardown that fails on a successful request makes it a 500', async () => {
    const tx = dependency('tx', async function* () {
      yield 'handle'
      throw new Error('commit failed')
    })
    const app = make().get('/x', { deps: { tx } }, () => 'ok')

    expect((await send(app, '/x')).status).toBe(500)
  })

  /** Replacing the original error with a cleanup error loses the thing worth reading. */
  test('a teardown that fails on an already-failing request keeps the original error', async () => {
    const tx = dependency('tx', async function* () {
      try {
        yield 'handle'
      } catch {
        throw new Error('rollback also failed')
      }
    })
    const app = make().get('/x', { deps: { tx } }, () => {
      throw new Forbidden('the real problem')
    })

    const response = await send(app, '/x')
    expect(response.status).toBe(403)
  })

  /**
   * The sharp edge, tested so it is a documented property rather than a surprise.
   *
   * A failure is thrown into the generator *at the yield*, which is what makes `catch` able to
   * roll back. The consequence is ordinary JavaScript: statements after `yield` are skipped when
   * an exception arrives there. Guaranteed cleanup goes in `finally`.
   *
   * This is the same rule as Python's `@contextmanager`, which is what FastAPI's `yield`
   * dependencies are built on.
   */
  test('cleanup written after yield is skipped on failure; finally is not', async () => {
    const ran: string[] = []

    const naive = dependency('naive', async function* () {
      yield 'a'
      ran.push('naive')
    })
    const safe = dependency('safe', async function* () {
      try {
        yield 'b'
      } finally {
        ran.push('safe')
      }
    })

    const app = make().get('/x', { deps: { naive, safe } }, () => {
      throw new BadRequest('no')
    })

    await send(app, '/x')
    expect(ran).toEqual(['safe'])

    // On the success path both run, which is why the difference is easy to miss.
    ran.length = 0
    const ok = make().get('/x', { deps: { naive, safe } }, () => 'ok')
    await send(ok, '/x')
    expect(ran.sort()).toEqual(['naive', 'safe'])
  })

  test('a generator that yields twice is reported rather than hanging', async () => {
    const twice = dependency('twice', async function* () {
      yield 'one'
      yield 'two'
    })
    const app = make().get('/x', { deps: { twice } }, (ctx) => ctx.deps.twice)

    expect((await send(app, '/x')).status).toBe(200)
  })

  test('a generator that never yields is an error naming it', async () => {
    const empty = dependency('empty', async function* () {
      // yields nothing
    })
    const app = make().get('/x', { deps: { empty } }, () => 'ok')

    expect((await send(app, '/x')).status).toBe(500)
  })
})

describe('overrides', () => {
  test('replace the resolver', async () => {
    const tenant = dependency('tenant', () => ({ id: 'real' }))
    const app = make().get('/x', { deps: { tenant } }, (ctx) => ctx.deps.tenant.id)

    app.override(tenant, () => ({ id: 'fake' }))

    expect(await (await send(app, '/x')).text()).toBe('fake')
  })

  test('an override applies to a sub-dependency too', async () => {
    const tenant = dependency('tenant', () => ({ id: 'real' }))
    const member = dependency('member', async (_ctx, use) => (await use(tenant)).id)
    const app = make().get('/x', { deps: { member } }, (ctx) => ctx.deps.member)

    app.override(tenant, () => ({ id: 'fake' }))

    expect(await (await send(app, '/x')).text()).toBe('fake')
  })

  test('clearOverrides restores the real resolver', async () => {
    const tenant = dependency('tenant', () => ({ id: 'real' }))
    const app = make().get('/x', { deps: { tenant } }, (ctx) => ctx.deps.tenant.id)

    app.override(tenant, () => ({ id: 'fake' }))
    expect(await (await send(app, '/x')).text()).toBe('fake')

    app.clearOverrides()
    expect(await (await send(app, '/x')).text()).toBe('real')
  })
})

/**
 * Before this, `a -> b -> a` recursed until the stack ran out and reported "Maximum call stack
 * size exceeded" — which names neither dependency and looks like a bug in the framework.
 */
describe('cycles', () => {
  test('a direct cycle names both dependencies', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: the cycle is the point; the types cannot close it
    const a: any = dependency('a', async (_ctx, use) => use(b))
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const b: any = dependency('b', async (_ctx, use) => use(a))

    const app = make({ development: true }).get('/x', { deps: { a } }, () => 'ok')
    const body = await (await send(app, '/x')).text()

    expect(body).toContain('Dependency cycle: a -> b -> a')
  })

  test('an indirect cycle names the whole path', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const a: any = dependency('a', async (_ctx, use) => use(b))
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const b: any = dependency('b', async (_ctx, use) => use(c))
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const c: any = dependency('c', async (_ctx, use) => use(a))

    const app = make({ development: true }).get('/x', { deps: { a } }, () => 'ok')

    expect(await (await send(app, '/x')).text()).toContain('Dependency cycle: a -> b -> c -> a')
  })

  test('a dependency using itself is caught', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const self: any = dependency('self', async (_ctx, use) => use(self))

    const app = make({ development: true }).get('/x', { deps: { self } }, () => 'ok')

    expect(await (await send(app, '/x')).text()).toContain('Dependency cycle: self -> self')
  })

  /** A diamond is not a cycle: two dependencies sharing a third is the normal case. */
  test('a diamond is not reported as a cycle', async () => {
    const shared = dependency('shared', () => 'S')
    const left = dependency('left', (_ctx, use) => use(shared))
    const right = dependency('right', (_ctx, use) => use(shared))

    const app = make().get(
      '/x',
      { deps: { left, right } },
      (ctx) => `${ctx.deps.left}${ctx.deps.right}`,
    )

    expect(await (await send(app, '/x')).text()).toBe('SS')
  })

  /**
   * The chain is popped when a dependency finishes, so a later cycle's message describes only
   * the cycle. Without popping the check still *works* — the cache short-circuits repeat uses —
   * but the reported path accumulates every dependency the request ever resolved, which is the
   * difference between a message you can act on and a list.
   */
  test('the reported path contains only the cycle, not earlier resolutions', async () => {
    const first = dependency('first', () => 1)
    const second = dependency('second', async (_ctx, use) => use(first))
    // biome-ignore lint/suspicious/noExplicitAny: the cycle is the point
    const loopA: any = dependency('loopA', async (_ctx, use) => use(loopB))
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const loopB: any = dependency('loopB', async (_ctx, use) => use(loopA))

    const app = make({ development: true }).get('/x', { deps: { second, loopA } }, () => 'ok')
    const body = await (await send(app, '/x')).text()

    expect(body).toContain('Dependency cycle: loopA -> loopB -> loopA')
    expect(body).not.toContain('second')
    expect(body).not.toContain('first')
  })

  test('the same dependency used twice in sequence is not a cycle', async () => {
    const shared = dependency('shared', () => 'S')
    const outer = dependency(
      'outer',
      async (_ctx, use) => `${await use(shared)}${await use(shared)}`,
    )

    const app = make().get('/x', { deps: { outer } }, (ctx) => ctx.deps.outer)

    expect(await (await send(app, '/x')).text()).toBe('SS')
  })
})
