import { afterEach, describe, expect, test } from 'bun:test'
import { validate } from '@readme/openapi-parser'
import * as v from 'valibot'
import { z } from 'zod'
import { type App, type AppOptions, createApp } from './app'
import { silentLogger } from './logger'
import {
  docsHtml,
  generateOpenApi,
  openapi,
  pathParameterNames,
  type RouteInfo,
  toOpenApiPath,
} from './openapi'

const opened: App[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 100 })))
})

function make(options: AppOptions = {}): App {
  const app = createApp({ logger: silentLogger, development: true, ...options })
  opened.push(app)
  return app
}

function send(app: App, path: string): Promise<Response> {
  return app.fetch(new Request(`https://theoven.app${path}`))
}

/**
 * A generated operation, loosely typed.
 *
 * The generator returns plain JSON by design — an OpenAPI document is data, not a class — so
 * tests index into it. `Loose` keeps that readable without reaching for `any`.
 */
// biome-ignore lint/suspicious/noExplicitAny: walking untyped JSON in tests
type Loose = Record<string, any>

/** Digs an operation out of a generated document. */
function operation(document: Record<string, unknown>, path: string, method: string): Loose {
  const paths = document.paths as Record<string, Record<string, Loose>>
  return paths[path]?.[method] ?? {}
}

describe('toOpenApiPath', () => {
  test.each([
    ['/users', '/users'],
    ['/users/:id', '/users/{id}'],
    ['/users/:userId/posts/:postId', '/users/{userId}/posts/{postId}'],
    ['/files/*path', '/files/{path}'],
    ['/', '/'],
  ])('%s -> %s', (pattern, expected) => {
    expect(toOpenApiPath(pattern)).toBe(expected)
  })
})

// Every `{name}` in a path template must have a parameter object, or real tooling rejects the
// document. A route with a path parameter and no `params` schema is the common case.
describe('pathParameterNames', () => {
  test.each([
    ['/users', []],
    ['/users/:id', ['id']],
    ['/users/:userId/posts/:postId', ['userId', 'postId']],
    ['/files/*path', ['path']],
    ['/files/*', ['wildcard']],
  ])('%s -> %p', (pattern, expected) => {
    expect(pathParameterNames(pattern)).toEqual(expected as string[])
  })

  test('a route with no params schema still declares its path parameters', () => {
    const document = generateOpenApi([{ method: 'GET', pattern: '/users/:id', schema: undefined }])
    const op = operation(document, '/users/{id}', 'get')
    expect(op.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ])
  })

  test('a schema-declared parameter is not duplicated', () => {
    const document = generateOpenApi([
      { method: 'GET', pattern: '/users/:id', schema: { params: z.object({ id: z.uuid() }) } },
    ])
    const op = operation(document, '/users/{id}', 'get')
    expect(op.parameters).toHaveLength(1)
    expect(op.parameters[0].schema).toMatchObject({ format: 'uuid' })
  })

  test('a catch-all is declared too', () => {
    const document = generateOpenApi([
      { method: 'GET', pattern: '/files/*path', schema: undefined },
    ])
    expect(operation(document, '/files/{path}', 'get').parameters[0].name).toBe('path')
  })
})

describe('document shape', () => {
  test('is OpenAPI 3.1', () => {
    // 3.1 because its schema dialect *is* JSON Schema 2020-12, which is what Zod emits.
    expect(generateOpenApi([]).openapi).toBe('3.1.0')
  })

  test('carries the info block', () => {
    const document = generateOpenApi([], {
      info: { title: 'My API', version: '2.1.0', description: 'Does things' },
    })
    expect(document.info).toEqual({ title: 'My API', version: '2.1.0', description: 'Does things' })
  })

  test('has sensible defaults for info', () => {
    expect(generateOpenApi([]).info).toEqual({ title: 'API', version: '0.0.0' })
  })

  test('includes servers and tags when given', () => {
    const document = generateOpenApi([], {
      servers: [{ url: 'https://api.example' }],
      tags: [{ name: 'users' }],
    })
    expect(document.servers).toEqual([{ url: 'https://api.example' }])
    expect(document.tags).toEqual([{ name: 'users' }])
  })

  test('omits components when there are no security schemes', () => {
    expect(generateOpenApi([])).not.toHaveProperty('components')
  })

  test('includes security schemes when contributed', () => {
    const document = generateOpenApi([], {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    })
    expect(document.components).toEqual({
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    })
  })
})

describe('operations', () => {
  const routes: RouteInfo[] = [
    { method: 'GET', pattern: '/users', schema: { summary: 'List users', tags: ['users'] } },
    {
      method: 'GET',
      pattern: '/users/:id',
      schema: {
        params: z.object({ id: z.uuid() }),
        response: { 200: z.object({ id: z.string(), name: z.string() }) },
      },
    },
    {
      method: 'POST',
      pattern: '/users',
      schema: { body: z.object({ name: z.string(), email: z.email() }) },
    },
  ]

  test('produces one entry per method and path', () => {
    const document = generateOpenApi(routes)
    expect(Object.keys(document.paths as object).sort()).toEqual(['/users', '/users/{id}'])
    expect(operation(document, '/users', 'get')).toBeDefined()
    expect(operation(document, '/users', 'post')).toBeDefined()
  })

  test('carries summary and tags', () => {
    const op = operation(generateOpenApi(routes), '/users', 'get')
    expect(op.summary).toBe('List users')
    expect(op.tags).toEqual(['users'])
  })

  test('turns params into path parameters', () => {
    const op = operation(generateOpenApi(routes), '/users/{id}', 'get')
    expect(op.parameters).toHaveLength(1)
    expect(op.parameters[0]).toMatchObject({ name: 'id', in: 'path', required: true })
    expect(op.parameters[0].schema).toMatchObject({ type: 'string', format: 'uuid' })
  })

  test('turns query into query parameters, honouring optionality', () => {
    const document = generateOpenApi([
      {
        method: 'GET',
        pattern: '/search',
        schema: { query: z.object({ q: z.string(), page: z.string().optional() }) },
      },
    ])
    const parameters = operation(document, '/search', 'get').parameters
    expect(parameters.find((p: Loose) => p.name === 'q').required).toBe(true)
    expect(parameters.find((p: Loose) => p.name === 'page').required).toBe(false)
  })

  test('turns headers into header parameters', () => {
    const document = generateOpenApi([
      {
        method: 'GET',
        pattern: '/x',
        schema: { headers: z.object({ 'x-api-key': z.string() }) },
      },
    ])
    expect(operation(document, '/x', 'get').parameters[0]).toMatchObject({
      name: 'x-api-key',
      in: 'header',
    })
  })

  // A path parameter is part of the URL; it cannot be optional whatever the schema says.
  test('path parameters are always required', () => {
    const document = generateOpenApi([
      {
        method: 'GET',
        pattern: '/users/:id',
        schema: { params: z.object({ id: z.string().optional() }) },
      },
    ])
    expect(operation(document, '/users/{id}', 'get').parameters[0].required).toBe(true)
  })

  test('turns body into a JSON request body', () => {
    const op = operation(generateOpenApi(routes), '/users', 'post')
    expect(op.requestBody.required).toBe(true)
    expect(op.requestBody.content['application/json'].schema).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string' }, email: { type: 'string', format: 'email' } },
    })
  })

  test('turns response schemas into responses', () => {
    const op = operation(generateOpenApi(routes), '/users/{id}', 'get')
    expect(op.responses['200'].content['application/json'].schema).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
    })
  })

  test('gives a default 200 when no response schema is declared', () => {
    const op = operation(generateOpenApi(routes), '/users', 'get')
    expect(op.responses['200']).toEqual({ description: 'Successful response' })
  })

  // A generated client should know the error shape it will actually receive.
  test('documents 422 for any route that validates input', () => {
    const op = operation(generateOpenApi(routes), '/users', 'post')
    expect(op.responses['422'].content['application/problem+json'].schema).toMatchObject({
      type: 'object',
    })
  })

  test('does not document 422 for a route with no request schemas', () => {
    const op = operation(generateOpenApi(routes), '/users', 'get')
    expect(op.responses).not.toHaveProperty('422')
  })

  // HEAD is served from GET and carries no separate contract.
  test('skips HEAD routes', () => {
    const document = generateOpenApi([{ method: 'HEAD', pattern: '/x', schema: undefined }])
    expect(document.paths).toEqual({})
  })

  test('honours the exclude list', () => {
    const document = generateOpenApi([{ method: 'GET', pattern: '/internal', schema: undefined }], {
      exclude: ['/internal'],
    })
    expect(document.paths).toEqual({})
  })
})

// A generated client that posts JSON to an upload endpoint fails in a confusing way.
describe('file uploads', () => {
  test('a body containing a file is multipart/form-data', () => {
    const document = generateOpenApi([
      {
        method: 'POST',
        pattern: '/avatar',
        schema: { body: z.object({ avatar: z.file(), caption: z.string() }) },
      },
    ])
    const content = operation(document, '/avatar', 'post').requestBody.content
    expect(Object.keys(content)).toEqual(['multipart/form-data'])
  })

  test('the file field is described as binary', () => {
    const document = generateOpenApi([
      { method: 'POST', pattern: '/avatar', schema: { body: z.object({ avatar: z.file() }) } },
    ])
    const schema = operation(document, '/avatar', 'post').requestBody.content['multipart/form-data']
      .schema
    expect(schema.properties.avatar).toMatchObject({ format: 'binary' })
  })

  test('a body without files stays JSON', () => {
    const document = generateOpenApi([
      { method: 'POST', pattern: '/x', schema: { body: z.object({ a: z.string() }) } },
    ])
    expect(Object.keys(operation(document, '/x', 'post').requestBody.content)).toEqual([
      'application/json',
    ])
  })
})

describe('non-Zod schemas', () => {
  // Documenting permissively is honest; inventing a shape would not be.
  test('are documented permissively rather than wrongly', () => {
    const document = generateOpenApi([
      { method: 'POST', pattern: '/x', schema: { body: v.object({ a: v.string() }) } },
    ])
    expect(
      operation(document, '/x', 'post').requestBody.content['application/json'].schema,
    ).toEqual({})
  })

  test('the document is still valid and still lists the route', () => {
    const document = generateOpenApi([
      { method: 'POST', pattern: '/x', schema: { body: v.object({ a: v.string() }) } },
    ])
    expect(operation(document, '/x', 'post')).toBeDefined()
  })

  test('a warning names the vendor so the gap is discoverable', () => {
    const warnings: Array<Record<string, unknown>> = []
    const logger = {
      debug() {},
      info() {},
      warn(_message: string, fields?: Record<string, unknown>) {
        if (fields) warnings.push(fields)
      },
      error() {},
      child() {
        return logger
      },
    }

    generateOpenApi(
      [{ method: 'POST', pattern: '/x', schema: { body: v.object({ a: v.string() }) } }],
      {},
      logger,
    )
    expect(warnings[0]?.vendors).toEqual(['valibot'])
  })

  test('says nothing when every schema is Zod', () => {
    let warned = false
    const logger = {
      debug() {},
      info() {},
      warn() {
        warned = true
      },
      error() {},
      child() {
        return logger
      },
    }
    generateOpenApi(
      [{ method: 'POST', pattern: '/x', schema: { body: z.object({ a: z.string() }) } }],
      {},
      logger,
    )
    expect(warned).toBe(false)
  })
})

describe('the brick', () => {
  test('serves the document', async () => {
    const app = make().use(openapi({ info: { title: 'Test API', version: '1.0.0' } }))
    app.get('/users', { summary: 'List' }, () => [])

    const response = await send(app, '/openapi.json')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')

    const document = (await response.json()) as Loose
    expect(document.openapi).toBe('3.1.0')
    expect(document.info.title).toBe('Test API')
    expect(document.paths['/users'].get.summary).toBe('List')
  })

  test('serves the UI', async () => {
    const app = make().use(openapi({ info: { title: 'Test API' } }))
    const response = await send(app, '/docs')

    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const html = await response.text()
    expect(html).toContain('api-reference')
    expect(html).toContain('/openapi.json')
  })

  // Documenting the docs endpoint is noise in every generated client.
  test('excludes its own routes from the document', async () => {
    const app = make().use(openapi())
    app.get('/users', () => [])

    const document = (await (await send(app, '/openapi.json')).json()) as Loose
    expect(Object.keys(document.paths)).toEqual(['/users'])
  })

  test('paths are configurable', async () => {
    const app = make().use(openapi({ path: '/spec.json', ui: '/reference' }))
    app.get('/x', () => 'ok')

    expect((await send(app, '/spec.json')).status).toBe(200)
    expect((await send(app, '/reference')).status).toBe(200)
    expect((await send(app, '/openapi.json')).status).toBe(404)
  })

  test('the UI can be turned off', async () => {
    const app = make().use(openapi({ ui: false }))
    app.get('/x', () => 'ok')

    expect((await send(app, '/openapi.json')).status).toBe(200)
    expect((await send(app, '/docs')).status).toBe(404)
  })

  // Bricks registered after this one are still adding routes while setup runs.
  test('documents routes registered after the brick', async () => {
    const app = make().use(openapi())
    app.get('/registered-later', () => 'ok')

    const document = (await (await send(app, '/openapi.json')).json()) as Loose
    expect(document.paths).toHaveProperty('/registered-later')
  })

  test('merges security schemes contributed by other bricks', async () => {
    const app = make()
      .use({
        name: 'fakeAuth',
        setup: (context) => {
          context.app.contributeOpenApi({
            securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
          })
          return {}
        },
      })
      .use(openapi())
    app.get('/x', () => 'ok')

    const document = (await (await send(app, '/openapi.json')).json()) as Loose
    expect(document.components.securitySchemes.bearerAuth).toEqual({
      type: 'http',
      scheme: 'bearer',
    })
  })

  test('exposes the document for CLI use', async () => {
    const app = make().use(openapi({ info: { title: 'CLI' } }))
    app.get('/x', () => 'ok')
    await app.ready()

    // Route handlers built it already, but the service can be asked directly.
    await send(app, '/openapi.json')
    expect(app.routeTable().some((route) => route.pattern === '/openapi.json')).toBe(true)
  })
})

describe('docsHtml', () => {
  test('points at the spec', () => {
    expect(docsHtml('/openapi.json', 'My API')).toContain('data-url="/openapi.json"')
  })

  test('escapes the title', () => {
    const html = docsHtml('/openapi.json', '<script>alert(1)</script>')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  test('escapes the spec path', () => {
    expect(docsHtml('/x"onload="alert(1)', 'T')).not.toContain('"onload="')
  })
})

describe('generated documents are well formed', () => {
  test('every operation has a responses object, as the spec requires', () => {
    const document = generateOpenApi([
      { method: 'GET', pattern: '/a', schema: undefined },
      { method: 'POST', pattern: '/b', schema: { body: z.object({ x: z.string() }) } },
    ])

    for (const methods of Object.values(document.paths as Loose)) {
      for (const op of Object.values(methods as Loose)) {
        expect(op.responses).toBeDefined()
        expect(Object.keys(op.responses).length).toBeGreaterThan(0)
      }
    }
  })

  test('serialises to JSON without cycles', () => {
    const document = generateOpenApi([
      {
        method: 'POST',
        pattern: '/users/:id',
        schema: {
          params: z.object({ id: z.uuid() }),
          body: z.object({ nested: z.object({ deep: z.array(z.string()) }) }),
          response: { 200: z.object({ ok: z.boolean() }) },
        },
      },
    ])
    expect(() => JSON.stringify(document)).not.toThrow()
  })

  test('no $schema keys leak into operations', () => {
    const document = generateOpenApi([
      { method: 'POST', pattern: '/x', schema: { body: z.object({ a: z.string() }) } },
    ])
    expect(JSON.stringify(document)).not.toContain('$schema')
  })
})

/**
 * The strongest assertion available for a spec generator: hand the output to a real OpenAPI
 * parser and let it judge. Structural tests confirm the shape we intended; only this confirms
 * the shape the ecosystem will accept.
 */
describe('validated against a real OpenAPI parser', () => {
  const routes: RouteInfo[] = [
    { method: 'GET', pattern: '/users', schema: { summary: 'List users', tags: ['users'] } },
    {
      method: 'GET',
      pattern: '/users/:id',
      schema: {
        params: z.object({ id: z.uuid() }),
        query: z.object({ include: z.string().optional() }),
        response: { 200: z.object({ id: z.string(), name: z.string() }) },
      },
    },
    {
      method: 'POST',
      pattern: '/users',
      schema: {
        body: z.object({ name: z.string(), email: z.email(), tags: z.array(z.string()) }),
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    {
      method: 'POST',
      pattern: '/users/:id/avatar',
      schema: {
        params: z.object({ id: z.uuid() }),
        body: z.object({ avatar: z.file(), caption: z.string().optional() }),
      },
    },
    { method: 'GET', pattern: '/files/*path', schema: undefined },
    {
      method: 'GET',
      pattern: '/mixed',
      schema: { body: v.object({ notZod: v.string() }) },
    },
  ]

  test('the generated document is valid OpenAPI 3.1', async () => {
    const document = generateOpenApi(routes, {
      info: { title: 'Oven Test API', version: '1.0.0', description: 'Generated from schemas' },
      servers: [{ url: 'https://api.example' }],
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    })

    // The parser mutates what it is given, so it gets a copy.
    const result = await validate(structuredClone(document) as never)
    expect(result.valid).toBe(true)
  })

  // The 3.1 spec permits an empty `paths` object, but strict validators want at least one entry
  // somewhere. Rather than fake compliance for a degenerate case, the generator says so.
  test('a document with no paths warns instead of failing silently', () => {
    const warnings: Array<Record<string, unknown>> = []
    const logger = {
      debug() {},
      info() {},
      warn(_message: string, fields?: Record<string, unknown>) {
        if (fields) warnings.push(fields)
      },
      error() {},
      child() {
        return logger
      },
    }

    generateOpenApi([], { info: { title: 'Empty', version: '0.0.1' } }, logger)
    expect(warnings[0]?.note).toContain('No routes were documented')
  })

  test('one documented route is enough to satisfy strict validators', async () => {
    const document = generateOpenApi([{ method: 'GET', pattern: '/health', schema: undefined }], {
      info: { title: 'Tiny', version: '0.0.1' },
    })
    expect((await validate(structuredClone(document) as never)).valid).toBe(true)
  })

  // A validator that approves anything would make the test above meaningless.
  test('the validator rejects a malformed document, so the check above means something', async () => {
    const broken = { openapi: '3.1.0', info: { title: 'Broken' }, paths: {} }
    const result = await validate(structuredClone(broken) as never)
    expect(result.valid).toBe(false)
  })
})

/**
 * A guarded route has to say so in its own operation.
 *
 * Without it the document describes a public API that answers 401: every generated client omits
 * the credential, and someone reading `/docs` cannot tell which endpoints need one.
 */
describe('guarded routes in the document', () => {
  function build(
    schema: Parameters<typeof generateOpenApi>[0][number]['schema'],
    securitySchemes?: Record<string, unknown>,
  ) {
    return generateOpenApi([{ method: 'GET', pattern: '/thing', schema }], {
      info: { title: 'T', version: '1' },
      ...(securitySchemes ? { securitySchemes } : {}),
    })
  }

  function operation(document: ReturnType<typeof generateOpenApi>) {
    return (document.paths as Record<string, Record<string, Record<string, unknown>>>)['/thing']
      ?.get as Record<string, unknown>
  }

  test('auth: true requires the registered schemes', () => {
    const document = build({ auth: true }, { bearerAuth: { type: 'http', scheme: 'bearer' } })
    expect(operation(document).security).toEqual([{ bearerAuth: [] }])
  })

  test('a guarded route documents its 401', () => {
    const document = build({ auth: true })
    const responses = operation(document).responses as Record<string, { description: string }>
    expect(responses['401']?.description).toBe('Unauthorized')
  })

  test('an unguarded route says nothing about security', () => {
    const document = build({ summary: 'Public' })
    expect(operation(document).security).toBeUndefined()
    expect((operation(document).responses as Record<string, unknown>)['401']).toBeUndefined()
  })

  // The spec's way of saying "authentication required, unspecified" — better than silence.
  test('with no scheme registered it still marks the route as requiring auth', () => {
    expect(operation(build({ auth: true })).security).toEqual([{}])
  })

  /**
   * A named policy is more than "signed in". The reader needs to know which one, because it is
   * a function in the codebase they can go and read (D18).
   */
  test('a named policy is named, and adds a 403', () => {
    const document = build({ auth: 'admin' }, { bearerAuth: { type: 'http', scheme: 'bearer' } })
    const built = operation(document)

    expect(built.description).toContain('admin')
    expect(built['x-oven-policies']).toEqual(['admin'])
    expect((built.responses as Record<string, unknown>)['403']).toBeDefined()
  })

  test('several policies are all listed', () => {
    const built = operation(build({ auth: ['admin', 'billing'] }))
    expect(built['x-oven-policies']).toEqual(['admin', 'billing'])
    expect(built.description).toContain('admin, billing')
  })

  test('a policy note is appended to an existing description, not replacing it', () => {
    const built = operation(build({ auth: 'admin', description: 'Deletes the account.' }))
    expect(built.description).toContain('Deletes the account.')
    expect(built.description).toContain('admin')
  })
})

/**
 * `/_oven/*` is where bricks put their development tooling — the mail preview inbox, the queue
 * dashboard. They were being documented, which puts a brick's internal UI into every client
 * generated from the spec.
 */
describe('the reserved namespace', () => {
  test('brick development endpoints are left out of the document', async () => {
    const app = make()
    app.get('/_oven/mail', () => 'inbox')
    app.get('/_oven/mail/:id', () => 'message')
    app.get('/_oven/queue', () => 'dashboard')
    app.get('/users', () => [])
    app.use(openapi({ info: { title: 't', version: '1' } }))

    const document = (await (await send(app, '/openapi.json')).json()) as Loose

    expect(Object.keys(document.paths ?? {})).toEqual(['/users'])
  })

  test('but they are still served', async () => {
    const app = make()
    app.get('/_oven/mail', () => 'inbox')
    app.use(openapi({ info: { title: 't', version: '1' } }))

    expect((await send(app, '/_oven/mail')).status).toBe(200)
  })

  test('a path merely starting with the same letters is documented', async () => {
    const app = make()
    app.get('/_ovenware', () => 'not reserved')
    app.use(openapi({ info: { title: 't', version: '1' } }))

    const document = (await (await send(app, '/openapi.json')).json()) as Loose

    expect(Object.keys(document.paths ?? {})).toContain('/_ovenware')
  })
})
