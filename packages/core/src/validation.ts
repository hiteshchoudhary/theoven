import type { Context } from './context'
import type { Dependency } from './dependency'
import { UnprocessableContent } from './errors'
import type { ParsedQuery } from './query'
import type { RouteParams } from './router/types'
import { formatPath, type StandardSchemaV1 } from './standard-schema'

/**
 * Request and response schemas for one route.
 *
 * This is Oven's answer to FastAPI's type hints. Python could validate, type and document an
 * endpoint from one declaration because its hints survive to runtime; TypeScript's do not, so a
 * schema takes their place and does the same three jobs:
 *
 *   1. **Validation** — a bad request never reaches the handler.
 *   2. **Types** — `ctx.body` is the parsed output, inferred. No generics to write.
 *   3. **Documentation** — the same schema generates the OpenAPI operation (§1.9).
 *
 * Any Standard Schema validator works. Zod is the default because it emits JSON Schema, which
 * is what makes the third job free.
 */
export interface RouteSchema {
  params?: StandardSchemaV1
  query?: StandardSchemaV1
  body?: StandardSchemaV1
  headers?: StandardSchemaV1
  /** Response schemas by status code. Checked in development; see `validateResponses`. */
  response?: Record<number, StandardSchemaV1>
  /**
   * Authorization requirement for this route.
   *
   * Core never interprets this — it carries it to bricks through `request()`, and the auth
   * brick decides what `true` or `'admin'` means. Typed as `unknown` deliberately: the moment
   * core knows the shape, core owns auth, and auth stops being replaceable.
   */
  auth?: unknown
  /**
   * Things this route needs, resolved per request (D31).
   *
   * Core never resolves these itself beyond calling them — what a dependency *is* stays the
   * caller's business, the same way `auth` is carried and not interpreted.
   */
  deps?: Record<string, Dependency<unknown>>
  /** Shown in the generated OpenAPI document. */
  summary?: string
  description?: string
  tags?: string[]
}

/** Where a validation failure happened. Included in the error so a client can act on it. */
export type IssueLocation = 'params' | 'query' | 'body' | 'headers' | 'response'

export interface ValidationIssue {
  location: IssueLocation
  /** Dotted path within that location, e.g. `user.emails[0]`. Empty for the root value. */
  path: string
  message: string
}

/** Resolves a schema's output type, falling back when no schema is declared. */
type Output<Schema, Fallback> = Schema extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<Schema>
  : Fallback

/**
 * Narrows `user` to non-null on a guarded route.
 *
 * A route declaring `auth: true` is unreachable while anonymous — the auth brick rejects the
 * request before the handler runs — so `ctx.user` cannot be null inside it, and forcing every
 * guarded handler to write `ctx.user!.id` would be the type system lying in the safe direction.
 *
 * This is the one auth-shaped name core knows, and it is knowledge at the type level only:
 * nothing here imports from an auth package, and an app with no auth brick is untouched because
 * `Ext` has no `user` to narrow. Core still never interprets what `auth: 'admin'` *means* — see
 * `RouteSchema.auth`.
 */
type NarrowUser<Schema extends RouteSchema, Ext> = Schema['auth'] extends
  | true
  | string
  | readonly string[]
  ? Ext extends { user: infer User }
    ? Omit<Ext, 'user'> & { user: NonNullable<User> }
    : Ext
  : Ext

/**
 * The context a validated handler receives.
 *
 * `params`, `query`, `body` and `headers` are replaced by their validated, typed forms. Note
 * that `body` becomes the value rather than a promise: validation has already awaited it, so
 * making the handler await again would be ceremony with no purpose.
 */
export type ValidatedContext<Schema extends RouteSchema, Ext> = Omit<
  Context,
  'params' | 'query' | 'body'
> &
  NarrowUser<Schema, Ext> & {
    params: Output<Schema['params'], RouteParams>
    query: Output<Schema['query'], ParsedQuery>
    body: Schema['body'] extends StandardSchemaV1
      ? StandardSchemaV1.InferOutput<Schema['body']>
      : Promise<unknown>
    headers: Output<Schema['headers'], never>
    deps: ResolvedDeps<Schema['deps']>
  }

/** Maps a route's declared dependencies to the values they resolve to. */
export type ResolvedDeps<Declared> =
  Declared extends Record<string, Dependency<unknown>>
    ? { [Key in keyof Declared]: Declared[Key] extends Dependency<infer Value> ? Value : never }
    : Record<never, never>

/** A handler for a route that declares schemas. */
export type ValidatedHandler<Schema extends RouteSchema, Ext> = (
  ctx: ValidatedContext<Schema, Ext>,
) => unknown

async function check(
  schema: StandardSchemaV1,
  value: unknown,
  location: IssueLocation,
  issues: ValidationIssue[],
): Promise<unknown> {
  const result = await schema['~standard'].validate(value)

  if (result.issues) {
    for (const issue of result.issues) {
      issues.push({ location, path: formatPath(issue.path), message: issue.message })
    }
    return undefined
  }

  return result.value
}

/**
 * Overrides a context property with its validated form.
 *
 * An own property shadows the prototype getter, so `ctx.body` returns the validated value with
 * no branching in the getter itself — the unvalidated path keeps costing exactly what it did.
 */
function override(ctx: Context, key: string, value: unknown): void {
  Object.defineProperty(ctx, key, { value, enumerable: true, configurable: true, writable: true })
}

/**
 * Validates a request against a route's schemas, replacing the context properties in place.
 *
 * **Every location is checked before failing.** Reporting only the first problem turns fixing a
 * request into a guessing game one field at a time; a client should learn everything wrong with
 * its payload in a single round trip.
 *
 * @throws {UnprocessableContent} a 422 carrying every issue found
 */
export async function validateRequest(ctx: Context, schema: RouteSchema): Promise<void> {
  const issues: ValidationIssue[] = []

  if (schema.params) {
    const value = await check(schema.params, ctx.params, 'params', issues)
    if (issues.length === 0) override(ctx, 'params', value)
  }

  if (schema.query) {
    const value = await check(schema.query, ctx.query, 'query', issues)
    if (value !== undefined) override(ctx, 'query', value)
  }

  if (schema.headers) {
    // Headers are presented as a plain lowercase-keyed object: schema libraries cannot describe
    // the case-insensitive `Headers` interface, and `x-api-key` is how people write the key.
    const headers: Record<string, string> = {}
    for (const [name, value] of ctx.req.headers) headers[name] = value
    const value = await check(schema.headers, headers, 'headers', issues)
    if (value !== undefined) override(ctx, 'headers', value)
  }

  if (schema.body) {
    // Parsing can fail on its own — malformed JSON is a 400, not a 422 — and that error should
    // surface as itself rather than being folded into a validation report.
    const parsed = await ctx.body
    const value = await check(schema.body, parsed, 'body', issues)
    if (value !== undefined) override(ctx, 'body', value)
  }

  if (issues.length > 0) {
    throw new UnprocessableContent('Request validation failed.', { detail: { errors: issues } })
  }
}

/**
 * Checks a handler's result against the response schema for its status, and returns the parsed
 * value.
 *
 * The parsed value matters as much as the issues (D29). A Zod object strips keys it does not
 * declare, so parsing a database row against the schema is what removes the `passwordHash`
 * nobody meant to send. Returning only the issues — as this did — computed that safety and threw
 * it away.
 *
 * A failure here is a bug in *our* code, not in the caller's request, so it is a 500 rather
 * than a 422 — and the detail only reaches the client in development, where it is a fast way to
 * notice a route that has drifted from its contract.
 *
 * `value` is `undefined` when there are issues: there is no trustworthy parse to hand back, and
 * the caller decides what to do with the original.
 */
export async function validateResponse(
  schema: RouteSchema,
  status: number,
  value: unknown,
): Promise<{ issues: ValidationIssue[]; value: unknown; checked: boolean }> {
  const responseSchema = schema.response?.[status]
  if (!responseSchema) return { issues: [], value, checked: false }

  const issues: ValidationIssue[] = []
  const parsed = await check(responseSchema, value, 'response', issues)
  return { issues, value: issues.length > 0 ? undefined : parsed, checked: true }
}
