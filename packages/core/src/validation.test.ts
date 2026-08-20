import { afterEach, describe, expect, expectTypeOf, test } from 'bun:test'
import * as v from 'valibot'
import { z } from 'zod'
import { type App, type AppOptions, createApp } from './app'
import { silentLogger } from './logger'
import { formatPath } from './standard-schema'
import type { ValidationIssue } from './validation'

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

/** Reads the issue list out of a 422 problem document. */
async function issuesOf(response: Response): Promise<ValidationIssue[]> {
  const body = (await response.json()) as { errors?: ValidationIssue[] }
  return body.errors ?? []
}

describe('body validation', () => {
  test('a valid body reaches the handler already parsed', async () => {
    const app = make().post(
      '/users',
      { body: z.object({ name: z.string(), age: z.number() }) },
      (ctx) => ctx.body,
    )
    expect(await (await postJson(app, '/users', { name: 'ada', age: 36 })).json()).toEqual({
      name: 'ada',
      age: 36,
    })
  })

  test('an invalid body is a 422 and never reaches the handler', async () => {
    let reached = false
    const app = make().post('/users', { body: z.object({ name: z.string() }) }, () => {
      reached = true
      return 'ok'
    })

    const response = await postJson(app, '/users', { name: 42 })
    expect(response.status).toBe(422)
    expect(reached).toBe(false)
  })

  test('the failure names the field and the location', async () => {
    const app = make().post('/users', { body: z.object({ email: z.email() }) }, () => 'ok')
    const issues = await issuesOf(await postJson(app, '/users', { email: 'not-an-email' }))

    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ location: 'body', path: 'email' })
    expect(issues[0]?.message).toBeTruthy()
  })

  test('nested paths are rendered so they can be pasted back into client code', async () => {
    const app = make().post(
      '/orders',
      { body: z.object({ items: z.array(z.object({ qty: z.number() })) }) },
      () => 'ok',
    )
    const issues = await issuesOf(await postJson(app, '/orders', { items: [{ qty: 'two' }] }))
    expect(issues[0]?.path).toBe('items[0].qty')
  })

  // Fixing a request one field per round trip is a miserable way to spend an afternoon.
  test('every problem is reported at once, not just the first', async () => {
    const app = make().post(
      '/users',
      { body: z.object({ name: z.string(), email: z.email(), age: z.number() }) },
      () => 'ok',
    )
    const issues = await issuesOf(await postJson(app, '/users', { name: 1, email: 'x', age: 'y' }))
    expect(issues).toHaveLength(3)
  })

  test('problems across different locations are reported together', async () => {
    const app = make().post(
      '/users/:id',
      { params: z.object({ id: z.uuid() }), body: z.object({ name: z.string() }) },
      () => 'ok',
    )
    const issues = await issuesOf(await postJson(app, '/users/not-a-uuid', { name: 42 }))
    expect(issues.map((issue) => issue.location).sort()).toEqual(['body', 'params'])
  })

  test('schema defaults are applied', async () => {
    const app = make().post(
      '/users',
      { body: z.object({ name: z.string(), role: z.string().default('member') }) },
      (ctx) => ctx.body,
    )
    expect(await (await postJson(app, '/users', { name: 'ada' })).json()).toEqual({
      name: 'ada',
      role: 'member',
    })
  })

  test('unknown keys are stripped, so a handler cannot be fed extra fields', async () => {
    const app = make().post('/users', { body: z.object({ name: z.string() }) }, (ctx) => ctx.body)
    const response = await postJson(app, '/users', { name: 'ada', isAdmin: true })
    expect(await response.json()).toEqual({ name: 'ada' })
  })

  // Malformed JSON is the caller sending nonsense, not a schema mismatch.
  test('malformed JSON stays a 400, not a 422', async () => {
    const app = make().post('/users', { body: z.object({ name: z.string() }) }, () => 'ok')
    const response = await send(app, '/users', {
      method: 'POST',
      body: '{ broken',
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(400)
  })

  test('a missing body fails validation rather than crashing', async () => {
    const app = make().post('/users', { body: z.object({ name: z.string() }) }, () => 'ok')
    expect((await send(app, '/users', { method: 'POST' })).status).toBe(422)
  })
})

describe('params validation', () => {
  test('coerces through the schema', async () => {
    const app = make().get(
      '/users/:id',
      { params: z.object({ id: z.coerce.number() }) },
      (ctx) => ({ id: ctx.params.id, type: typeof ctx.params.id }),
    )
    expect(await (await send(app, '/users/42')).json()).toEqual({ id: 42, type: 'number' })
  })

  test('rejects a param that does not match', async () => {
    const app = make().get('/users/:id', { params: z.object({ id: z.uuid() }) }, () => 'ok')
    expect((await send(app, '/users/nope')).status).toBe(422)
  })

  test('leaves params as strings when no schema is declared', async () => {
    const app = make().get('/users/:id', (ctx) => ({ type: typeof ctx.params.id }))
    expect(await (await send(app, '/users/42')).json()).toEqual({ type: 'string' })
  })
})

// §1.3 could describe uploads but not validate them; this is the pairing with §1.6.
describe('file uploads', () => {
  test('a valid upload passes validation and arrives as a File', async () => {
    const app = make().post(
      '/avatar',
      { body: z.object({ avatar: z.file(), caption: z.string() }) },
      async (ctx) => ({
        name: ctx.body.avatar.name,
        type: ctx.body.avatar.type,
        text: await ctx.body.avatar.text(),
        caption: ctx.body.caption,
      }),
    )

    const form = new FormData()
    form.append('avatar', new File(['pixels'], 'me.png', { type: 'image/png' }))
    form.append('caption', 'holiday')

    const response = await send(app, '/avatar', { method: 'POST', body: form })
    expect(await response.json()).toEqual({
      name: 'me.png',
      type: 'image/png',
      text: 'pixels',
      caption: 'holiday',
    })
  })

  test('a missing file is a 422 naming the field', async () => {
    const app = make().post('/avatar', { body: z.object({ avatar: z.file() }) }, () => 'ok')

    const form = new FormData()
    form.append('caption', 'no file here')

    const issues = await issuesOf(await send(app, '/avatar', { method: 'POST', body: form }))
    expect(issues[0]).toMatchObject({ location: 'body', path: 'avatar' })
  })

  test('a text field where a file was declared is rejected', async () => {
    const app = make().post('/avatar', { body: z.object({ avatar: z.file() }) }, () => 'ok')

    const form = new FormData()
    form.append('avatar', 'just a string')

    expect((await send(app, '/avatar', { method: 'POST', body: form })).status).toBe(422)
  })

  test('schema constraints on a file are enforced', async () => {
    const app = make().post('/avatar', { body: z.object({ avatar: z.file().max(10) }) }, () => 'ok')

    const form = new FormData()
    form.append('avatar', new File(['x'.repeat(500)], 'big.png', { type: 'image/png' }))

    expect((await send(app, '/avatar', { method: 'POST', body: form })).status).toBe(422)
  })
})

describe('query validation', () => {
  test('applies defaults and coercion', async () => {
    const app = make().get(
      '/search',
      {
        query: z.object({
          q: z.string(),
          page: z.coerce.number().default(1),
        }),
      },
      (ctx) => ctx.query,
    )
    expect(await (await send(app, '/search?q=bun')).json()).toEqual({ q: 'bun', page: 1 })
  })

  test('rejects a missing required parameter', async () => {
    const app = make().get('/search', { query: z.object({ q: z.string() }) }, () => 'ok')
    const issues = await issuesOf(await send(app, '/search'))
    expect(issues[0]).toMatchObject({ location: 'query', path: 'q' })
  })

  test('validates repeated keys as arrays', async () => {
    const app = make().get(
      '/search',
      { query: z.object({ tag: z.array(z.string()) }) },
      (ctx) => ctx.query,
    )
    expect(await (await send(app, '/search?tag=a&tag=b')).json()).toEqual({ tag: ['a', 'b'] })
  })
})

describe('header validation', () => {
  test('validated headers arrive as a lowercase-keyed object', async () => {
    const app = make().get(
      '/x',
      { headers: z.object({ 'x-api-key': z.string().min(3) }) },
      (ctx) => ({ key: ctx.headers['x-api-key'] }),
    )
    const response = await send(app, '/x', { headers: { 'X-API-Key': 'secret' } })
    expect(await response.json()).toEqual({ key: 'secret' })
  })

  test('rejects a missing required header', async () => {
    const app = make().get('/x', { headers: z.object({ 'x-api-key': z.string() }) }, () => 'ok')
    const issues = await issuesOf(await send(app, '/x'))
    expect(issues[0]).toMatchObject({ location: 'headers', path: 'x-api-key' })
  })
})

describe('the 422 document', () => {
  test('is RFC 9457 problem+json', async () => {
    const app = make().post('/x', { body: z.object({ a: z.string() }) }, () => 'ok')
    const response = await postJson(app, '/x', {})

    expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8')
    expect(await response.json()).toMatchObject({
      type: 'about:blank',
      title: 'Unprocessable Content',
      status: 422,
      detail: 'Request validation failed.',
    })
  })

  test('carries an errors array with location, path and message', async () => {
    const app = make().post('/x', { body: z.object({ a: z.string() }) }, () => 'ok')
    const [issue] = await issuesOf(await postJson(app, '/x', {}))

    expect(issue).toHaveProperty('location')
    expect(issue).toHaveProperty('path')
    expect(issue).toHaveProperty('message')
  })

  // Validation messages describe the caller's own payload, so they are safe in production —
  // unlike an unplanned 500, which is where internals leak.
  test('is shown in production too', async () => {
    const app = make({ development: false }).post(
      '/x',
      { body: z.object({ email: z.email() }) },
      () => 'ok',
    )
    const issues = await issuesOf(await postJson(app, '/x', { email: 'bad' }))
    expect(issues).toHaveLength(1)
  })
})

describe('response validation', () => {
  test('passes a conforming response through', async () => {
    const app = make().get('/x', { response: { 200: z.object({ id: z.number() }) } }, () => ({
      id: 1,
    }))
    const response = await send(app, '/x')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 1 })
  })

  // A route that has drifted from its contract is our bug, not the caller's.
  test('a non-conforming response is a 500, not a 422', async () => {
    const app = make().get('/x', { response: { 200: z.object({ id: z.number() }) } }, () => ({
      id: 'not-a-number',
    }))
    expect((await send(app, '/x')).status).toBe(500)
  })

  test('the mismatch is described in development', async () => {
    const app = make({ development: true }).get(
      '/x',
      { response: { 200: z.object({ id: z.number() }) } },
      () => ({ id: 'wrong' }),
    )
    const body = (await (await send(app, '/x')).json()) as { errors?: unknown[] }
    expect(body.errors).toHaveLength(1)
  })

  test('the mismatch is withheld in production', async () => {
    const app = make({ development: false, validateResponses: true }).get(
      '/x',
      { response: { 200: z.object({ id: z.number() }) } },
      () => ({ id: 'wrong' }),
    )
    const response = await send(app, '/x')
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('errors')
  })

  // It validates our own code, not untrusted input, and costs a check on every success.
  test('is off in production by default', async () => {
    const app = make({ development: false }).get(
      '/x',
      { response: { 200: z.object({ id: z.number() }) } },
      () => ({ id: 'wrong' }),
    )
    expect((await send(app, '/x')).status).toBe(200)
  })

  test('only the schema matching the status is applied', async () => {
    const app = make().get('/x', { response: { 200: z.object({ id: z.number() }) } }, (ctx) => {
      ctx.status = 201
      return { anything: true }
    })
    expect((await send(app, '/x')).status).toBe(201)
  })

  /**
   * Returning a `Response`, a stream, a `Blob` or a `Bun.file` is taking control of the response
   * on purpose. The schema describes the JSON body a handler would otherwise have returned; it
   * has nothing to say about a stream, and checking one against it produced a 500 on a route
   * that was working correctly.
   *
   * These are the documented return types on the first-route page, so each gets a test rather
   * than one standing in for the rest.
   */
  describe('handlers that take control of the response', () => {
    const schema = { response: { 200: z.object({ id: z.number() }) } }

    test('a returned Response is passed through, not validated', async () => {
      const app = make().get(
        '/x',
        schema,
        () =>
          new Response(JSON.stringify({ id: 1 }), {
            headers: { 'content-type': 'application/json' },
          }),
      )
      const response = await send(app, '/x')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ id: 1 })
    })

    test('a Response whose body would fail the schema is still passed through', async () => {
      // The point of taking control: the schema is not the contract any more.
      const app = make().get('/x', schema, () => new Response('plain text'))
      const response = await send(app, '/x')
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('plain text')
    })

    test('a ReadableStream is passed through', async () => {
      const app = make().get(
        '/x',
        schema,
        () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('streamed'))
              controller.close()
            },
          }),
      )
      const response = await send(app, '/x')
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('streamed')
    })

    test('a Blob is passed through', async () => {
      const app = make().get('/x', schema, () => new Blob(['blobbed'], { type: 'text/plain' }))
      const response = await send(app, '/x')
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('blobbed')
    })

    test('a Bun.file is passed through', async () => {
      const app = make().get('/x', schema, () => Bun.file(`${import.meta.dir}/../package.json`))
      const response = await send(app, '/x')
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('"@theoven/core"')
    })

    test('a URL redirect is passed through', async () => {
      const app = make().get('/x', schema, () => new URL('https://theoven.app/docs'))
      const response = await send(app, '/x')
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('https://theoven.app/docs')
    })

    test('a typed array is passed through', async () => {
      const app = make().get('/x', schema, () => new TextEncoder().encode('binary'))
      const response = await send(app, '/x')
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('binary')
    })

    // Not in the passthrough list: `response: { 200: z.string() }` is a reasonable contract for
    // a text endpoint, so a returned string is still checked.
    test('a string is still validated against a string schema', async () => {
      const ok = make().get('/x', { response: { 200: z.string() } }, () => 'fine')
      expect((await send(ok, '/x')).status).toBe(200)

      const bad = make().get('/x', { response: { 200: z.string().min(20) } }, () => 'short')
      expect((await send(bad, '/x')).status).toBe(500)
    })

    test('an ordinary object is still validated', async () => {
      const app = make().get('/x', schema, () => ({ id: 'wrong' }))
      expect((await send(app, '/x')).status).toBe(500)
    })
  })
})

// D4 says Zod is the default, not a requirement. That is only true if something else works.
describe('no lock-in: valibot', () => {
  test('validates a body', async () => {
    const app = make().post(
      '/users',
      { body: v.object({ name: v.string(), age: v.number() }) },
      (ctx) => ctx.body,
    )
    expect(await (await postJson(app, '/users', { name: 'ada', age: 36 })).json()).toEqual({
      name: 'ada',
      age: 36,
    })
  })

  test('reports failures in the same shape as Zod does', async () => {
    const app = make().post('/users', { body: v.object({ name: v.string() }) }, () => 'ok')
    const response = await postJson(app, '/users', { name: 42 })

    expect(response.status).toBe(422)
    const issues = await issuesOf(response)
    expect(issues[0]).toMatchObject({ location: 'body', path: 'name' })
  })

  test('validates params', async () => {
    const app = make().get(
      '/users/:id',
      { params: v.object({ id: v.pipe(v.string(), v.uuid()) }) },
      () => 'ok',
    )
    expect((await send(app, '/users/nope')).status).toBe(422)
  })

  test('mixing libraries on one route works', async () => {
    const app = make().post(
      '/users/:id',
      {
        params: z.object({ id: z.coerce.number() }),
        body: v.object({ name: v.string() }),
      },
      (ctx) => ({ id: ctx.params.id, name: ctx.body.name }),
    )
    expect(await (await postJson(app, '/users/7', { name: 'ada' })).json()).toEqual({
      id: 7,
      name: 'ada',
    })
  })
})

describe('formatPath', () => {
  test.each([
    [[], ''],
    [['name'], 'name'],
    [['user', 'email'], 'user.email'],
    [['items', 0], 'items[0]'],
    [['items', 0, 'qty'], 'items[0].qty'],
    [[0], '[0]'],
  ])('%p -> %s', (path, expected) => {
    expect(formatPath(path as ReadonlyArray<PropertyKey>)).toBe(expected)
  })

  test('handles the object segment form', () => {
    expect(formatPath([{ key: 'user' }, { key: 'email' }])).toBe('user.email')
  })

  test('handles undefined', () => {
    expect(formatPath(undefined)).toBe('')
  })
})

describe('routes without schemas are unaffected', () => {
  test('a plain handler still works', async () => {
    const app = make().get('/x', () => 'ok')
    expect(await (await send(app, '/x')).text()).toBe('ok')
  })

  test('ctx.body is still a promise when no schema is declared', async () => {
    const app = make().post('/x', async (ctx) => ({ body: await ctx.body }))
    expect(await (await postJson(app, '/x', { a: 1 })).json()).toEqual({ body: { a: 1 } })
  })

  test('a route registered with no handler fails loudly at registration', () => {
    const app = make()
    expect(() =>
      (app.post as unknown as (path: string, schema: unknown) => void)('/x', {
        body: z.object({}),
      }),
    ).toThrow(/without a handler/)
  })
})

/** The types are the feature; a schema that validates but does not type is half of it. */
describe('type inference', () => {
  test('body is the schema output, not a promise', () => {
    const app = createApp({ logger: silentLogger })
    app.post('/x', { body: z.object({ name: z.string(), age: z.number() }) }, (ctx) => {
      expectTypeOf(ctx.body).toEqualTypeOf<{ name: string; age: number }>()
      return null
    })
  })

  test('params and query are the schema outputs', () => {
    const app = createApp({ logger: silentLogger })
    app.get(
      '/x/:id',
      { params: z.object({ id: z.coerce.number() }), query: z.object({ page: z.coerce.number() }) },
      (ctx) => {
        expectTypeOf(ctx.params).toEqualTypeOf<{ id: number }>()
        expectTypeOf(ctx.query).toEqualTypeOf<{ page: number }>()
        return null
      },
    )
  })

  test('undeclared locations keep their unvalidated types', () => {
    const app = createApp({ logger: silentLogger })
    app.post('/x', { body: z.object({ a: z.string() }) }, (ctx) => {
      expectTypeOf(ctx.params).toEqualTypeOf<Record<string, string>>()
      return null
    })
  })

  test('a field the schema does not declare is a compile error', () => {
    const app = createApp({ logger: silentLogger })
    app.post('/x', { body: z.object({ name: z.string() }) }, (ctx) => {
      // @ts-expect-error `email` is not part of the declared body schema.
      void ctx.body.email
      return null
    })
  })

  test('core context properties survive validation', () => {
    const app = createApp({ logger: silentLogger })
    app.post('/x', { body: z.object({ a: z.string() }) }, (ctx) => {
      expectTypeOf(ctx.token).toEqualTypeOf<string | undefined>()
      expectTypeOf(ctx.method).toEqualTypeOf<string>()
      return null
    })
  })

  test('brick contributions survive validation', () => {
    const app = createApp({ logger: silentLogger }).use({
      name: 'storage' as const,
      setup: () => ({ bucket: 'uploads' }),
    })
    app.post('/x', { body: z.object({ a: z.string() }) }, (ctx) => {
      expectTypeOf(ctx.storage).toEqualTypeOf<{ bucket: string }>()
      expectTypeOf(ctx.body).toEqualTypeOf<{ a: string }>()
      return null
    })
  })
})
