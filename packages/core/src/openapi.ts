import { z } from 'zod'
import type { Brick } from './brick'
import type { Logger } from './logger'
import type { HttpMethod } from './router/types'
import type { StandardSchemaV1 } from './standard-schema'
import type { RouteSchema } from './validation'

/**
 * OpenAPI generation.
 *
 * This is the second dividend on §1.6. The schemas already validate the request and type the
 * handler; describing the endpoint is the third job they were always going to do, and it costs
 * the user nothing further. A docs page that drifts from the implementation is worse than no
 * docs page, and the only way to stop that is to derive one from the other.
 */

/** A route as the generator sees it. */
export interface RouteInfo {
  method: HttpMethod
  pattern: string
  schema: RouteSchema | undefined
}

export interface OpenApiInfo {
  title?: string
  version?: string
  description?: string
}

export interface OpenApiOptions {
  info?: OpenApiInfo
  servers?: Array<{ url: string; description?: string }>
  /** Where the document is served. Default `/openapi.json`. */
  path?: string
  /** Where the browsable UI is served. `false` to omit it. Default `/docs`. */
  ui?: string | false
  /** Security schemes, keyed by name. The auth module contributes these once it exists. */
  securitySchemes?: Record<string, unknown>
  /** Security requirements applied to every operation. */
  security?: Array<Record<string, string[]>>
  tags?: Array<{ name: string; description?: string }>
  /** Paths to leave out — the spec and UI routes exclude themselves by default. */
  exclude?: string[]
}

type JsonSchema = Record<string, unknown>

/**
 * Converts a Standard Schema into JSON Schema.
 *
 * Only Zod can do this today: `z.toJSONSchema` is why Zod is the bundled default (D4). Other
 * validators are still accepted for validation — they just cannot describe themselves, so the
 * operation is documented permissively rather than wrongly. Saying "any value" is honest;
 * inventing a shape would not be.
 */
function toJsonSchema(
  schema: StandardSchemaV1,
  io: 'input' | 'output',
  onUnsupported?: (vendor: string) => void,
): JsonSchema {
  const vendor = schema['~standard'].vendor

  if (vendor !== 'zod') {
    onUnsupported?.(vendor)
    return {}
  }

  try {
    const converted = z.toJSONSchema(schema as z.ZodType, {
      io,
      // A schema containing something JSON Schema cannot express (a transform, a custom
      // refinement) should widen that field, not abort the whole document.
      unrepresentable: 'any',
    }) as JsonSchema
    // `$schema` is meaningful in a standalone document and noise inside an OpenAPI operation.
    delete converted.$schema
    return converted
  } catch {
    onUnsupported?.(vendor)
    return {}
  }
}

/** Router pattern to OpenAPI path: `/users/:id` becomes `/users/{id}`. */
export function toOpenApiPath(pattern: string): string {
  return pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) return `{${segment.slice(1)}}`
      if (segment.startsWith('*')) return `{${segment.slice(1) || 'wildcard'}}`
      return segment
    })
    .join('/')
}

/**
 * Path-parameter names in a router pattern, in order.
 *
 * `/files/*path` and `/users/:id` both put a `{name}` into the OpenAPI path template, and the
 * spec requires every one of those to have a matching parameter object. A route with a path
 * parameter and no `params` schema is the common case, so these are derived from the pattern
 * rather than assumed to come from a schema.
 */
export function pathParameterNames(pattern: string): string[] {
  const names: string[] = []
  for (const segment of pattern.split('/')) {
    if (segment.startsWith(':')) names.push(segment.slice(1))
    else if (segment.startsWith('*')) names.push(segment.slice(1) || 'wildcard')
  }
  return names
}

/** True when a JSON Schema describes binary content anywhere in its properties. */
function hasBinary(schema: JsonSchema): boolean {
  if (schema.format === 'binary') return true
  const properties = schema.properties as Record<string, JsonSchema> | undefined
  if (!properties) return false
  return Object.values(properties).some((property) => hasBinary(property))
}

/** Expands an object schema into OpenAPI parameter objects. */
function toParameters(schema: JsonSchema, location: 'path' | 'query' | 'header'): JsonSchema[] {
  const properties = schema.properties as Record<string, JsonSchema> | undefined
  if (!properties) return []

  const required = new Set((schema.required as string[] | undefined) ?? [])

  return Object.entries(properties).map(([name, property]) => {
    const parameter: JsonSchema = {
      name,
      in: location,
      // A path parameter is part of the URL, so it is required whatever the schema says.
      required: location === 'path' ? true : required.has(name),
      schema: property,
    }
    if (typeof property.description === 'string') parameter.description = property.description
    return parameter
  })
}

/**
 * Builds an OpenAPI 3.1 document from a route table.
 *
 * 3.1 rather than 3.0 because its schema dialect *is* JSON Schema 2020-12 — the same thing
 * `z.toJSONSchema` emits. Targeting 3.0 would mean down-converting every schema and losing
 * fidelity on the way.
 */
export function generateOpenApi(
  routes: readonly RouteInfo[],
  options: OpenApiOptions = {},
  logger?: Logger,
): JsonSchema {
  const excluded = new Set(options.exclude ?? [])
  const unsupportedVendors = new Set<string>()
  const noteUnsupported = (vendor: string) => unsupportedVendors.add(vendor)

  const paths: Record<string, JsonSchema> = {}

  for (const route of routes) {
    if (excluded.has(route.pattern)) continue
    // HEAD is served from GET and carries no separate contract; documenting it would double
    // every path for no reader benefit.
    if (route.method === 'HEAD') continue

    const path = toOpenApiPath(route.pattern)
    const schema = route.schema
    const operation: JsonSchema = {}

    if (schema?.summary) operation.summary = schema.summary
    if (schema?.description) operation.description = schema.description
    if (schema?.tags?.length) operation.tags = schema.tags

    const parameters: JsonSchema[] = []
    if (schema?.params) {
      parameters.push(
        ...toParameters(toJsonSchema(schema.params, 'input', noteUnsupported), 'path'),
      )
    }
    if (schema?.query) {
      parameters.push(
        ...toParameters(toJsonSchema(schema.query, 'input', noteUnsupported), 'query'),
      )
    }
    if (schema?.headers) {
      parameters.push(
        ...toParameters(toJsonSchema(schema.headers, 'input', noteUnsupported), 'header'),
      )
    }
    // Every `{name}` in the path template needs a parameter object, whether or not the route
    // declared a schema. Without this, any route with a path parameter and no `params` schema
    // produces a document real tooling rejects.
    const declared = new Set(
      parameters.filter((entry) => entry.in === 'path').map((entry) => entry.name as string),
    )
    for (const name of pathParameterNames(route.pattern)) {
      if (declared.has(name)) continue
      parameters.push({ name, in: 'path', required: true, schema: { type: 'string' } })
    }

    if (parameters.length > 0) operation.parameters = parameters

    if (schema?.body) {
      const bodySchema = toJsonSchema(schema.body, 'input', noteUnsupported)
      // An upload is multipart, and saying `application/json` would make every generated client
      // send the wrong thing.
      const contentType = hasBinary(bodySchema) ? 'multipart/form-data' : 'application/json'
      operation.requestBody = {
        required: true,
        content: { [contentType]: { schema: bodySchema } },
      }
    }

    const responses: Record<string, JsonSchema> = {}
    for (const [status, responseSchema] of Object.entries(schema?.response ?? {})) {
      responses[status] = {
        description: statusText(Number(status)),
        content: {
          'application/json': { schema: toJsonSchema(responseSchema, 'output', noteUnsupported) },
        },
      }
    }
    if (Object.keys(responses).length === 0) {
      responses['200'] = { description: 'Successful response' }
    }

    // Any route that validates input can reject it, and a client generator should know the
    // shape it will get back.
    if (schema?.params || schema?.query || schema?.body || schema?.headers) {
      responses['422'] = {
        description: 'Request validation failed',
        content: { 'application/problem+json': { schema: PROBLEM_SCHEMA } },
      }
    }

    operation.responses = responses

    paths[path] ??= {}
    ;(paths[path] as Record<string, unknown>)[route.method.toLowerCase()] = operation
  }

  // A document with nothing in it is almost always a mistake: the brick was installed before
  // any routes were registered, or `exclude` matched more than intended. The 3.1 spec permits an
  // empty `paths`, but strict validators reject a document with no entries anywhere, so this is
  // worth saying out loud rather than serving quietly.
  if (Object.keys(paths).length === 0) {
    logger?.warn('The OpenAPI document has no paths', {
      note: 'No routes were documented. Strict validators reject a document with no entries.',
    })
  }

  if (unsupportedVendors.size > 0) {
    logger?.warn('Some schemas could not be described in OpenAPI', {
      vendors: [...unsupportedVendors],
      note: 'Only Zod can emit JSON Schema today; those operations are documented permissively.',
    })
  }

  const document: JsonSchema = {
    openapi: '3.1.0',
    info: {
      title: options.info?.title ?? 'API',
      version: options.info?.version ?? '0.0.0',
      ...(options.info?.description ? { description: options.info.description } : {}),
    },
    paths,
  }

  if (options.servers?.length) document.servers = options.servers
  if (options.tags?.length) document.tags = options.tags
  if (options.securitySchemes && Object.keys(options.securitySchemes).length > 0) {
    document.components = { securitySchemes: options.securitySchemes }
  }
  if (options.security?.length) document.security = options.security

  return document
}

/** The RFC 9457 shape every Oven error uses, so clients can generate one error type. */
const PROBLEM_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          location: { type: 'string' },
          path: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
  },
  required: ['type', 'title', 'status'],
}

function statusText(status: number): string {
  const known: Record<number, string> = {
    200: 'Successful response',
    201: 'Created',
    202: 'Accepted',
    204: 'No content',
    301: 'Moved permanently',
    302: 'Found',
    400: 'Bad request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not found',
    409: 'Conflict',
    413: 'Payload too large',
    415: 'Unsupported media type',
    422: 'Request validation failed',
    429: 'Too many requests',
    500: 'Internal server error',
  }
  return known[status] ?? `Response ${status}`
}

/**
 * The HTML for the browsable API reference.
 *
 * Scalar is loaded from its CDN, the same way FastAPI loads Swagger UI. Vendoring a megabyte of
 * JavaScript into `@theoven/core` would make every install pay for a page most deployments
 * never open — and the page is inert without network access anyway, since it fetches the spec.
 */
export function docsHtml(specPath: string, title: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <script id="api-reference" data-url="${escapeHtml(specPath)}"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Serves the generated document and a browsable UI.
 *
 * ```ts
 * app.use(openapi({ info: { title: 'My API', version: '1.0.0' } }))
 * ```
 *
 * Generation is deferred to the first request rather than done at boot, because bricks
 * registered after this one are still adding their routes while setup runs — generating early
 * would document a partial API.
 */
export function openapi(options: OpenApiOptions = {}): Brick<'openapi', OpenApiService> {
  const specPath = options.path ?? '/openapi.json'
  const uiPath = options.ui === false ? null : (options.ui ?? '/docs')

  return {
    name: 'openapi',
    setup: (context) => {
      let cached: JsonSchema | undefined

      const exclude = [...(options.exclude ?? []), specPath]
      if (uiPath) exclude.push(uiPath)

      const build = (): JsonSchema => {
        const fragments = context.app.openApiFragments()
        return generateOpenApi(
          context.app.routeTable(),
          {
            ...options,
            exclude,
            securitySchemes: { ...fragments.securitySchemes, ...options.securitySchemes },
            ...(options.tags
              ? { tags: options.tags }
              : fragments.tags.length > 0
                ? { tags: fragments.tags }
                : {}),
          },
          context.app.logger,
        )
      }

      const service: OpenApiService = {
        document: () => {
          // Cached after the first build: the route table cannot change once serving starts.
          cached ??= build()
          return cached
        },
        specPath,
        uiPath,
      }

      context.route('GET', specPath, (ctx) => {
        ctx.set('content-type', 'application/json; charset=utf-8')
        return service.document()
      })

      if (uiPath) {
        context.route('GET', uiPath, (ctx) => {
          ctx.set('content-type', 'text/html; charset=utf-8')
          return docsHtml(specPath, options.info?.title ?? 'API reference')
        })
      }

      return service
    },
  }
}

/** What `ctx.openapi` exposes — useful for emitting the spec from a CLI or a test. */
export interface OpenApiService {
  /** The generated document, built once on first use. */
  document(): JsonSchema
  specPath: string
  uiPath: string | null
}
