import { afterEach, describe, expect, test } from 'bun:test'
import { type App, type AppOptions, createApp } from './app'
import { Unauthorized } from './errors'
import { silentLogger } from './logger'
import {
  appliesTo,
  compression,
  cors,
  rateLimit,
  requestLogger,
  securityHeaders,
} from './middleware'

const opened: App[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 100 })))
})

function make(options: AppOptions = {}): App {
  const app = createApp({ logger: silentLogger, development: true, ...options })
  opened.push(app)
  return app
}

function send(app: App, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`https://theoven.app${path}`, init))
}

describe('ordering', () => {
  test('runs in registration order on the way in, reversed on the way out', async () => {
    const order: string[] = []
    const app = make()
    app.use(async (_ctx, next) => {
      order.push('a-in')
      const result = await next()
      order.push('a-out')
      return result
    })
    app.use(async (_ctx, next) => {
      order.push('b-in')
      const result = await next()
      order.push('b-out')
      return result
    })
    app.get('/x', () => {
      order.push('handler')
      return 'ok'
    })

    await send(app, '/x')
    expect(order).toEqual(['a-in', 'b-in', 'handler', 'b-out', 'a-out'])
  })

  test('sees the handler result through next()', async () => {
    const app = make()
    app.use(async (_ctx, next) => ({ wrapped: await next() }))
    app.get('/x', () => 'inner')
    expect(await (await send(app, '/x')).json()).toEqual({ wrapped: 'inner' })
  })

  test('can modify the context before the handler', async () => {
    const app = make()
    app.use(async (ctx, next) => {
      ctx.set('x-added', 'yes')
      return next()
    })
    app.get('/x', () => 'ok')
    expect((await send(app, '/x')).headers.get('x-added')).toBe('yes')
  })
})

describe('short-circuiting', () => {
  test('not calling next skips the handler entirely', async () => {
    let reached = false
    const app = make()
    app.use(async () => 'from middleware')
    app.get('/x', () => {
      reached = true
      return 'from handler'
    })

    expect(await (await send(app, '/x')).text()).toBe('from middleware')
    expect(reached).toBe(false)
  })

  test('a thrown error is handled like any other', async () => {
    const app = make()
    app.use(async () => {
      throw new Unauthorized('no token')
    })
    app.get('/x', () => 'ok')

    const response = await send(app, '/x')
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ detail: 'no token' })
  })

  test('an async throw after next() is caught', async () => {
    const app = make()
    app.use(async (_ctx, next) => {
      await next()
      throw new Unauthorized('after')
    })
    app.get('/x', () => 'ok')
    expect((await send(app, '/x')).status).toBe(401)
  })

  // Awaiting next() twice runs the rest of the chain again; the resulting double-write is very
  // hard to trace back to its cause, so it fails loudly instead.
  test('calling next twice is an error', async () => {
    const app = make()
    app.use(async (_ctx, next) => {
      await next()
      return next()
    })
    app.get('/x', () => 'ok')
    expect((await send(app, '/x')).status).toBe(500)
  })
})

describe('path scoping', () => {
  test('applies only under its prefix', async () => {
    const app = make()
    app.use('/admin', async (ctx, next) => {
      ctx.set('x-admin', 'yes')
      return next()
    })
    app.get('/admin/users', () => 'admin')
    app.get('/public', () => 'public')

    expect((await send(app, '/admin/users')).headers.get('x-admin')).toBe('yes')
    expect((await send(app, '/public')).headers.get('x-admin')).toBeNull()
  })

  test('matches the prefix itself', async () => {
    const app = make()
    app.use('/admin', async (ctx, next) => {
      ctx.set('x-admin', 'yes')
      return next()
    })
    app.get('/admin', () => 'root')
    expect((await send(app, '/admin')).headers.get('x-admin')).toBe('yes')
  })

  // /admin must not match /administrators.
  test('respects segment boundaries', () => {
    expect(appliesTo('/admin', '/admin')).toBe(true)
    expect(appliesTo('/admin', '/admin/users')).toBe(true)
    expect(appliesTo('/admin', '/administrators')).toBe(false)
    expect(appliesTo('/admin', '/adm')).toBe(false)
    expect(appliesTo(undefined, '/anything')).toBe(true)
    expect(appliesTo('/', '/anything')).toBe(true)
  })

  test('middleware added after a route still applies to it', async () => {
    const app = make()
    app.get('/x', () => 'ok')
    app.use(async (ctx, next) => {
      ctx.set('x-late', 'yes')
      return next()
    })
    expect((await send(app, '/x')).headers.get('x-late')).toBe('yes')
  })
})

describe('lifecycle hooks', () => {
  test('onRequest runs before routing and can short-circuit', async () => {
    const app = make()
    app.onRequest((ctx) => (ctx.path === '/blocked' ? 'denied' : undefined))
    app.get('/blocked', () => 'never')
    app.get('/allowed', () => 'yes')

    expect(await (await send(app, '/blocked')).text()).toBe('denied')
    expect(await (await send(app, '/allowed')).text()).toBe('yes')
  })

  // Maintenance mode should not depend on a route happening to exist.
  test('onRequest runs even for paths that do not match a route', async () => {
    const app = make()
    app.onRequest(() => 'maintenance')
    expect(await (await send(app, '/nothing-here')).text()).toBe('maintenance')
  })

  test('beforeHandle sees route params', async () => {
    const seen: string[] = []
    const app = make()
    app.beforeHandle((ctx) => {
      seen.push(ctx.params.id ?? 'none')
    })
    app.get('/users/:id', () => 'ok')

    await send(app, '/users/42')
    expect(seen).toEqual(['42'])
  })

  test('beforeHandle can skip the handler', async () => {
    let reached = false
    const app = make()
    app.beforeHandle(() => 'cached')
    app.get('/x', () => {
      reached = true
      return 'fresh'
    })

    expect(await (await send(app, '/x')).text()).toBe('cached')
    expect(reached).toBe(false)
  })

  test('afterHandle transforms the result', async () => {
    const app = make()
    app.afterHandle((_ctx, result) => ({ data: result }))
    app.get('/x', () => ({ id: 1 }))
    expect(await (await send(app, '/x')).json()).toEqual({ data: { id: 1 } })
  })

  test('afterHandle returning undefined leaves the result alone', async () => {
    const app = make()
    app.afterHandle(() => undefined)
    app.get('/x', () => 'untouched')
    expect(await (await send(app, '/x')).text()).toBe('untouched')
  })

  test('onResponse can replace the response', async () => {
    const app = make()
    app.onResponse(() => new Response('replaced', { status: 418 }))
    app.get('/x', () => 'original')

    const response = await send(app, '/x')
    expect(response.status).toBe(418)
    expect(await response.text()).toBe('replaced')
  })

  test('onResponse can inspect without replacing', async () => {
    const seen: number[] = []
    const app = make()
    app.onResponse((_ctx, response) => {
      seen.push(response.status)
    })
    app.get('/x', () => 'ok')

    await send(app, '/x')
    expect(seen).toEqual([200])
  })

  test('hooks run in registration order', async () => {
    const order: string[] = []
    const app = make()
    app.beforeHandle(() => {
      order.push('first')
    })
    app.beforeHandle(() => {
      order.push('second')
    })
    app.get('/x', () => 'ok')

    await send(app, '/x')
    expect(order).toEqual(['first', 'second'])
  })

  test('a hook throwing is handled like a handler throwing', async () => {
    const app = make()
    app.beforeHandle(() => {
      throw new Unauthorized('guard')
    })
    app.get('/x', () => 'ok')
    expect((await send(app, '/x')).status).toBe(401)
  })

  test('onError replaces the rendering', async () => {
    const app = make()
    app.onError((error) => ({ code: error.status }))
    app.get('/x', () => {
      throw new Unauthorized()
    })
    expect(await (await send(app, '/x')).json()).toEqual({ code: 401 })
  })
})

describe('cors', () => {
  test('reflects an allowed origin', async () => {
    const app = make().use(cors({ origin: ['https://app.example'] }))
    app.get('/x', () => 'ok')
    const response = await send(app, '/x', { headers: { origin: 'https://app.example' } })
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example')
  })

  test('omits the header for a disallowed origin', async () => {
    const app = make().use(cors({ origin: ['https://app.example'] }))
    app.get('/x', () => 'ok')
    const response = await send(app, '/x', { headers: { origin: 'https://evil.example' } })
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('a wildcard allows anything', async () => {
    const app = make().use(cors())
    app.get('/x', () => 'ok')
    const response = await send(app, '/x', { headers: { origin: 'https://anywhere.example' } })
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  test('accepts a predicate', async () => {
    const app = make().use(cors({ origin: (o) => o.endsWith('.trusted.example') }))
    app.get('/x', () => 'ok')
    const ok = await send(app, '/x', { headers: { origin: 'https://a.trusted.example' } })
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://a.trusted.example')
  })

  // A response that varies by Origin must say so, or a shared cache serves one origin's
  // response to another.
  test('sets Vary: Origin when the origin is reflected', async () => {
    const app = make().use(cors({ origin: ['https://app.example'] }))
    app.get('/x', () => 'ok')
    const response = await send(app, '/x', { headers: { origin: 'https://app.example' } })
    expect(response.headers.get('vary')).toContain('Origin')
  })

  test('answers a preflight with 204 and the allowed methods', async () => {
    const app = make().use(cors({ origin: '*', methods: ['GET', 'POST'] }))
    app.get('/x', () => 'ok')
    const response = await send(app, '/x', {
      method: 'OPTIONS',
      headers: { origin: 'https://a.example', 'access-control-request-method': 'POST' },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST')
  })

  test('echoes requested headers on a preflight when none are configured', async () => {
    const app = make().use(cors())
    app.get('/x', () => 'ok')
    const response = await send(app, '/x', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://a.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-custom, authorization',
      },
    })
    expect(response.headers.get('access-control-allow-headers')).toBe('x-custom, authorization')
  })

  test('sets credentials when asked', async () => {
    const app = make().use(cors({ origin: ['https://a.example'], credentials: true }))
    app.get('/x', () => 'ok')
    const response = await send(app, '/x', { headers: { origin: 'https://a.example' } })
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
  })

  // Browsers reject a wildcard origin on credentialed requests, so this misconfiguration would
  // fail at runtime looking like a server bug.
  test('refuses wildcard plus credentials at construction', () => {
    expect(() => cors({ origin: '*', credentials: true })).toThrow(/wildcard/)
  })

  test('does nothing when there is no Origin header', async () => {
    const app = make().use(cors())
    app.get('/x', () => 'ok')
    expect((await send(app, '/x')).headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('securityHeaders', () => {
  test('sets the defaults', async () => {
    const app = make().use(securityHeaders())
    app.get('/x', () => 'ok')
    const response = await send(app, '/x')

    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(response.headers.get('permissions-policy')).toContain('geolocation=()')
  })

  test('sets HSTS over https', async () => {
    const app = make().use(securityHeaders({ hsts: 600 }))
    app.get('/x', () => 'ok')
    const response = await send(app, '/x')
    expect(response.headers.get('strict-transport-security')).toContain('max-age=600')
  })

  // Sending HSTS on plain http would pin localhost to https in the browser for a year.
  test('omits HSTS over plain http', async () => {
    const app = make().use(securityHeaders())
    app.get('/x', () => 'ok')
    const response = await app.fetch(new Request('http://localhost/x'))
    expect(response.headers.get('strict-transport-security')).toBeNull()
  })

  test('individual headers can be turned off', async () => {
    const app = make().use(securityHeaders({ frameOptions: false, referrerPolicy: false }))
    app.get('/x', () => 'ok')
    const response = await send(app, '/x')
    expect(response.headers.get('x-frame-options')).toBeNull()
    expect(response.headers.get('referrer-policy')).toBeNull()
  })

  test('sets a CSP when given one', async () => {
    const app = make().use(securityHeaders({ contentSecurityPolicy: "default-src 'self'" }))
    app.get('/x', () => 'ok')
    expect((await send(app, '/x')).headers.get('content-security-policy')).toBe(
      "default-src 'self'",
    )
  })
})

describe('rateLimit', () => {
  test('allows requests under the limit', async () => {
    const app = make().use(rateLimit({ limit: 3, key: () => 'fixed' }))
    app.get('/x', () => 'ok')
    for (let i = 0; i < 3; i++) {
      expect((await send(app, '/x')).status).toBe(200)
    }
  })

  test('rejects past the limit with 429 and Retry-After', async () => {
    const app = make().use(rateLimit({ limit: 2, key: () => 'fixed' }))
    app.get('/x', () => 'ok')
    await send(app, '/x')
    await send(app, '/x')

    const response = await send(app, '/x')
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBeTruthy()
  })

  test('reports the remaining budget', async () => {
    const app = make().use(rateLimit({ limit: 5, key: () => 'fixed' }))
    app.get('/x', () => 'ok')
    const response = await send(app, '/x')
    expect(response.headers.get('ratelimit-limit')).toBe('5')
    expect(response.headers.get('ratelimit-remaining')).toBe('4')
  })

  test('counts each key separately', async () => {
    let who = 'a'
    const app = make().use(rateLimit({ limit: 1, key: () => who }))
    app.get('/x', () => 'ok')

    expect((await send(app, '/x')).status).toBe(200)
    expect((await send(app, '/x')).status).toBe(429)
    who = 'b'
    expect((await send(app, '/x')).status).toBe(200)
  })

  test('resets after the window', async () => {
    const app = make().use(rateLimit({ limit: 1, window: 30, key: () => 'fixed' }))
    app.get('/x', () => 'ok')
    expect((await send(app, '/x')).status).toBe(200)
    expect((await send(app, '/x')).status).toBe(429)
    await Bun.sleep(45)
    expect((await send(app, '/x')).status).toBe(200)
  })

  test('skip bypasses the limiter', async () => {
    const app = make().use(rateLimit({ limit: 1, key: () => 'fixed', skip: () => true }))
    app.get('/x', () => 'ok')
    expect((await send(app, '/x')).status).toBe(200)
    expect((await send(app, '/x')).status).toBe(200)
  })

  // Limiting everyone together would be worse than not limiting at all.
  test('does not limit when no key can be derived', async () => {
    const app = make().use(rateLimit({ limit: 1, key: () => undefined }))
    app.get('/x', () => 'ok')
    expect((await send(app, '/x')).status).toBe(200)
    expect((await send(app, '/x')).status).toBe(200)
  })
})

describe('requestLogger', () => {
  test('logs one line per request', async () => {
    const lines: Array<Record<string, unknown>> = []
    const recorder = {
      debug() {},
      info(message: string, fields?: Record<string, unknown>) {
        lines.push({ message, ...fields })
      },
      warn() {},
      error() {},
      child() {
        return recorder
      },
    }

    const app = make({ logger: recorder }).use(requestLogger())
    app.get('/x', () => 'ok')
    await send(app, '/x')

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ method: 'GET', path: '/x', status: 200 })
  })

  test('skips ignored paths, so health checks do not dominate the log', async () => {
    const lines: unknown[] = []
    const recorder = {
      debug() {},
      info() {
        lines.push(1)
      },
      warn() {},
      error() {},
      child() {
        return recorder
      },
    }

    const app = make({ logger: recorder }).use(requestLogger({ ignore: ['/health'] }))
    app.get('/health', () => 'ok')
    await send(app, '/health')
    expect(lines).toHaveLength(0)
  })
})

describe('compression', () => {
  test('compresses a large text response when the client accepts gzip', async () => {
    const app = make().use(compression({ threshold: 0 }))
    app.get('/x', () => 'x'.repeat(5000))

    const response = await send(app, '/x', { headers: { 'accept-encoding': 'gzip' } })
    expect(response.headers.get('content-encoding')).toBe('gzip')

    // The body is genuinely gzipped: `.text()` on a locally-built Response does not decode it,
    // since that normally happens in the HTTP client. Unzip it to prove the round trip.
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(bytes.byteLength).toBeLessThan(5000)
    expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toHaveLength(5000)
  })

  test('leaves a small response uncompressed', async () => {
    const app = make().use(compression({ threshold: 1024 }))
    app.get('/x', () => 'tiny')
    const response = await send(app, '/x', { headers: { 'accept-encoding': 'gzip' } })
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(await response.text()).toBe('tiny')
  })

  // Buffering a stream to compress it would stop server-sent events arriving and pull a large
  // download entirely into memory. Bun has no CompressionStream, so passing through is honest.
  test('passes streaming responses through untouched', async () => {
    const app = make().use(compression({ threshold: 0 }))
    app.get(
      '/x',
      () =>
        new Response('x'.repeat(5000), {
          headers: { 'content-type': 'text/plain' },
        }),
    )
    const response = await send(app, '/x', { headers: { 'accept-encoding': 'gzip' } })
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(await response.text()).toHaveLength(5000)
  })

  test('leaves the response alone when the client cannot decode it', async () => {
    const app = make().use(compression({ threshold: 0 }))
    app.get('/x', () => 'x'.repeat(5000))
    const response = await send(app, '/x')
    expect(response.headers.get('content-encoding')).toBeNull()
  })

  // Compressing an already-compressed image burns CPU to make the response slightly larger.
  test('leaves non-compressible types alone', async () => {
    const app = make().use(compression({ threshold: 0 }))
    app.get(
      '/x',
      () =>
        new Response(new Uint8Array(5000), {
          headers: { 'content-type': 'image/png' },
        }),
    )
    const response = await send(app, '/x', { headers: { 'accept-encoding': 'gzip' } })
    expect(response.headers.get('content-encoding')).toBeNull()
  })

  test('sets Vary: Accept-Encoding so caches stay correct', async () => {
    const app = make().use(compression({ threshold: 0 }))
    app.get('/x', () => 'x'.repeat(5000))
    const response = await send(app, '/x', { headers: { 'accept-encoding': 'gzip' } })
    expect(response.headers.get('vary')).toContain('Accept-Encoding')
  })
})
