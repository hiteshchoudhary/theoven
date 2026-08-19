import { afterEach, describe, expect, test } from 'bun:test'
import { App, type AppOptions, createApp, pathnameOf } from './app'
import { BadRequest, NotFound, OvenError } from './errors'
import { silentLogger } from './logger'

/** Apps created during a test, torn down afterwards so no socket or signal handler leaks. */
const opened: App[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 100 })))
})

function make(options: AppOptions = {}): App {
  const app = createApp({ logger: silentLogger, ...options })
  opened.push(app)
  return app
}

/** Dispatches directly, exercising the same pipeline `Bun.serve` uses. */
function send(app: App, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`https://theoven.app${path}`, init))
}

describe('pathnameOf', () => {
  test.each([
    ['https://theoven.app/users', '/users'],
    ['https://theoven.app/', '/'],
    ['https://theoven.app', '/'],
    ['https://theoven.app/users?page=2', '/users'],
    ['https://theoven.app/users#top', '/users'],
    ['https://theoven.app/users?q=a#top', '/users'],
    ['http://localhost:3000/a/b/c', '/a/b/c'],
    ['https://theoven.app/?q=1', '/'],
  ])('%s -> %s', (url, expected) => {
    expect(pathnameOf(url)).toBe(expected)
  })

  test('agrees with URL parsing, which it exists to avoid', () => {
    const urls = [
      'https://theoven.app/a/b?x=1#y',
      'https://theoven.app/',
      'http://127.0.0.1:8080/deep/path/here',
    ]
    for (const url of urls) {
      expect(pathnameOf(url)).toBe(new URL(url).pathname)
    }
  })
})

describe('routing', () => {
  test('dispatches to a handler', async () => {
    const app = make().get('/hello', () => 'world')
    expect(await (await send(app, '/hello')).text()).toBe('world')
  })

  test('passes route params', async () => {
    const app = make().get('/users/:id', (ctx) => ctx.params)
    expect(await (await send(app, '/users/7')).json()).toEqual({ id: '7' })
  })

  test('separates methods on one path', async () => {
    const app = make()
      .get('/users', () => 'list')
      .post('/users', () => 'create')
    expect(await (await send(app, '/users')).text()).toBe('list')
    expect(await (await send(app, '/users', { method: 'POST' })).text()).toBe('create')
  })

  test('registers every HTTP verb', async () => {
    const app = make()
    app.get('/r', () => 'get')
    app.post('/r', () => 'post')
    app.put('/r', () => 'put')
    app.patch('/r', () => 'patch')
    app.delete('/r', () => 'delete')
    app.options('/r', () => 'options')
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(await (await send(app, '/r', { method })).text()).toBe(method.toLowerCase())
    }
  })

  test('awaits async handlers', async () => {
    const app = make().get('/slow', async () => {
      await Bun.sleep(1)
      return { done: true }
    })
    expect(await (await send(app, '/slow')).json()).toEqual({ done: true })
  })

  test('ignores the query string when matching', async () => {
    const app = make().get('/search', (ctx) => ctx.url.searchParams.get('q'))
    expect(await (await send(app, '/search?q=bun')).text()).toBe('bun')
  })

  test('exposes the route table', () => {
    const app = make().get('/a', () => null)
    app.post('/b', () => null)
    expect(app.routes()).toEqual([
      { method: 'GET', pattern: '/a' },
      { method: 'POST', pattern: '/b' },
    ])
  })
})

describe('404', () => {
  test('returns problem+json for an unknown path', async () => {
    const response = await send(make(), '/nope')
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8')
    expect(await response.json()).toMatchObject({ status: 404, title: 'Not Found' })
  })

  test('names the path that missed', async () => {
    const body = (await (await send(make(), '/missing')).json()) as { detail: string }
    expect(body.detail).toContain('/missing')
  })
})

describe('405', () => {
  test('rejects a wrong method with the allowed set', async () => {
    const app = make()
      .get('/users', () => 'list')
      .post('/users', () => 'create')
    const response = await send(app, '/users', { method: 'DELETE' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')?.split(', ').sort()).toEqual(['GET', 'POST'])
  })

  test('is a problem document, not a bare status', async () => {
    const app = make().get('/users', () => 'list')
    expect(await (await send(app, '/users', { method: 'PUT' })).json()).toMatchObject({
      status: 405,
      title: 'Method Not Allowed',
    })
  })

  test('prefers 404 when the path itself is unknown', async () => {
    const app = make().get('/users', () => 'list')
    expect((await send(app, '/other', { method: 'DELETE' })).status).toBe(404)
  })
})

describe('HEAD', () => {
  test('is served from the GET handler', async () => {
    const app = make().get('/page', () => 'body text')
    const response = await send(app, '/page', { method: 'HEAD' })
    expect(response.status).toBe(200)
  })

  test('carries the GET headers but no body', async () => {
    const app = make().get('/page', () => ({ a: 1 }))
    const response = await send(app, '/page', { method: 'HEAD' })
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await response.text()).toBe('')
  })

  test('an explicit HEAD route takes precedence', async () => {
    const app = make()
      .get('/page', () => 'from get')
      .head('/page', (ctx) => {
        ctx.set('x-source', 'head')
        return null
      })
    expect((await send(app, '/page', { method: 'HEAD' })).headers.get('x-source')).toBe('head')
  })

  test('still 404s when there is no GET either', async () => {
    expect((await send(make(), '/nothing', { method: 'HEAD' })).status).toBe(404)
  })
})

describe('OPTIONS', () => {
  test('answers automatically with Allow', async () => {
    const app = make()
      .get('/users', () => 'list')
      .post('/users', () => 'create')
    const response = await send(app, '/users', { method: 'OPTIONS' })
    expect(response.status).toBe(204)
    expect(response.headers.get('allow')?.split(', ').sort()).toEqual(['GET', 'OPTIONS', 'POST'])
  })

  test('an explicit OPTIONS route wins', async () => {
    const app = make()
      .get('/users', () => 'list')
      .options('/users', () => 'custom')
    expect(await (await send(app, '/users', { method: 'OPTIONS' })).text()).toBe('custom')
  })

  test('404s for an unknown path', async () => {
    expect((await send(make(), '/nope', { method: 'OPTIONS' })).status).toBe(404)
  })
})

describe('unsupported methods', () => {
  test('answers 501 rather than pretending the route is missing', async () => {
    const app = make().get('/r', () => 'ok')
    const response = await app.fetch(
      new Request('https://theoven.app/r', { method: 'PROPFIND' as string }),
    )
    expect(response.status).toBe(501)
  })
})

describe('errors', () => {
  test('renders a thrown OvenError with its status', async () => {
    const app = make().get('/gone', () => {
      throw new NotFound('User 7 does not exist')
    })
    const response = await send(app, '/gone')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ detail: 'User 7 does not exist' })
  })

  test('catches errors thrown asynchronously', async () => {
    const app = make().get('/async-fail', async () => {
      await Bun.sleep(1)
      throw new BadRequest('nope')
    })
    expect((await send(app, '/async-fail')).status).toBe(400)
  })

  test('catches a rejected promise', async () => {
    const app = make().get('/reject', () => Promise.reject(new BadRequest('rejected')))
    expect((await send(app, '/reject')).status).toBe(400)
  })

  test('turns an unexpected throw into a 500', async () => {
    const app = make().get('/boom', () => {
      throw new Error('undefined is not a function')
    })
    expect((await send(app, '/boom')).status).toBe(500)
  })

  test('surfaces the real message in development', async () => {
    const app = make({ development: true }).get('/boom', () => {
      throw new Error('db-primary unreachable')
    })
    expect(await (await send(app, '/boom')).json()).toMatchObject({
      detail: 'db-primary unreachable',
    })
  })

  // Production must not leak internals; this is the test that keeps that honest.
  test('withholds internals in production', async () => {
    const app = make({ development: false }).get('/boom', () => {
      throw new Error('postgres://user:hunter2@db-primary/app')
    })
    const body = await (await send(app, '/boom')).text()
    expect(body).not.toContain('hunter2')
    expect(body).not.toContain('db-primary')
  })

  test('an explicit OvenError message is shown even in production', async () => {
    const app = make({ development: false }).get('/bad', () => {
      throw new BadRequest('The `email` field is required.')
    })
    expect(await (await send(app, '/bad')).json()).toMatchObject({
      detail: 'The `email` field is required.',
    })
  })

  test('applies headers carried by the error', async () => {
    const app = make().get('/limited', () => {
      throw new OvenError(429, 'Too Many Requests', undefined, {
        headers: { 'retry-after': '30' },
      })
    })
    expect((await send(app, '/limited')).headers.get('retry-after')).toBe('30')
  })

  test('a custom onError handler replaces the body', async () => {
    const app = make({
      onError: (error) => ({ ok: false, code: error.status }),
    }).get('/boom', () => {
      throw new NotFound()
    })
    const response = await send(app, '/boom')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ ok: false, code: 404 })
  })

  test('onError returning undefined falls back to the default rendering', async () => {
    const app = make({ onError: () => undefined }).get('/boom', () => {
      throw new NotFound()
    })
    expect(await (await send(app, '/boom')).json()).toMatchObject({ title: 'Not Found' })
  })

  test('a throwing onError does not mask the original failure', async () => {
    const app = make({
      onError: () => {
        throw new Error('handler is broken')
      },
    }).get('/boom', () => {
      throw new NotFound('original problem')
    })
    const response = await send(app, '/boom')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ detail: 'original problem' })
  })
})

describe('request id', () => {
  test('echoes the id when a handler used it', async () => {
    const app = make().get('/traced', (ctx) => ctx.id)
    const response = await send(app, '/traced')
    expect(response.headers.get('x-request-id')).toBe(await response.clone().text())
  })

  test('adds no header when nothing read the id', async () => {
    const app = make().get('/plain', () => 'ok')
    expect((await send(app, '/plain')).headers.get('x-request-id')).toBeNull()
  })

  test('adopts an inbound id', async () => {
    const app = make().get('/traced', (ctx) => ctx.id)
    const response = await send(app, '/traced', { headers: { 'x-request-id': 'lb-42' } })
    expect(response.headers.get('x-request-id')).toBe('lb-42')
  })

  test('can be disabled', async () => {
    const app = make({ echoRequestId: false }).get('/traced', (ctx) => ctx.id)
    expect((await send(app, '/traced')).headers.get('x-request-id')).toBeNull()
  })

  test('includes the id in a problem document when the handler used it', async () => {
    const app = make().get('/boom', (ctx) => {
      void ctx.id
      throw new NotFound()
    })
    expect(await (await send(app, '/boom')).json()).toHaveProperty('requestId')
  })
})

describe('response shaping', () => {
  test('a handler can set the status', async () => {
    const app = make().post('/users', (ctx) => {
      ctx.status = 201
      return { id: 1 }
    })
    expect((await send(app, '/users', { method: 'POST' })).status).toBe(201)
  })

  test('a handler can set headers', async () => {
    const app = make().get('/list', (ctx) => {
      ctx.set('x-total-count', '42')
      return []
    })
    expect((await send(app, '/list')).headers.get('x-total-count')).toBe('42')
  })

  test('returning nothing yields 204', async () => {
    const app = make().delete('/users/:id', () => null)
    expect((await send(app, '/users/1', { method: 'DELETE' })).status).toBe(204)
  })

  test('a returned Response passes through', async () => {
    const app = make().get('/raw', () => new Response('custom', { status: 418 }))
    const response = await send(app, '/raw')
    expect(response.status).toBe(418)
    expect(await response.text()).toBe('custom')
  })

  test('redirect works end to end', async () => {
    const app = make().get('/old', (ctx) => ctx.redirect('/new', 301))
    const response = await send(app, '/old')
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('/new')
  })
})

describe('over a real socket', () => {
  test('serves requests on a bound port', async () => {
    const app = make().get('/ping', () => ({ pong: true }))
    await app.listen(0)
    const response = await fetch(`${app.url}ping`)
    expect(await response.json()).toEqual({ pong: true })
  })

  test('exposes the client ip', async () => {
    const app = make().get('/ip', (ctx) => ({ ip: ctx.ip }))
    await app.listen(0)
    const body = (await (await fetch(`${app.url}ip`)).json()) as { ip: string }
    expect(body.ip).toBeTruthy()
  })

  test('refuses a second listen', async () => {
    const app = make().get('/x', () => 'x')
    await app.listen(0)
    expect(app.listen(0)).rejects.toThrow(/already listening/)
  })

  test('url is undefined before listening', () => {
    expect(make().url).toBeUndefined()
  })
})

describe('graceful shutdown', () => {
  test('lets an in-flight request finish', async () => {
    let finished = false
    const app = make().get('/slow', async () => {
      await Bun.sleep(50)
      finished = true
      return 'done'
    })
    await app.listen(0)

    const pending = fetch(`${app.url}slow`)
    await Bun.sleep(10)
    const closing = app.close()

    expect(await (await pending).text()).toBe('done')
    await closing
    expect(finished).toBe(true)
  })

  test('rejects new requests with 503 and Retry-After while draining', async () => {
    const app = make().get('/slow', async () => {
      await Bun.sleep(40)
      return 'done'
    })
    const pending = app.fetch(new Request('https://theoven.app/slow'))
    await Bun.sleep(5)
    const closing = app.close()

    const rejected = await send(app, '/slow')
    expect(rejected.status).toBe(503)
    expect(rejected.headers.get('retry-after')).toBe('5')

    await pending
    await closing
  })

  test('runs shutdown hooks in registration order', async () => {
    const order: string[] = []
    const app = make()
    app.onShutdown(() => {
      order.push('first')
    })
    app.onShutdown(async () => {
      await Bun.sleep(1)
      order.push('second')
    })
    await app.close()
    expect(order).toEqual(['first', 'second'])
  })

  test('a failing hook does not stop the others', async () => {
    const order: string[] = []
    const app = make()
    app.onShutdown(() => {
      throw new Error('hook exploded')
    })
    app.onShutdown(() => {
      order.push('still ran')
    })
    await app.close()
    expect(order).toEqual(['still ran'])
  })

  test('gives up after the timeout rather than hanging forever', async () => {
    const app = make().get('/forever', async () => {
      await Bun.sleep(5_000)
      return 'never'
    })
    void app.fetch(new Request('https://theoven.app/forever'))
    await Bun.sleep(5)

    const start = Bun.nanoseconds()
    await app.close({ timeout: 30 })
    const elapsedMs = (Bun.nanoseconds() - start) / 1e6
    expect(elapsedMs).toBeLessThan(1_000)
  })

  test('closing twice is safe', async () => {
    const app = make()
    await app.close()
    expect(app.close()).resolves.toBeUndefined()
  })

  test('returns promptly when nothing is in flight', async () => {
    const app = make().get('/x', () => 'x')
    await app.listen(0)
    const start = Bun.nanoseconds()
    await app.close()
    expect((Bun.nanoseconds() - start) / 1e6).toBeLessThan(500)
  })
})

describe('configuration', () => {
  test('createApp and new App agree', () => {
    expect(createApp({ logger: silentLogger })).toBeInstanceOf(App)
  })

  test('exposes the base logger for bricks', () => {
    expect(make({ logger: silentLogger }).logger).toBe(silentLogger)
  })

  test('honours a custom request id header', async () => {
    const app = make({ requestIdHeader: 'x-trace' }).get('/t', (ctx) => ctx.id)
    const response = await send(app, '/t', { headers: { 'x-trace': 'trace-1' } })
    expect(response.headers.get('x-trace')).toBe('trace-1')
  })

  test('rejects duplicate route registration at startup, not at request time', () => {
    const app = make().get('/dup', () => 'a')
    expect(() => app.get('/dup', () => 'b')).toThrow()
  })
})
