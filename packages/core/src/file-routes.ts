import { basename, dirname, join, relative, sep } from 'node:path'
import type { App } from './app'
import type { Context } from './context'
import type { Middleware } from './middleware'
import { type HttpMethod, isHttpMethod } from './router/types'
import type { RouteSchema, ValidatedHandler } from './validation'

/**
 * File-based routing.
 *
 * The filesystem is the route table:
 *
 * ```
 * src/routes/index.get.ts             GET  /
 * src/routes/users/index.get.ts       GET  /users
 * src/routes/users/[id].get.ts        GET  /users/:id
 * src/routes/users/[id].patch.ts      PATCH /users/:id
 * src/routes/files/[...path].get.ts   GET  /files/*path
 * src/routes/admin/_middleware.ts     middleware for /admin and below
 * ```
 *
 * The method lives in the filename rather than in named exports, so a route's method is visible
 * in a directory listing and in `git log --stat`. One file is one endpoint; grepping for
 * `users/[id].patch` finds it.
 *
 * Each route file exports a default handler, and optionally the same schema keys a programmatic
 * route takes — `params`, `query`, `body`, `headers`, `response`, plus `summary`, `description`
 * and `tags` for the generated OpenAPI document.
 */

/** Extensions treated as route modules. */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']

/** Filename that contributes middleware to its directory and everything below it. */
const MIDDLEWARE_BASENAME = '_middleware'

export interface DiscoveredRoute {
  method: HttpMethod
  /** Router pattern, e.g. `/users/:id`. */
  pattern: string
  /** Absolute path of the module. */
  file: string
}

export interface DiscoveredMiddleware {
  /** Path prefix this middleware applies to, e.g. `/admin`. */
  prefix: string
  file: string
}

export interface Discovery {
  routes: DiscoveredRoute[]
  middleware: DiscoveredMiddleware[]
}

/** Raised for a file the conventions cannot make sense of. Always names the file. */
export class RouteFileError extends Error {
  override name = 'RouteFileError'
}

function stripExtension(name: string): string | undefined {
  for (const extension of EXTENSIONS) {
    if (name.endsWith(extension)) return name.slice(0, -extension.length)
  }
  return undefined
}

/**
 * Converts one path segment into its router form.
 *
 * `[id]` becomes `:id`, `[...path]` becomes `*path`, everything else is literal.
 */
export function segmentToPattern(segment: string, file: string): string {
  if (segment.startsWith('[...') && segment.endsWith(']')) {
    const name = segment.slice(4, -1)
    if (name === '') {
      throw new RouteFileError(`${file}: catch-all segment "[...]" needs a name, e.g. "[...path]".`)
    }
    // Four dots is still a typo; the fourth would become part of the parameter name.
    if (name.startsWith('.')) {
      throw new RouteFileError(
        `${file}: "[...${name}]" has too many dots. Write it as "[...${name.replace(/^\.+/, '')}]".`,
      )
    }
    return `*${name}`
  }

  if (segment.startsWith('[') && segment.endsWith(']')) {
    const name = segment.slice(1, -1)
    if (name === '') {
      throw new RouteFileError(`${file}: parameter segment "[]" needs a name, e.g. "[id]".`)
    }
    // A name beginning with a dot is almost always a mistyped catch-all. `[..path]` would
    // otherwise become a parameter literally named `..path`, and the route would never match.
    if (name.startsWith('.')) {
      throw new RouteFileError(
        `${file}: "[${name}]" looks like a mistyped catch-all. ` +
          `Write it as "[...${name.replace(/^\.+/, '')}]".`,
      )
    }
    return `:${name}`
  }

  // A bare bracket is almost always a typo for a parameter, and silently treating it as a
  // literal path segment produces a route nobody can hit.
  if (segment.includes('[') || segment.includes(']')) {
    throw new RouteFileError(
      `${file}: "${segment}" has an unmatched bracket. Use "[name]" or "[...name]".`,
    )
  }

  return segment
}

/**
 * Converts a route file path, relative to the routes directory, into a method and pattern.
 *
 * @param relativePath e.g. `users/[id].get.ts`
 * @returns `null` when the file is not a route module (a partial, a test, a helper)
 */
export function fileToRoute(relativePath: string): { method: HttpMethod; pattern: string } | null {
  const normalised = relativePath.split(sep).join('/')
  const withoutExtension = stripExtension(normalised)
  if (withoutExtension === null || withoutExtension === undefined) return null

  const segments = withoutExtension.split('/')
  const last = segments.pop()
  if (last === undefined) return null

  // Files and directories starting with `_` are private by convention — colocated helpers,
  // components, fixtures. `_middleware` is handled separately, before this is called.
  if (segments.some((segment) => segment.startsWith('_')) || last.startsWith('_')) return null

  const dot = last.lastIndexOf('.')
  if (dot === -1) {
    throw new RouteFileError(
      `${relativePath}: route files must name their method, e.g. "${last}.get.ts". ` +
        `Prefix the file with "_" if it is not a route.`,
    )
  }

  const methodPart = last.slice(dot + 1).toUpperCase()
  if (!isHttpMethod(methodPart)) {
    throw new RouteFileError(
      `${relativePath}: "${last.slice(dot + 1)}" is not an HTTP method. ` +
        `Use one of get, post, put, patch, delete, head, options.`,
    )
  }

  const name = last.slice(0, dot)
  if (name === '') {
    throw new RouteFileError(`${relativePath}: route files need a name before the method.`)
  }

  const patternSegments = segments.map((segment) => segmentToPattern(segment, relativePath))

  // `index` means "this directory", so it contributes no segment of its own.
  if (name !== 'index') {
    patternSegments.push(segmentToPattern(name, relativePath))
  }

  // A catch-all only makes sense as the final segment; anything after it is unreachable.
  for (let i = 0; i < patternSegments.length - 1; i++) {
    if (patternSegments[i]?.startsWith('*')) {
      throw new RouteFileError(
        `${relativePath}: a catch-all segment must be last, but something follows it.`,
      )
    }
  }

  return { method: methodPart, pattern: `/${patternSegments.join('/')}`.replace(/\/+$/, '') || '/' }
}

/** The prefix a `_middleware` file applies to, derived from its directory. */
export function middlewarePrefix(relativePath: string): string {
  const directory = dirname(relativePath.split(sep).join('/'))
  if (directory === '.' || directory === '') return '/'
  return `/${directory
    .split('/')
    .map((segment) => segmentToPattern(segment, relativePath))
    .join('/')}`
}

/**
 * Walks a directory and works out what each file means.
 *
 * Sorted for determinism: two machines scanning the same tree must produce the same table, or
 * a route conflict becomes a bug that only reproduces on someone else's laptop.
 */
export async function scanRoutes(dir: string): Promise<Discovery> {
  const glob = new Bun.Glob(`**/*{${EXTENSIONS.join(',')}}`)
  const routes: DiscoveredRoute[] = []
  const middleware: DiscoveredMiddleware[] = []

  const files: string[] = []
  for await (const file of glob.scan({ cwd: dir, onlyFiles: true })) {
    files.push(file)
  }
  files.sort()

  for (const relativePath of files) {
    const name = basename(relativePath)
    const stem = stripExtension(name)
    if (stem === undefined) continue

    // Test files sit next to the routes they cover; they are not endpoints.
    if (stem.endsWith('.test') || stem.endsWith('.spec')) continue

    if (stem === MIDDLEWARE_BASENAME) {
      middleware.push({ prefix: middlewarePrefix(relativePath), file: join(dir, relativePath) })
      continue
    }

    const route = fileToRoute(relativePath)
    if (route) routes.push({ ...route, file: join(dir, relativePath) })
  }

  // Outermost middleware first, so a root `_middleware` wraps everything beneath it.
  middleware.sort((a, b) => a.prefix.length - b.prefix.length)

  return { routes, middleware }
}

/**
 * A route defined with its schema, so the handler's context can be inferred.
 *
 * TypeScript cannot relate sibling module exports: with `export const body` and a separate
 * `export default (ctx) => ...`, nothing connects the two, and `ctx` is untyped. Pairing them in
 * one call is the only way the inference that makes §1.6 worthwhile survives into a route file.
 *
 * ```ts title="src/routes/users/[id].patch.ts"
 * export default defineRoute(
 *   {
 *     params: z.object({ id: z.uuid() }),
 *     body: z.object({ name: z.string() }),
 *   },
 *   (ctx) => db.user.update(ctx.params.id, ctx.body),  // both typed
 * )
 * ```
 */
export interface RouteDefinition {
  schema: RouteSchema
  handler: (ctx: Context) => unknown
  /** Distinguishes a definition from a bare handler at runtime. */
  readonly __oven: 'route'
}

export function defineRoute<const Schema extends RouteSchema>(
  schema: Schema,
  handler: ValidatedHandler<Schema, unknown>,
): RouteDefinition {
  // Erasing the schema relationship here is the same boundary `App.register` crosses: the route
  // table holds handlers for many different schemas, and no single signature covers them all.
  return { schema, handler: handler as unknown as (ctx: Context) => unknown, __oven: 'route' }
}

/** Whatever `.use()` contributed to an app's context. */
export type ContextOf<Application> = Application extends { __ext?: infer Ext } ? Ext : unknown

/**
 * `defineRoute`, bound to one app's bricks.
 *
 * `defineRoute` alone types `ctx.params`, `ctx.query` and `ctx.body` from the schema beside them,
 * but it cannot know what bricks the app registered — a route file and `app.ts` are separate
 * modules, and nothing connects them. So `ctx.db` in a route file was `unknown`, which quietly
 * gave up the framework's central promise in the one place most routes are written.
 *
 * Declare it once per project:
 *
 * ```ts title="src/route.ts"
 * import { routesFor } from '@theoven/core'
 * import type { app } from './app'
 *
 * export const route = routesFor<typeof app>()
 * ```
 *
 * ```ts title="src/routes/notes/index.get.ts"
 * import { route } from '../../route'
 *
 * export default route({ query: z.object({ limit: z.coerce.number() }) }, (ctx) =>
 *   ctx.db.select().from(notes).limit(ctx.query.limit),   // both typed
 * )
 * ```
 *
 * The import of `app` is **type-only**, so it does not create a cycle with the module that loads
 * these files.
 */
export function routesFor<Application>(): <const Schema extends RouteSchema>(
  schema: Schema,
  handler: ValidatedHandler<Schema, ContextOf<Application>>,
) => RouteDefinition {
  return (schema, handler) => ({
    schema,
    handler: handler as unknown as (ctx: Context) => unknown,
    __oven: 'route',
  })
}

/** True for the object `defineRoute` produces. */
function isRouteDefinition(value: unknown): value is RouteDefinition {
  return typeof value === 'object' && value !== null && '__oven' in value
}

/** What a route module is expected to export. */
export interface RouteModule extends RouteSchema {
  default?: ((ctx: Context) => unknown) | RouteDefinition
}

/** What a `_middleware` module is expected to export. */
export interface MiddlewareModule {
  default?: Middleware
}

const SCHEMA_KEYS = [
  'params',
  'query',
  'body',
  'headers',
  'response',
  'summary',
  'description',
  'tags',
  // `auth` is read off the schema by the auth brick (`requirementOf`). Leaving it out meant
  // `export const auth = true` was collected into nothing and the route served anonymously —
  // a guard that silently does not guard, which is worse than no guard at all.
  'auth',
] as const

/**
 * Pulls the handler and schema out of an imported route module.
 *
 * @throws {RouteFileError} naming the file and the specific problem
 */
export function readRouteModule(
  module: RouteModule,
  file: string,
): { handler: (ctx: Context) => unknown; schema: RouteSchema | undefined } {
  const exported = module.default

  if (exported === undefined) {
    throw new RouteFileError(
      `${file}: no default export. A route file must export its handler as the default.`,
    )
  }

  // The typed form: schema and handler declared together by `defineRoute`.
  if (isRouteDefinition(exported)) {
    if (typeof exported.handler !== 'function') {
      throw new RouteFileError(`${file}: defineRoute was given a handler that is not a function.`)
    }
    return { handler: exported.handler, schema: exported.schema }
  }

  const handler = exported
  if (typeof handler !== 'function') {
    throw new RouteFileError(
      `${file}: the default export is ${typeof handler}, not a function. ` +
        `Export the handler itself, not the result of calling it — or use defineRoute(schema, handler).`,
    )
  }

  const schema: Record<string, unknown> = {}
  for (const key of SCHEMA_KEYS) {
    if (module[key] !== undefined) schema[key] = module[key]
  }

  return {
    handler,
    schema: Object.keys(schema).length > 0 ? (schema as RouteSchema) : undefined,
  }
}

export interface LoadOptions {
  /** Appended to each import specifier to defeat the module cache during hot reload. */
  cacheBust?: string
  /** Skip the prebuilt manifest even when one is registered. Used by tests. */
  ignoreManifest?: boolean
}

/**
 * A prebuilt route registrar, installed by the bundled entry `oven build` generates.
 *
 * The problem this solves: a bundle has no `src/routes` directory to walk, so `loadRoutes`
 * would look for one relative to `dist/` and fail. Rather than make every app write
 * `if (production)` around its route loading, the build installs the manifest here and
 * `loadRoutes` uses it instead of touching the filesystem. The app's own code is identical in
 * development and production, which is the only way the two stay in agreement.
 */
let manifest: ((app: App) => void) | undefined

/** Called by the generated entry before the app module is imported. */
export function setRouteManifest(register: (app: App) => void): void {
  manifest = register
}

/** Whether a prebuilt manifest is installed. */
export function hasRouteManifest(): boolean {
  return manifest !== undefined
}

/** Clears the manifest. Tests use this; nothing else should need it. */
export function clearRouteManifest(): void {
  manifest = undefined
}

/**
 * Scans a directory and registers everything it finds.
 *
 * Middleware is registered before routes so a root `_middleware` is outermost regardless of
 * the order files happen to be walked in.
 */
export async function loadRoutes(
  app: App,
  dir: string,
  options: LoadOptions = {},
): Promise<Discovery> {
  // In a production bundle there is no routes directory to walk. The generated entry has
  // already installed a manifest of static imports, so use that and skip the filesystem.
  if (manifest && !options.ignoreManifest) {
    manifest(app)
    return {
      routes: app.routes().map((route) => ({ ...route, file: '<manifest>' })),
      middleware: [],
    }
  }

  /**
   * A schema's type is only known inside the route file, where the user's own handler signature
   * is checked against it. By the time it reaches here it is a runtime value, so the framework
   * cannot reconstruct that relationship — the same reason `App.register` erases it internally.
   * One narrow view of the app, cast once, rather than a cast at every call.
   */
  const registrar = app as unknown as {
    route(method: HttpMethod, path: string, handler: (ctx: Context) => unknown): void
    route(
      method: HttpMethod,
      path: string,
      schema: RouteSchema,
      handler: (ctx: Context) => unknown,
    ): void
  }

  const discovery = await scanRoutes(dir)
  const suffix = options.cacheBust ? `?v=${options.cacheBust}` : ''

  for (const entry of discovery.middleware) {
    const module = (await import(entry.file + suffix)) as MiddlewareModule
    if (typeof module.default !== 'function') {
      throw new RouteFileError(
        `${entry.file}: a _middleware file must default-export a middleware function.`,
      )
    }
    app.use(entry.prefix, module.default)
  }

  for (const entry of discovery.routes) {
    const module = (await import(entry.file + suffix)) as RouteModule
    const { handler, schema } = readRouteModule(module, entry.file)

    if (schema) registrar.route(entry.method, entry.pattern, schema, handler)
    else registrar.route(entry.method, entry.pattern, handler)
  }

  return discovery
}

/**
 * Emits a module that registers every route with static imports.
 *
 * Production should not walk the filesystem at boot: the tree is already known at build time,
 * and a static manifest lets the bundler see every route module — which is what makes
 * tree-shaking and a single-file build possible at all.
 */
export async function generateManifest(dir: string, from = dir): Promise<string> {
  const { routes, middleware } = await scanRoutes(dir)

  const lines: string[] = [
    '// Generated by `oven build`. Do not edit.',
    '//',
    '// Static imports on purpose: production must not scan the filesystem at boot, and a',
    '// bundler can only see route modules that are imported by name.',
    "import type { App } from '@theoven/core'",
    "import { readRouteModule } from '@theoven/core'",
    '',
  ]

  const importPath = (file: string): string => {
    const rel = relative(from, file).split(sep).join('/')
    return rel.startsWith('.') ? rel : `./${rel}`
  }

  middleware.forEach((entry, index) => {
    lines.push(`import m${index} from '${importPath(entry.file)}'`)
  })
  routes.forEach((entry, index) => {
    lines.push(`import * as r${index} from '${importPath(entry.file)}'`)
  })

  lines.push('', 'export function registerRoutes(app: App): void {')

  middleware.forEach((entry, index) => {
    lines.push(`  app.use('${entry.prefix}', m${index})`)
  })
  routes.forEach((entry, index) => {
    lines.push(`  {`)
    lines.push(`    const { handler, schema } = readRouteModule(r${index}, '${entry.file}')`)
    lines.push(
      `    if (schema) app.route('${entry.method}', '${entry.pattern}', schema, handler)`,
      `    else app.route('${entry.method}', '${entry.pattern}', handler)`,
    )
    lines.push(`  }`)
  })

  lines.push('}', '')
  return lines.join('\n')
}
