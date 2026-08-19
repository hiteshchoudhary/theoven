import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { type App, type AppOptions, createApp } from './app'
import { Unauthorized } from './errors'
import {
  clearRouteManifest,
  defineRoute,
  fileToRoute,
  generateManifest,
  hasRouteManifest,
  loadRoutes,
  middlewarePrefix,
  RouteFileError,
  readRouteModule,
  scanRoutes,
  segmentToPattern,
  setRouteManifest,
} from './file-routes'
import { silentLogger } from './logger'

const opened: App[] = []
const temporary: string[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 100 })))
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function make(options: AppOptions = {}): App {
  const app = createApp({ logger: silentLogger, development: true, ...options })
  opened.push(app)
  return app
}

function send(app: App, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`https://theoven.app${path}`, init))
}

/** Writes a routes tree to a unique temp directory and returns its path. */
async function tree(files: Record<string, string>): Promise<string> {
  // Inside the repo, not the system temp dir: route files import `zod`, and module resolution
  // walks up looking for node_modules. A tree in /tmp cannot resolve anything.
  const root = join(
    import.meta.dir,
    '../../../.tmp',
    `routes-${Math.floor(performance.now() * 1000)}-${temporary.length}`,
  )
  temporary.push(root)

  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, contents)
  }
  return root
}

describe('segmentToPattern', () => {
  test.each([
    ['users', 'users'],
    ['[id]', ':id'],
    ['[userId]', ':userId'],
    ['[...path]', '*path'],
    ['[...rest]', '*rest'],
  ])('%s -> %s', (segment, expected) => {
    expect(segmentToPattern(segment, 'f.ts')).toBe(expected)
  })

  test('an unnamed parameter is an error', () => {
    expect(() => segmentToPattern('[]', 'f.ts')).toThrow(/needs a name/)
  })

  test('an unnamed catch-all is an error', () => {
    expect(() => segmentToPattern('[...]', 'f.ts')).toThrow(/needs a name/)
  })

  // Treating this as a literal produces a route nobody can ever hit.
  test('an unmatched bracket is an error, not a literal segment', () => {
    expect(() => segmentToPattern('[id', 'f.ts')).toThrow(/unmatched bracket/)
    expect(() => segmentToPattern('id]', 'f.ts')).toThrow(/unmatched bracket/)
  })

  // Without this, `[..path]` becomes a parameter literally named `..path` and the route can
  // never match — a typo with no visible symptom.
  test.each(['[.path]', '[..path]'])('%s is caught as a mistyped catch-all', (segment) => {
    expect(() => segmentToPattern(segment, 'f.ts')).toThrow(/mistyped catch-all/)
    expect(() => segmentToPattern(segment, 'f.ts')).toThrow(/\[\.\.\.path\]/)
  })

  test('too many dots is caught too', () => {
    expect(() => segmentToPattern('[....path]', 'f.ts')).toThrow(/too many dots/)
    expect(() => segmentToPattern('[....path]', 'f.ts')).toThrow(/\[\.\.\.path\]/)
  })
})

describe('fileToRoute', () => {
  test.each([
    ['index.get.ts', 'GET', '/'],
    ['users.get.ts', 'GET', '/users'],
    ['users/index.get.ts', 'GET', '/users'],
    ['users/[id].get.ts', 'GET', '/users/:id'],
    ['users/[id].patch.ts', 'PATCH', '/users/:id'],
    ['users/[id]/avatar.post.ts', 'POST', '/users/:id/avatar'],
    ['files/[...path].get.ts', 'GET', '/files/*path'],
    ['a/b/c/index.delete.ts', 'DELETE', '/a/b/c'],
    ['health.head.ts', 'HEAD', '/health'],
    ['thing.options.ts', 'OPTIONS', '/thing'],
  ])('%s -> %s %s', (file, method, pattern) => {
    expect(fileToRoute(file)).toEqual({ method: method as 'GET', pattern })
  })

  test('accepts other extensions', () => {
    expect(fileToRoute('users.get.tsx')?.pattern).toBe('/users')
    expect(fileToRoute('users.get.js')?.pattern).toBe('/users')
  })

  test('ignores non-module files', () => {
    expect(fileToRoute('README.md')).toBeNull()
    expect(fileToRoute('styles.css')).toBeNull()
  })

  // Colocated helpers and components are the normal reason for a non-route file.
  test('ignores files and directories starting with an underscore', () => {
    expect(fileToRoute('_helpers.ts')).toBeNull()
    expect(fileToRoute('_lib/thing.get.ts')).toBeNull()
    expect(fileToRoute('users/_shared.ts')).toBeNull()
  })

  test('a missing method is an actionable error', () => {
    expect(() => fileToRoute('users.ts')).toThrow(/must name their method/)
    expect(() => fileToRoute('users.ts')).toThrow(/users\.get\.ts/)
  })

  test('an unknown method is an actionable error', () => {
    expect(() => fileToRoute('users.fetch.ts')).toThrow(/not an HTTP method/)
  })

  test('a method with no name before it is an error', () => {
    expect(() => fileToRoute('.get.ts')).toThrow(/need a name/)
  })

  test('a catch-all before other segments is an error', () => {
    expect(() => fileToRoute('files/[...path]/more.get.ts')).toThrow(/must be last/)
  })

  test('is case-insensitive about the method', () => {
    expect(fileToRoute('users.GET.ts')?.method).toBe('GET')
  })
})

describe('middlewarePrefix', () => {
  test.each([
    ['_middleware.ts', '/'],
    ['admin/_middleware.ts', '/admin'],
    ['admin/users/_middleware.ts', '/admin/users'],
    ['[org]/_middleware.ts', '/:org'],
  ])('%s -> %s', (file, expected) => {
    expect(middlewarePrefix(file)).toBe(expected)
  })
})

describe('scanRoutes', () => {
  test('finds routes and middleware', async () => {
    const dir = await tree({
      'index.get.ts': 'export default () => "root"',
      'users/[id].get.ts': 'export default () => "user"',
      'admin/_middleware.ts': 'export default async (c, n) => n()',
    })

    const discovery = await scanRoutes(dir)
    expect(discovery.routes.map((route) => route.pattern).sort()).toEqual(['/', '/users/:id'])
    expect(discovery.middleware.map((entry) => entry.prefix)).toEqual(['/admin'])
  })

  test('skips colocated tests', async () => {
    const dir = await tree({
      'users.get.ts': 'export default () => "u"',
      'users.get.test.ts': 'export default () => "not a route"',
    })
    expect((await scanRoutes(dir)).routes).toHaveLength(1)
  })

  test('skips underscore-prefixed files', async () => {
    const dir = await tree({
      'users.get.ts': 'export default () => "u"',
      '_helpers.ts': 'export const x = 1',
    })
    expect((await scanRoutes(dir)).routes).toHaveLength(1)
  })

  // A route conflict that only reproduces on someone else's laptop is a miserable bug.
  test('is deterministically ordered', async () => {
    const files: Record<string, string> = {}
    for (const name of ['zebra', 'alpha', 'monkey', 'beta']) {
      files[`${name}.get.ts`] = 'export default () => "x"'
    }
    const dir = await tree(files)

    const first = (await scanRoutes(dir)).routes.map((route) => route.pattern)
    const second = (await scanRoutes(dir)).routes.map((route) => route.pattern)
    expect(first).toEqual(second)
    expect(first).toEqual(['/alpha', '/beta', '/monkey', '/zebra'])
  })

  test('orders middleware outermost first', async () => {
    const dir = await tree({
      '_middleware.ts': 'export default async (c, n) => n()',
      'admin/users/_middleware.ts': 'export default async (c, n) => n()',
      'admin/_middleware.ts': 'export default async (c, n) => n()',
    })
    expect((await scanRoutes(dir)).middleware.map((entry) => entry.prefix)).toEqual([
      '/',
      '/admin',
      '/admin/users',
    ])
  })

  test('an empty directory yields nothing', async () => {
    const dir = await tree({ 'README.md': '# routes' })
    expect(await scanRoutes(dir)).toEqual({ routes: [], middleware: [] })
  })
})

describe('readRouteModule', () => {
  test('extracts the handler', () => {
    const handler = () => 'ok'
    expect(readRouteModule({ default: handler }, 'f.ts')).toEqual({ handler, schema: undefined })
  })

  test('extracts the schema keys', () => {
    const body = z.object({ a: z.string() })
    const result = readRouteModule({ default: () => 'ok', body, tags: ['x'] }, 'f.ts')
    expect(result.schema).toEqual({ body, tags: ['x'] })
  })

  test('leaves the schema undefined when nothing is declared', () => {
    expect(readRouteModule({ default: () => 'ok' }, 'f.ts').schema).toBeUndefined()
  })

  /**
   * `export const auth = true` must reach the schema.
   *
   * It did not: `auth` was missing from the collected keys, so a file-routed guard was gathered
   * into nothing and the route answered anonymously with a 200. A guard that silently does not
   * guard is worse than no guard, because the page and the code both say it is protected.
   */
  test('auth is carried onto the schema, so a file-routed guard is real', () => {
    const result = readRouteModule({ default: () => 'ok', auth: true }, 'f.ts')
    expect(result.schema).toEqual({ auth: true })
  })

  test('a policy name and a policy list are carried too', () => {
    expect(readRouteModule({ default: () => 'ok', auth: 'admin' }, 'f.ts').schema).toEqual({
      auth: 'admin',
    })
    expect(
      readRouteModule({ default: () => 'ok', auth: ['admin', 'owner'] }, 'f.ts').schema,
    ).toEqual({ auth: ['admin', 'owner'] })
  })

  test('a missing default export names the file', () => {
    expect(() => readRouteModule({}, 'routes/users.get.ts')).toThrow(/routes\/users\.get\.ts/)
    expect(() => readRouteModule({}, 'f.ts')).toThrow(/no default export/)
  })

  // Exporting `handler()` instead of `handler` is an easy slip with a baffling symptom.
  test('a non-function default export explains the likely mistake', () => {
    expect(() => readRouteModule({ default: 'oops' as unknown as () => unknown }, 'f.ts')).toThrow(
      /not the result of calling it/,
    )
  })
})

// TypeScript cannot relate sibling module exports, so `export const body` next to a separate
// default export leaves `ctx` untyped. Pairing them is the only way inference reaches a route
// file — which is the whole point of §1.6.
describe('defineRoute', () => {
  test('carries schema and handler together', () => {
    const handler = () => 'ok'
    const definition = defineRoute({ tags: ['x'] }, handler)
    expect(definition.schema).toEqual({ tags: ['x'] })
    expect(definition.handler).toBe(handler)
  })

  test('readRouteModule unpacks it', () => {
    const body = z.object({ a: z.string() })
    const handler = () => 'ok'
    const result = readRouteModule({ default: defineRoute({ body }, handler) }, 'f.ts')
    expect(result.schema).toEqual({ body })
    expect(result.handler).toBe(handler)
  })

  test('a definition with a non-function handler is rejected', () => {
    const broken = { schema: {}, handler: 'oops', __oven: 'route' as const }
    expect(() => readRouteModule({ default: broken as never }, 'f.ts')).toThrow(/not a function/)
  })

  test('serves a route defined this way', async () => {
    const dir = await tree({
      'users.post.ts': [
        "import { defineRoute } from '@theoven/core'",
        "import { z } from 'zod'",
        'export default defineRoute(',
        '  { body: z.object({ name: z.string() }) },',
        // Concatenation, not interpolation: this string is source code for a generated file,
        // and a template literal here would be evaluated by the test instead of written out.
        "  (ctx) => ({ greeting: 'hello ' + ctx.body.name }),",
        ')',
      ].join('\n'),
    })

    const app = make()
    await loadRoutes(app, dir)

    const response = await send(app, '/users', {
      method: 'POST',
      body: JSON.stringify({ name: 'ada' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(await response.json()).toEqual({ greeting: 'hello ada' })
  })

  test('validation still applies', async () => {
    const dir = await tree({
      'users.post.ts': [
        "import { defineRoute } from '@theoven/core'",
        "import { z } from 'zod'",
        'export default defineRoute(',
        '  { body: z.object({ name: z.string() }) },',
        '  (ctx) => ctx.body,',
        ')',
      ].join('\n'),
    })

    const app = make()
    await loadRoutes(app, dir)

    const response = await send(app, '/users', {
      method: 'POST',
      body: JSON.stringify({ name: 42 }),
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(422)
  })

  test('the bare-export form still works for routes without schemas', async () => {
    const dir = await tree({ 'ping.get.ts': 'export default () => "pong"' })
    const app = make()
    await loadRoutes(app, dir)
    expect(await (await send(app, '/ping')).text()).toBe('pong')
  })
})

describe('loadRoutes end to end', () => {
  test('registers and serves routes', async () => {
    const dir = await tree({
      'index.get.ts': 'export default () => ({ root: true })',
      'users/[id].get.ts': 'export default (ctx) => ({ id: ctx.params.id })',
    })

    const app = make()
    await loadRoutes(app, dir)

    expect(await (await send(app, '/')).json()).toEqual({ root: true })
    expect(await (await send(app, '/users/7')).json()).toEqual({ id: '7' })
  })

  test('applies schemas declared by a route file', async () => {
    const dir = await tree({
      'users.post.ts': [
        "import { z } from 'zod'",
        'export const body = z.object({ name: z.string() })',
        'export default (ctx) => ctx.body',
      ].join('\n'),
    })

    const app = make()
    await loadRoutes(app, dir)

    const ok = await send(app, '/users', {
      method: 'POST',
      body: JSON.stringify({ name: 'ada' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(await ok.json()).toEqual({ name: 'ada' })

    const bad = await send(app, '/users', {
      method: 'POST',
      body: JSON.stringify({ name: 42 }),
      headers: { 'content-type': 'application/json' },
    })
    expect(bad.status).toBe(422)
  })

  test('applies _middleware to its directory and below', async () => {
    const dir = await tree({
      'admin/_middleware.ts': [
        'export default async (ctx, next) => {',
        "  ctx.set('x-admin', 'yes')",
        '  return next()',
        '}',
      ].join('\n'),
      'admin/index.get.ts': 'export default () => "admin"',
      'public.get.ts': 'export default () => "public"',
    })

    const app = make()
    await loadRoutes(app, dir)

    expect((await send(app, '/admin')).headers.get('x-admin')).toBe('yes')
    expect((await send(app, '/public')).headers.get('x-admin')).toBeNull()
  })

  test('a root _middleware wraps everything', async () => {
    const dir = await tree({
      '_middleware.ts': [
        'export default async (ctx, next) => {',
        "  ctx.set('x-root', 'yes')",
        '  return next()',
        '}',
      ].join('\n'),
      'a.get.ts': 'export default () => "a"',
    })

    const app = make()
    await loadRoutes(app, dir)
    expect((await send(app, '/a')).headers.get('x-root')).toBe('yes')
  })

  test('serves a catch-all', async () => {
    const dir = await tree({
      'files/[...path].get.ts': 'export default (ctx) => ({ path: ctx.params.path })',
    })

    const app = make()
    await loadRoutes(app, dir)
    expect(await (await send(app, '/files/a/b/c.txt')).json()).toEqual({ path: 'a/b/c.txt' })
  })

  test('a malformed route file fails at load with the filename', async () => {
    const dir = await tree({ 'broken.get.ts': 'export const notDefault = () => "x"' })
    const app = make()
    expect(loadRoutes(app, dir)).rejects.toThrow(/broken\.get\.ts/)
  })

  test('a _middleware without a default export fails at load', async () => {
    const dir = await tree({ '_middleware.ts': 'export const x = 1' })
    const app = make()
    expect(loadRoutes(app, dir)).rejects.toThrow(/_middleware/)
  })

  test('returns what it discovered, for a boot banner', async () => {
    const dir = await tree({
      'a.get.ts': 'export default () => "a"',
      'b.post.ts': 'export default () => "b"',
    })
    const app = make()
    const discovery = await loadRoutes(app, dir)
    expect(discovery.routes).toHaveLength(2)
  })

  test('a duplicate route across files is caught at registration', async () => {
    const dir = await tree({
      'users/index.get.ts': 'export default () => "a"',
      'users.get.ts': 'export default () => "b"',
    })
    const app = make()
    expect(loadRoutes(app, dir)).rejects.toThrow(/Duplicate route/)
  })
})

describe('generateManifest', () => {
  test('emits static imports for every route', async () => {
    const dir = await tree({
      'index.get.ts': 'export default () => "root"',
      'users/[id].get.ts': 'export default () => "user"',
    })

    const manifest = await generateManifest(dir)
    expect(manifest).toContain("import * as r0 from './index.get.ts'")
    expect(manifest).toContain("import * as r1 from './users/[id].get.ts'")
    expect(manifest).toContain("app.route('GET', '/', schema, handler)")
    expect(manifest).toContain("app.route('GET', '/users/:id', schema, handler)")
  })

  test('includes middleware', async () => {
    const dir = await tree({
      'admin/_middleware.ts': 'export default async (c, n) => n()',
      'admin/index.get.ts': 'export default () => "a"',
    })

    const manifest = await generateManifest(dir)
    expect(manifest).toContain("import m0 from './admin/_middleware.ts'")
    expect(manifest).toContain("app.use('/admin', m0)")
  })

  test('says it is generated', async () => {
    const dir = await tree({ 'a.get.ts': 'export default () => "a"' })
    expect(await generateManifest(dir)).toContain('Do not edit')
  })

  test('handles an empty tree', async () => {
    const dir = await tree({ 'README.md': '#' })
    const manifest = await generateManifest(dir)
    expect(manifest).toContain('export function registerRoutes')
  })
})

describe('RouteFileError', () => {
  test('is a real Error', () => {
    expect(new RouteFileError('x')).toBeInstanceOf(Error)
    expect(new RouteFileError('x').name).toBe('RouteFileError')
  })
})

/**
 * The seam that makes a production bundle work.
 *
 * A bundle has no `src/routes` directory to walk — `import.meta.dir` points at `dist/`, so
 * `loadRoutes` would look for `dist/routes` and fail. `oven build` installs a manifest of static
 * imports instead, and the app's own code stays identical in development and production.
 *
 * This was found by running a built scaffold, not by a test: the build generated a manifest that
 * nothing imported.
 */
describe('route manifest', () => {
  afterEach(() => {
    clearRouteManifest()
  })

  test('none is installed by default', () => {
    expect(hasRouteManifest()).toBe(false)
  })

  test('an installed manifest replaces the filesystem scan', async () => {
    const app = make()
    setRouteManifest((target) => {
      target.get('/from-manifest', () => 'ok')
    })

    // A directory that does not exist: if the scan ran, this would throw.
    await loadRoutes(app, '/nonexistent/routes')

    expect(await (await send(app, '/from-manifest')).text()).toBe('ok')
  })

  test('the manifest reports what it registered', async () => {
    const app = make()
    setRouteManifest((target) => {
      target.get('/a', () => 'a')
      target.post('/b', () => 'b')
    })

    const discovery = await loadRoutes(app, '/nonexistent')
    expect(discovery.routes.map((route) => route.pattern).sort()).toEqual(['/a', '/b'])
  })

  test('ignoreManifest forces a real scan', async () => {
    const dir = await tree({ 'scanned.get.ts': 'export default () => "scanned"' })
    const app = make()
    setRouteManifest((target) => {
      target.get('/from-manifest', () => 'manifest')
    })

    await loadRoutes(app, dir, { ignoreManifest: true })

    expect(await (await send(app, '/scanned')).text()).toBe('scanned')
    expect((await send(app, '/from-manifest')).status).toBe(404)
  })

  test('clearing it restores scanning', async () => {
    setRouteManifest(() => {})
    expect(hasRouteManifest()).toBe(true)
    clearRouteManifest()
    expect(hasRouteManifest()).toBe(false)
  })
})

/**
 * The seam between a route file and a brick that guards it.
 *
 * `readRouteModule` extracting `auth` and the auth brick reading `schema.auth` were both already
 * covered, and the guard still did not work: `auth` was absent from the keys collected off a
 * module, so nothing was carried between them. Each side was right and the join was broken —
 * which is exactly the shape a unit test on either side cannot see.
 */
describe('a file-routed guard reaches the brick that enforces it', () => {
  /** Stands in for the auth brick: refuses whenever the route declares `auth`. */
  const guard = {
    name: 'guard' as const,
    setup: () => ({}),
    request: (_ctx: unknown, route: { schema?: { auth?: unknown } }) => {
      if (route.schema?.auth !== undefined && route.schema.auth !== false) {
        throw new Unauthorized('Guarded.')
      }
      return undefined
    },
  }

  test('export const auth = true is enforced, not silently dropped', async () => {
    const app = make().use(guard as never)
    await loadRoutes(
      app,
      await tree({
        'secret.get.ts': 'export const auth = true\nexport default () => "secret"',
        'open.get.ts': 'export default () => "open"',
      }),
    )

    expect((await send(app, '/secret')).status).toBe(401)
    expect((await send(app, '/open')).status).toBe(200)
  })

  test('the defineRoute form is enforced the same way', async () => {
    const app = make().use(guard as never)
    await loadRoutes(
      app,
      await tree({
        'secret.get.ts':
          'import { defineRoute } from "../../packages/core/src/index"\n' +
          'export default defineRoute({ auth: true }, () => "secret")',
      }),
    )

    expect((await send(app, '/secret')).status).toBe(401)
  })
})
