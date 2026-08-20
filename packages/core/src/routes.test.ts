import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { type App, type AppOptions, createApp } from './app'
import { dependency } from './dependency'
import { Forbidden } from './errors'
import { silentLogger } from './logger'
import { isRouter, router, routerFor } from './routes'

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

describe('mounting', () => {
  test('routes reach the app', async () => {
    const api = router()
    api.get('/hello', () => 'hi')

    const app = make().use(api)

    expect(await (await send(app, '/hello')).text()).toBe('hi')
  })

  test('the prefix is applied', async () => {
    const admin = router({ prefix: '/admin' })
    admin.get('/users', () => 'listed')

    const app = make().use(admin)

    expect((await send(app, '/admin/users')).status).toBe(200)
    expect((await send(app, '/users')).status).toBe(404)
  })

  test('a prefix respects segment boundaries', async () => {
    const admin = router({ prefix: '/admin' })
    admin.get('/', () => 'root')

    const app = make().use(admin)

    expect((await send(app, '/admin')).status).toBe(200)
    expect((await send(app, '/administrators')).status).toBe(404)
  })

  test('every verb is registered', async () => {
    const api = router({ prefix: '/r' })
    api.get('/x', () => 'get')
    api.post('/x', () => 'post')
    api.put('/x', () => 'put')
    api.patch('/x', () => 'patch')
    api.delete('/x', () => 'delete')
    api.options('/y', () => 'options')

    const app = make().use(api)

    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const response = await send(app, '/r/x', { method: method.toUpperCase() })
      expect(await response.text()).toBe(method)
    }
  })

  /** A router holds routes rather than binding to an app, which is what makes this work. */
  test('the same router can be mounted twice', async () => {
    const api = router()
    api.get('/ping', () => 'pong')

    const app = make()
      .use(router({ prefix: '/v1' }).use(api))
      .use(router({ prefix: '/v2' }).use(api))

    expect(await (await send(app, '/v1/ping')).text()).toBe('pong')
    expect(await (await send(app, '/v2/ping')).text()).toBe('pong')
  })

  test('a handler is required', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately wrong call
    expect(() => router().get('/x', undefined as any)).toThrow(/without a handler/)
  })

  test('isRouter tells a router from a brick', () => {
    expect(isRouter(router())).toBe(true)
    expect(isRouter({ name: 'db', setup: () => ({}) })).toBe(false)
    expect(isRouter(null)).toBe(false)
  })
})

describe('defaults', () => {
  test('tags accumulate rather than replace', () => {
    const admin = router({ prefix: '/admin', tags: ['admin'] })
    admin.get('/users', { tags: ['users'] }, () => 'x')

    const [route] = admin.collect().routes

    expect(route?.schema?.tags).toEqual(['admin', 'users'])
  })

  test('a router tag reaches a route that declared no schema', () => {
    const admin = router({ tags: ['admin'] })
    admin.get('/x', () => 'x')

    expect(admin.collect().routes[0]?.schema?.tags).toEqual(['admin'])
  })

  test('auth applies to every route in the router', () => {
    const admin = router({ auth: 'staff' })
    admin.get('/a', () => 'a')
    admin.get('/b', { tags: ['x'] }, () => 'b')

    for (const route of admin.collect().routes) {
      expect(route.schema?.auth).toBe('staff')
    }
  })

  test("a route's own auth wins over the router's", () => {
    const admin = router({ auth: 'staff' })
    admin.get('/x', { auth: 'owner' }, () => 'x')

    expect(admin.collect().routes[0]?.schema?.auth).toBe('owner')
  })

  /**
   * The case worth having a test for: one public route inside an otherwise guarded group. A
   * truthiness check on the router's default would swallow `false` and guard it anyway.
   */
  test('auth: false survives a router that guards everything else', () => {
    const admin = router({ auth: 'staff' })
    admin.get('/private', () => 'p')
    admin.get('/health', { auth: false }, () => 'h')

    const routes = admin.collect().routes

    expect(routes[0]?.schema?.auth).toBe('staff')
    expect(routes[1]?.schema?.auth).toBe(false)
  })

  test('a router with no defaults leaves a schemaless route alone', () => {
    const plain = router()
    plain.get('/x', () => 'x')

    expect(plain.collect().routes[0]?.schema).toBeUndefined()
  })

  test('other schema keys are untouched', () => {
    const params = z.object({ id: z.string() })
    const admin = router({ tags: ['admin'] })
    admin.get('/x/:id', { params, summary: 'Fetch' }, () => 'x')

    const schema = admin.collect().routes[0]?.schema

    expect(schema?.params).toBe(params)
    expect(schema?.summary).toBe('Fetch')
  })
})

describe('nesting', () => {
  test('prefixes join', async () => {
    const users = router({ prefix: '/users' })
    users.get('/:id', (ctx) => ctx.params.id)

    const admin = router({ prefix: '/admin' }).use(users)
    const app = make().use(admin)

    expect(await (await send(app, '/admin/users/7')).text()).toBe('7')
  })

  test('tags and auth are inherited by children', () => {
    const users = router({ tags: ['users'] })
    users.get('/x', () => 'x')

    const admin = router({ prefix: '/admin', tags: ['admin'], auth: 'staff' }).use(users)
    const [route] = admin.collect().routes.filter((entry) => entry.path.endsWith('/x'))

    expect(route?.schema?.tags).toEqual(['admin', 'users'])
    expect(route?.schema?.auth).toBe('staff')
  })

  test("a child's own auth overrides the parent's", () => {
    const open = router({ prefix: '/public', auth: false })
    open.get('/x', () => 'x')

    const admin = router({ prefix: '/admin', auth: 'staff' }).use(open)
    const [route] = admin.collect().routes

    expect(route?.schema?.auth).toBe(false)
  })

  test('size counts nested routes', () => {
    const child = router()
    child.get('/a', () => 'a')
    child.get('/b', () => 'b')

    expect(router().use(child).size).toBe(2)
  })
})

describe('middleware', () => {
  test('runs for the router it belongs to', async () => {
    const seen: string[] = []
    const admin = router({ prefix: '/admin' })
    admin.use(async (ctx, next) => {
      seen.push(ctx.path)
      return next()
    })
    admin.get('/x', () => 'x')

    const app = make().use(admin)
    app.get('/outside', () => 'o')

    await send(app, '/admin/x')
    await send(app, '/outside')

    expect(seen).toEqual(['/admin/x'])
  })

  test('it wraps the router even when declared after its routes', async () => {
    const order: string[] = []
    const admin = router({ prefix: '/admin' })
    admin.get('/x', () => {
      order.push('handler')
      return 'x'
    })
    admin.use(async (_ctx, next) => {
      order.push('middleware')
      return next()
    })

    await send(make().use(admin), '/admin/x')

    expect(order).toEqual(['middleware', 'handler'])
  })

  test('a nested router inherits the parent prefix for its middleware', async () => {
    const seen: string[] = []
    const users = router({ prefix: '/users' })
    users.use(async (ctx, next) => {
      seen.push(ctx.path)
      return next()
    })
    users.get('/x', () => 'x')

    const app = make().use(router({ prefix: '/admin' }).use(users))
    app.get('/admin/other', () => 'o')

    await send(app, '/admin/users/x')
    await send(app, '/admin/other')

    expect(seen).toEqual(['/admin/users/x'])
  })
})

describe('routerFor', () => {
  test('binds the app type so ctx is typed', async () => {
    const app = make().use({ name: 'clock' as const, setup: () => ({ now: () => 42 }) })
    const api = routerFor<typeof app>({ prefix: '/api' })

    api.get('/time', (ctx) => ({ at: ctx.clock.now() }))
    //                            ^ typed by the bound app

    app.use(api)

    expect(await (await send(app, '/api/time')).json()).toEqual({ at: 42 })
  })
})

describe('the routes it registers are real routes', () => {
  test('validation applies', async () => {
    const api = router({ prefix: '/api' })
    api.post('/x', { body: z.object({ n: z.number() }) }, (ctx) => ctx.body.n)

    const app = make().use(api)
    const response = await send(app, '/api/x', {
      method: 'POST',
      body: JSON.stringify({ n: 'no' }),
      headers: { 'content-type': 'application/json' },
    })

    expect(response.status).toBe(422)
  })

  test('they appear in the route table', () => {
    const api = router({ prefix: '/api' })
    api.get('/x', () => 'x')

    const app = make().use(api)

    expect(app.routeTable().some((entry) => entry.pattern === '/api/x')).toBe(true)
  })
})

/**
 * Router-level dependencies — FastAPI's `APIRouter(dependencies=[...])`.
 *
 * Unlike every other default on a router, these **accumulate** with a route's own. A router
 * dependency and a route dependency are both wanted, and replacing one with the other would mean
 * a handler reading `ctx.deps.x` that nothing resolved.
 */
describe('router dependencies', () => {
  test('every route in the router resolves them', async () => {
    const tenant = dependency('tenant', () => 'acme')
    const admin = router({ prefix: '/admin', deps: { tenant } })

    admin.get('/a', (ctx) => ctx.deps.tenant)
    admin.get('/b', (ctx) => ctx.deps.tenant)

    const app = make().use(admin)

    expect(await (await send(app, '/admin/a')).text()).toBe('acme')
    expect(await (await send(app, '/admin/b')).text()).toBe('acme')
  })

  test('they accumulate with a route’s own rather than replacing them', async () => {
    const fromRouter = dependency('fromRouter', () => 'R')
    const fromRoute = dependency('fromRoute', () => 'r')

    const api = router({ deps: { fromRouter } })
    api.get('/x', { deps: { fromRoute } }, (ctx) => `${ctx.deps.fromRouter}${ctx.deps.fromRoute}`)

    expect(await (await send(make().use(api), '/x')).text()).toBe('Rr')
  })

  test('a route wins a name collision', async () => {
    const routerDep = dependency('shared', () => 'router')
    const routeDep = dependency('shared', () => 'route')

    const api = router({ deps: { shared: routerDep } })
    api.get('/x', { deps: { shared: routeDep } }, (ctx) => ctx.deps.shared)

    expect(await (await send(make().use(api), '/x')).text()).toBe('route')
  })

  /**
   * Inheritance is a runtime property. It cannot be a type one: `users` is built before it is
   * nested, so its handler signatures cannot retroactively gain what the parent declares. A child
   * that wants its parent's dependencies typed declares them itself — they de-duplicate by name.
   */
  test('nested routers inherit them at runtime, and add their own', async () => {
    const outer = dependency('outer', () => 'O')
    const inner = dependency('inner', () => 'I')

    const users = router({ prefix: '/users', deps: { inner } })
    users.get('/x', (ctx) => {
      const deps = ctx.deps as { outer: string; inner: string }
      return `${deps.outer}${deps.inner}`
    })

    const app = make().use(router({ prefix: '/admin', deps: { outer } }).use(users))

    expect(await (await send(app, '/admin/users/x')).text()).toBe('OI')
  })

  test('a child that declares the parent’s dependency gets it typed', async () => {
    const shared = dependency('shared', () => 'S')

    const users = router({ prefix: '/users', deps: { shared } })
    users.get('/x', (ctx) => ctx.deps.shared)
    //                        ^ typed, because this router declared it

    const app = make().use(router({ prefix: '/admin', deps: { shared } }).use(users))

    expect(await (await send(app, '/admin/users/x')).text()).toBe('S')
  })

  test('a router dependency that throws refuses every route under it', async () => {
    const guard = dependency('guard', () => {
      throw new Forbidden('no')
    })
    const admin = router({ prefix: '/admin', deps: { guard } })
    admin.get('/a', () => 'a')

    const app = make().use(admin)
    app.get('/outside', () => 'fine')

    expect((await send(app, '/admin/a')).status).toBe(403)
    expect((await send(app, '/outside')).status).toBe(200)
  })

  test('a router without deps leaves a route’s own alone', () => {
    const only = dependency('only', () => 1)
    const api = router({ prefix: '/x' })
    api.get('/y', { deps: { only } }, () => 'y')

    expect(Object.keys(api.collect().routes[0]?.schema?.deps ?? {})).toEqual(['only'])
  })
})
