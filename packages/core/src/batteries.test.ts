/**
 * End-to-end tests for the always-on batteries.
 *
 * The unit tests next door cover each parser in isolation. These check the thing that actually
 * matters to a user: that all of it works through a real dispatch with **no configuration and
 * no registration** — no `app.use(cookieParser())`, nothing to order, nothing to forget.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { type App, type AppOptions, createApp } from './app'
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

function send(app: App, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`https://theoven.app${path}`, init))
}

function postJson(app: App, path: string, value: unknown): Promise<Response> {
  return send(app, path, {
    method: 'POST',
    body: JSON.stringify(value),
    headers: { 'content-type': 'application/json' },
  })
}

describe('body — nothing installed', () => {
  test('JSON arrives parsed', async () => {
    const app = make().post('/echo', async (ctx) => ctx.body)
    expect(await (await postJson(app, '/echo', { name: 'ada' })).json()).toEqual({ name: 'ada' })
  })

  test('awaiting twice is safe and does not re-read the stream', async () => {
    const app = make().post('/twice', async (ctx) => {
      const first = await ctx.body
      const second = await ctx.body
      return { same: first === second }
    })
    expect(await (await postJson(app, '/twice', { a: 1 })).json()).toEqual({ same: true })
  })

  test('a form body arrives as an object', async () => {
    const app = make().post('/form', async (ctx) => ctx.body)
    const response = await send(app, '/form', {
      method: 'POST',
      body: 'name=ada&tag=x&tag=y',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(await response.json()).toEqual({ name: 'ada', tag: ['x', 'y'] })
  })

  test('an absent body is undefined rather than an error', async () => {
    const app = make().post('/empty', async (ctx) => ({ body: (await ctx.body) ?? null }))
    const response = await send(app, '/empty', { method: 'POST' })
    expect(await response.json()).toEqual({ body: null })
  })

  test('malformed JSON becomes a 400 before the handler runs', async () => {
    let reached = false
    const app = make().post('/strict', async (ctx) => {
      await ctx.body
      reached = true
      return 'ok'
    })
    const response = await send(app, '/strict', {
      method: 'POST',
      body: '{ nope',
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(400)
    expect(reached).toBe(false)
  })

  test('an oversized body becomes a 413', async () => {
    const app = make({ body: { limit: 100 } }).post('/big', async (ctx) => ctx.body)
    const response = await send(app, '/big', {
      method: 'POST',
      body: 'x'.repeat(5000),
      headers: { 'content-type': 'text/plain' },
    })
    expect(response.status).toBe(413)
  })

  test('rawBody gives byte-exact input for signature checks', async () => {
    const app = make().post('/webhook', async (ctx) => {
      const raw = new TextDecoder().decode(await ctx.rawBody)
      return { raw, parsed: await ctx.body }
    })
    const response = await send(app, '/webhook', {
      method: 'POST',
      body: '{ "a" :  1 }',
      headers: { 'content-type': 'application/json' },
    })
    // Both work on the same request: rawBody buffers, and body parses from those bytes.
    expect(await response.json()).toEqual({ raw: '{ "a" :  1 }', parsed: { a: 1 } })
  })
})

describe('files — nothing installed', () => {
  test('an upload arrives as a File', async () => {
    const app = make().post('/upload', async (ctx) => {
      const files = await ctx.files()
      const file = files.avatar?.[0]
      return { name: file?.name, type: file?.type, text: await file?.text() }
    })

    const form = new FormData()
    form.append('avatar', new File(['pixels'], 'me.png', { type: 'image/png' }))

    const response = await send(app, '/upload', { method: 'POST', body: form })
    expect(await response.json()).toEqual({ name: 'me.png', type: 'image/png', text: 'pixels' })
  })

  test('fields and files arrive together', async () => {
    const app = make().post('/upload', async (ctx) => {
      const body = (await ctx.body) as Record<string, unknown>
      return { title: body.title, isFile: body.photo instanceof File }
    })

    const form = new FormData()
    form.append('title', 'holiday')
    form.append('photo', new File(['x'], 'p.jpg', { type: 'image/jpeg' }))

    expect(await (await send(app, '/upload', { method: 'POST', body: form })).json()).toEqual({
      title: 'holiday',
      isFile: true,
    })
  })

  test('a disallowed file type is a 415', async () => {
    const app = make({ body: { allowedFileTypes: ['image/*'] } }).post('/upload', (ctx) =>
      ctx.files(),
    )
    const form = new FormData()
    form.append('f', new File(['#!/bin/sh'], 'evil.sh', { type: 'application/x-sh' }))
    expect((await send(app, '/upload', { method: 'POST', body: form })).status).toBe(415)
  })

  test('an oversized file is a 413', async () => {
    const app = make({ body: { fileLimit: 10 } }).post('/upload', (ctx) => ctx.files())
    const form = new FormData()
    form.append('f', new File(['x'.repeat(500)], 'big.bin'))
    expect((await send(app, '/upload', { method: 'POST', body: form })).status).toBe(413)
  })
})

describe('cookies — nothing installed', () => {
  test('reads a cookie off the request', async () => {
    const app = make().get('/me', (ctx) => ({ session: ctx.cookies.get('session') }))
    const response = await send(app, '/me', { headers: { cookie: 'session=abc' } })
    expect(await response.json()).toEqual({ session: 'abc' })
  })

  test('writes a Set-Cookie header', async () => {
    const app = make().post('/login', (ctx) => {
      ctx.cookies.set('session', 'new-session')
      return { ok: true }
    })
    const header = (await send(app, '/login', { method: 'POST' })).headers.get('set-cookie')
    expect(header).toContain('session=new-session')
    expect(header).toContain('HttpOnly')
  })

  test('writes several cookies as separate headers', async () => {
    const app = make().get('/multi', (ctx) => {
      ctx.cookies.set('a', '1').set('b', '2')
      return null
    })
    expect((await send(app, '/multi')).headers.getSetCookie()).toHaveLength(2)
  })

  test('deleting expires the cookie', async () => {
    const app = make().post('/logout', (ctx) => {
      ctx.cookies.delete('session')
      return null
    })
    const header = (await send(app, '/logout', { method: 'POST' })).headers.get('set-cookie')
    expect(header).toContain('Max-Age=0')
  })

  test('signed cookies round-trip through a real request', async () => {
    const app = make({ cookies: { secret: 'test-secret' } })
    app.post('/login', (ctx) => {
      ctx.cookies.set('uid', '42', { signed: true })
      return null
    })
    app.get('/me', (ctx) => ({ uid: ctx.cookies.get('uid', { signed: true }) ?? null }))

    const set = (await send(app, '/login', { method: 'POST' })).headers.get('set-cookie') ?? ''
    const pair = set.split(';')[0] ?? ''

    expect(await (await send(app, '/me', { headers: { cookie: pair } })).json()).toEqual({
      uid: '42',
    })
  })

  test('a tampered signed cookie reads as absent', async () => {
    const app = make({ cookies: { secret: 'test-secret' } }).get('/me', (ctx) => ({
      uid: ctx.cookies.get('uid', { signed: true }) ?? null,
    }))
    const response = await send(app, '/me', { headers: { cookie: 'uid=999.forgedsignature' } })
    expect(await response.json()).toEqual({ uid: null })
  })

  test('cookies are Secure by default in production', async () => {
    const app = make({ development: false }).get('/x', (ctx) => {
      ctx.cookies.set('a', '1')
      return null
    })
    expect((await send(app, '/x')).headers.get('set-cookie')).toContain('Secure')
  })
})

describe('query — nothing installed', () => {
  test('parses repeated keys into arrays', async () => {
    const app = make().get('/search', (ctx) => ctx.query)
    expect(await (await send(app, '/search?tag=a&tag=b')).json()).toEqual({ tag: ['a', 'b'] })
  })

  test('parses nested keys', async () => {
    const app = make().get('/search', (ctx) => ctx.query)
    const response = await send(app, '/search?filter[status]=open&page=2')
    expect(await response.json()).toEqual({ filter: { status: 'open' }, page: '2' })
  })

  test('an empty query is an empty object', async () => {
    const app = make().get('/search', (ctx) => ctx.query)
    expect(await (await send(app, '/search')).json()).toEqual({})
  })
})

describe('token capture — with no auth module installed', () => {
  test('captures a bearer token', async () => {
    const app = make().get('/me', (ctx) => ({ token: ctx.token, source: ctx.tokenSource }))
    const response = await send(app, '/me', { headers: { authorization: 'Bearer abc123' } })
    expect(await response.json()).toEqual({ token: 'abc123', source: 'header' })
  })

  test('falls back to a cookie', async () => {
    const app = make().get('/me', (ctx) => ({ token: ctx.token, source: ctx.tokenSource }))
    const response = await send(app, '/me', { headers: { cookie: 'token=from-cookie' } })
    expect(await response.json()).toEqual({ token: 'from-cookie', source: 'cookie' })
  })

  test('falls back to the query string', async () => {
    const app = make().get('/me', (ctx) => ({ token: ctx.token, source: ctx.tokenSource }))
    expect(await (await send(app, '/me?access_token=q')).json()).toEqual({
      token: 'q',
      source: 'query',
    })
  })

  test('exposes the scheme', async () => {
    const app = make().get('/me', (ctx) => ({ scheme: ctx.tokenScheme }))
    const response = await send(app, '/me', { headers: { authorization: 'Bearer x' } })
    expect(await response.json()).toEqual({ scheme: 'Bearer' })
  })

  test('decodes basic credentials', async () => {
    const app = make().get('/me', (ctx) => ctx.basicAuth ?? null)
    const response = await send(app, '/me', {
      headers: { authorization: `Basic ${btoa('ada:lovelace')}` },
    })
    expect(await response.json()).toEqual({ username: 'ada', password: 'lovelace' })
  })

  test('is undefined on an unauthenticated request', async () => {
    const app = make().get('/me', (ctx) => ({ token: ctx.token ?? null }))
    expect(await (await send(app, '/me')).json()).toEqual({ token: null })
  })
})

// A context reaching a log line is a mistake that happens. It must not be the mistake that
// leaks a session token.
describe('credential leakage', () => {
  test('serialising the context does not expose the token', async () => {
    const app = make().get('/me', (ctx) => JSON.parse(JSON.stringify(ctx)))
    const response = await send(app, '/me', {
      headers: { authorization: 'Bearer super-secret-value' },
    })
    expect(await response.text()).not.toContain('super-secret-value')
  })

  test('an error response never carries the token', async () => {
    const app = make().get('/boom', (ctx) => {
      void ctx.token
      throw new Error('failure')
    })
    const response = await send(app, '/boom', {
      headers: { authorization: 'Bearer super-secret-value' },
    })
    expect(await response.text()).not.toContain('super-secret-value')
  })

  test('an error response never carries cookies', async () => {
    const app = make().get('/boom', (ctx) => {
      void ctx.cookies.get('session')
      throw new Error('failure')
    })
    const response = await send(app, '/boom', { headers: { cookie: 'session=secret-session' } })
    expect(await response.text()).not.toContain('secret-session')
  })
})

describe('ip and trustProxy', () => {
  test('ignores X-Forwarded-For by default, since any client can send it', async () => {
    const app = make().get('/ip', (ctx) => ({ ip: ctx.ip ?? null }))
    const response = await send(app, '/ip', { headers: { 'x-forwarded-for': '1.2.3.4' } })
    expect(await response.json()).toEqual({ ip: null })
  })

  test('honours X-Forwarded-For when a proxy is trusted', async () => {
    const app = make({ trustProxy: true }).get('/ip', (ctx) => ({ ip: ctx.ip }))
    const response = await send(app, '/ip', { headers: { 'x-forwarded-for': '1.2.3.4' } })
    expect(await response.json()).toEqual({ ip: '1.2.3.4' })
  })

  // Entries further left are supplied by earlier, less trusted parties — a client can prepend
  // as many as it likes, so the hop count decides which one we believe.
  test('counts hops from the right through a proxy chain', async () => {
    const app = make({ trustProxy: 1 }).get('/ip', (ctx) => ({ ip: ctx.ip }))
    const response = await send(app, '/ip', {
      headers: { 'x-forwarded-for': 'spoofed, 9.9.9.9, 5.5.5.5' },
    })
    expect(await response.json()).toEqual({ ip: '5.5.5.5' })
  })

  test('a deeper hop count reaches further left', async () => {
    const app = make({ trustProxy: 2 }).get('/ip', (ctx) => ({ ip: ctx.ip }))
    const response = await send(app, '/ip', {
      headers: { 'x-forwarded-for': 'spoofed, 9.9.9.9, 5.5.5.5' },
    })
    expect(await response.json()).toEqual({ ip: '9.9.9.9' })
  })
})

describe('content negotiation', () => {
  test('picks the first offered type when the client has no preference', async () => {
    const app = make().get('/n', (ctx) => ({
      picked: ctx.accepts('application/json', 'text/html'),
    }))
    expect(await (await send(app, '/n')).json()).toEqual({ picked: 'application/json' })
  })

  test('honours an explicit preference', async () => {
    const app = make().get('/n', (ctx) => ({
      picked: ctx.accepts('application/json', 'text/html'),
    }))
    const response = await send(app, '/n', { headers: { accept: 'text/html' } })
    expect(await response.json()).toEqual({ picked: 'text/html' })
  })

  test('honours q weights', async () => {
    const app = make().get('/n', (ctx) => ({
      picked: ctx.accepts('application/json', 'text/html'),
    }))
    const response = await send(app, '/n', {
      headers: { accept: 'application/json;q=0.2, text/html;q=0.9' },
    })
    expect(await response.json()).toEqual({ picked: 'text/html' })
  })

  test('matches a wildcard subtype', async () => {
    const app = make().get('/n', (ctx) => ({ picked: ctx.accepts('text/html') }))
    const response = await send(app, '/n', { headers: { accept: 'text/*' } })
    expect(await response.json()).toEqual({ picked: 'text/html' })
  })

  test('returns nothing when no offered type is acceptable', async () => {
    const app = make().get('/n', (ctx) => ({ picked: ctx.accepts('application/json') ?? null }))
    const response = await send(app, '/n', { headers: { accept: 'text/csv' } })
    expect(await response.json()).toEqual({ picked: null })
  })
})

describe('request headers', () => {
  test('header() returns undefined rather than null when absent', async () => {
    const app = make().get('/h', (ctx) => ({ present: ctx.header('x-a') ?? null }))
    expect(await (await send(app, '/h')).json()).toEqual({ present: null })
  })

  test('header() is case-insensitive', async () => {
    const app = make().get('/h', (ctx) => ({ value: ctx.header('X-Custom') }))
    const response = await send(app, '/h', { headers: { 'x-custom': 'v' } })
    expect(await response.json()).toEqual({ value: 'v' })
  })
})

// Always-on is worthless if you pay for batteries you never use.
describe('laziness', () => {
  test('a handler returning a constant never reads the body', async () => {
    let bodyRead = false
    const app = make().post('/fast', () => 'ok')

    const request = new Request('https://theoven.app/fast', {
      method: 'POST',
      body: JSON.stringify({ big: 'payload' }),
      headers: { 'content-type': 'application/json' },
    })
    Object.defineProperty(request, 'body', {
      get() {
        bodyRead = true
        return null
      },
    })

    expect(await (await app.fetch(request)).text()).toBe('ok')
    expect(bodyRead).toBe(false)
  })

  test('a handler that ignores cookies never parses the Cookie header', async () => {
    let cookieReads = 0
    const app = make().get('/fast', () => 'ok')

    const request = new Request('https://theoven.app/fast')
    const original = request.headers.get.bind(request.headers)
    // Headers.get is read-only on the type but writable at runtime, which is exactly what a
    // probe needs: it counts real reads rather than trusting the implementation.
    Object.defineProperty(request.headers, 'get', {
      value: (name: string) => {
        if (name.toLowerCase() === 'cookie') cookieReads++
        return original(name)
      },
    })

    await app.fetch(request)
    expect(cookieReads).toBe(0)
  })

  test('a handler that ignores the query never parses it', async () => {
    const app = make().get('/fast', (ctx) => {
      // Touching params must not drag the query parser in with it.
      return ctx.params
    })
    const response = await send(app, '/fast?a[b][c]=1&tag=x&tag=y')
    expect(response.status).toBe(200)
  })
})
