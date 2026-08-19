import { afterEach, describe, expect, expectTypeOf, test } from 'bun:test'
import { type App, type AppOptions, appFromConfig, createApp, defineConfig } from './app'
import { type Brick, orderBricks } from './brick'
import type { Context } from './context'
import { silentLogger } from './logger'

const opened: Array<{ close(options?: { timeout?: number }): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 100 })))
})

function make(options: AppOptions = {}): App {
  const app = createApp({ logger: silentLogger, development: true, ...options })
  opened.push(app)
  return app
}

function send(
  app: { fetch(request: Request): Promise<Response> },
  path: string,
): Promise<Response> {
  return app.fetch(new Request(`https://theoven.app${path}`))
}

/** A minimal brick contributing a value under `name`. */
function stub<const Name extends string, Value>(
  name: Name,
  value: Value,
  extra: Partial<Brick<Name, Value>> = {},
): Brick<Name, Value> {
  return { name, setup: () => value, ...extra }
}

describe('registration', () => {
  test('exposes the setup value on the context', async () => {
    const app = make().use(stub('storage', { bucket: 'uploads' }))
    app.get('/x', (ctx) => ctx.storage)
    expect(await (await send(app, '/x')).json()).toEqual({ bucket: 'uploads' })
  })

  test('several bricks coexist', async () => {
    const app = make().use(stub('a', 1)).use(stub('b', 2))
    app.get('/x', (ctx) => ({ a: ctx.a, b: ctx.b }))
    expect(await (await send(app, '/x')).json()).toEqual({ a: 1, b: 2 })
  })

  test('setup runs once, not per request', async () => {
    let setups = 0
    const app = make().use({
      name: 'counted',
      setup: () => {
        setups++
        return setups
      },
    })
    app.get('/x', (ctx) => ({ value: ctx.counted }))

    await send(app, '/x')
    await send(app, '/x')
    await send(app, '/x')
    expect(setups).toBe(1)
  })

  test('an async setup is awaited', async () => {
    const app = make().use({
      name: 'slow',
      setup: async () => {
        await Bun.sleep(5)
        return 'ready'
      },
    })
    app.get('/x', (ctx) => ({ value: ctx.slow }))
    expect(await (await send(app, '/x')).json()).toEqual({ value: 'ready' })
  })

  test('a duplicate brick name is rejected', () => {
    const app = make().use(stub('dup', 1))
    expect(() => app.use(stub('dup', 2))).toThrow(/already registered/)
  })

  // Shadowing a core property surfaces far from the brick responsible, so it fails at boot.
  test('a name colliding with a context property is rejected', async () => {
    const app = make().use(stub('body', 'hijacked'))
    expect(app.ready()).rejects.toThrow(/collides with a built-in/)
  })

  test('registering after the app has started is rejected', async () => {
    const app = make()
    app.get('/x', () => 'ok')
    await send(app, '/x')
    expect(() => app.use(stub('late', 1))).toThrow(/after the app started/)
  })
})

describe('dependency ordering', () => {
  test('sets up dependencies first', async () => {
    const order: string[] = []
    const app = make()
      .use({
        name: 'auth',
        dependsOn: ['db'],
        setup: () => {
          order.push('auth')
          return 'auth'
        },
      })
      .use({
        name: 'db',
        setup: () => {
          order.push('db')
          return 'db'
        },
      })

    await app.ready()
    expect(order).toEqual(['db', 'auth'])
  })

  test('a dependency can read the value it depends on', async () => {
    const app = make()
      .use({ name: 'db', setup: () => ({ url: 'postgres://local' }) })
      .use({
        name: 'auth',
        dependsOn: ['db'],
        setup: (context) => ({ using: (context.resolved.db as { url: string }).url }),
      })

    app.get('/x', (ctx) => ctx.auth)
    expect(await (await send(app, '/x')).json()).toEqual({ using: 'postgres://local' })
  })

  test('a missing dependency is named in the error', async () => {
    const app = make().use({ name: 'auth', dependsOn: ['db'], setup: () => 1 })
    expect(app.ready()).rejects.toThrow(/depends on "db"/)
  })

  // A cycle cannot be resolved at runtime, so it fails at boot naming both bricks.
  test('a dependency cycle is rejected', () => {
    const a = { name: 'a', dependsOn: ['b'], setup: () => 1 }
    const b = { name: 'b', dependsOn: ['a'], setup: () => 2 }
    expect(() => orderBricks([a, b])).toThrow(/cycle/)
  })

  test('orderBricks handles a diamond without duplicating', () => {
    const base = { name: 'base', setup: () => 1 }
    const left = { name: 'left', dependsOn: ['base'], setup: () => 2 }
    const right = { name: 'right', dependsOn: ['base'], setup: () => 3 }
    const top = { name: 'top', dependsOn: ['left', 'right'], setup: () => 4 }

    const ordered = orderBricks([top, left, right, base]).map((brick) => brick.name)
    expect(ordered).toHaveLength(4)
    expect(ordered.indexOf('base')).toBeLessThan(ordered.indexOf('left'))
    expect(ordered.indexOf('left')).toBeLessThan(ordered.indexOf('top'))
  })
})

describe('brick hooks', () => {
  test('onRequest runs for every request', async () => {
    let calls = 0
    const app = make().use({
      name: 'counter',
      setup: () => null,
      onRequest: () => {
        calls++
      },
    })
    app.get('/x', () => 'ok')

    await send(app, '/x')
    await send(app, '/x')
    expect(calls).toBe(2)
  })

  test('onRequest can attach per-request state', async () => {
    const app = make().use({
      name: 'session',
      setup: () => null,
      onRequest: (ctx: Context) => {
        ;(ctx as Context & { user?: string }).user = 'ada'
      },
    })
    app.get('/x', (ctx) => ({ user: (ctx as Context & { user?: string }).user }))
    expect(await (await send(app, '/x')).json()).toEqual({ user: 'ada' })
  })

  test('onShutdown receives the resolved value', async () => {
    const closed: unknown[] = []
    const app = createApp({ logger: silentLogger }).use({
      name: 'pool',
      setup: () => ({ id: 'pool-1' }),
      onShutdown: (value) => {
        closed.push(value)
      },
    })

    await app.ready()
    await app.close()
    expect(closed).toEqual([{ id: 'pool-1' }])
  })

  test('a brick can register its own routes', async () => {
    const app = make().use({
      name: 'docs',
      setup: (context) => {
        context.route('GET', '/_docs', () => ({ generated: true }))
        return { mounted: true }
      },
    })

    expect(await (await send(app, '/_docs')).json()).toEqual({ generated: true })
  })

  test('setup is told whether this is development', async () => {
    let seen: boolean | undefined
    const app = make({ development: false }).use({
      name: 'env',
      setup: (context) => {
        seen = context.development
        return null
      },
    })
    await app.ready()
    expect(seen).toBe(false)
  })
})

describe('boot', () => {
  test('ready is idempotent', async () => {
    let setups = 0
    const app = make().use({
      name: 'once',
      setup: () => {
        setups++
        return 1
      },
    })

    await app.ready()
    await app.ready()
    await app.ready()
    expect(setups).toBe(1)
  })

  test('fetch boots the app automatically', async () => {
    const app = make().use(stub('auto', 'booted'))
    app.get('/x', (ctx) => ({ value: ctx.auto }))
    // No explicit ready() call.
    expect(await (await send(app, '/x')).json()).toEqual({ value: 'booted' })
  })

  test('an app with no bricks needs no boot work', async () => {
    const app = make()
    app.get('/x', () => 'ok')
    expect(await (await send(app, '/x')).text()).toBe('ok')
  })
})

describe('defineConfig', () => {
  test('returns the config unchanged', () => {
    const config = defineConfig({ trustProxy: 1, logLevel: 'warn' })
    expect(config).toEqual({ trustProxy: 1, logLevel: 'warn' })
  })

  test('appFromConfig registers the bricks', async () => {
    const app = appFromConfig(
      defineConfig({
        logger: silentLogger,
        bricks: [stub('storage', { bucket: 'b' }), stub('queue', { driver: 'redis' })],
      }),
    )
    opened.push(app)

    app.get('/x', (ctx) => ({
      storage: (ctx as Context & { storage: unknown }).storage,
      queue: (ctx as Context & { queue: unknown }).queue,
    }))

    expect(await (await send(app, '/x')).json()).toEqual({
      storage: { bucket: 'b' },
      queue: { driver: 'redis' },
    })
  })

  test('appFromConfig passes core options through', async () => {
    const app = appFromConfig(defineConfig({ logger: silentLogger, trustProxy: true }))
    opened.push(app)
    app.get('/ip', (ctx) => ({ ip: ctx.ip ?? null }))

    const response = await app.fetch(
      new Request('https://theoven.app/ip', { headers: { 'x-forwarded-for': '1.2.3.4' } }),
    )
    expect(await response.json()).toEqual({ ip: '1.2.3.4' })
  })
})

/**
 * The point of the brick system is that types flow. A brick that runs but does not type is
 * only half the feature, so the inference is asserted rather than assumed.
 */
describe('type inference', () => {
  test('a registered brick is typed on the context', () => {
    const app = createApp({ logger: silentLogger }).use(stub('storage', { bucket: 'uploads' }))
    app.get('/x', (ctx) => {
      expectTypeOf(ctx.storage).toEqualTypeOf<{ bucket: string }>()
      return null
    })
  })

  test('several bricks accumulate', () => {
    const app = createApp({ logger: silentLogger })
      .use(stub('storage', { bucket: 'uploads' }))
      .use(stub('queue', { driver: 'redis' as const }))

    app.get('/x', (ctx) => {
      expectTypeOf(ctx.storage).toEqualTypeOf<{ bucket: string }>()
      expectTypeOf(ctx.queue).toEqualTypeOf<{ driver: 'redis' }>()
      return null
    })
  })

  test('an async setup contributes the awaited type, not a promise', () => {
    const app = createApp({ logger: silentLogger }).use({
      name: 'db' as const,
      setup: async () => ({ query: (sql: string) => sql }),
    })

    app.get('/x', (ctx) => {
      expectTypeOf(ctx.db).toEqualTypeOf<{ query: (sql: string) => string }>()
      return null
    })
  })

  // The other half of the promise: an unconfigured module must not typecheck.
  test('an unregistered brick is a compile error, not a runtime crash', () => {
    const app = createApp({ logger: silentLogger }).use(stub('storage', { bucket: 'uploads' }))
    app.get('/x', (ctx) => {
      // @ts-expect-error `queue` was never registered, so it does not exist on the context.
      void ctx.queue
      return null
    })
  })

  test('core context properties survive the extension', () => {
    const app = createApp({ logger: silentLogger }).use(stub('storage', { bucket: 'uploads' }))
    app.get('/x', (ctx) => {
      expectTypeOf(ctx.params).toEqualTypeOf<Record<string, string>>()
      expectTypeOf(ctx.token).toEqualTypeOf<string | undefined>()
      return null
    })
  })
})
