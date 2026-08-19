import {
  type Attributes,
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from '@opentelemetry/api'
import type { Context, Middleware } from '@theoven/core'

export interface TelemetryOptions {
  /** Tracer name, as it appears in your backend. Default `@theoven/core`. */
  name?: string
  version?: string
  /**
   * Paths never traced, as exact matches or prefixes ending in `*`.
   *
   * Health checks default in: a liveness probe every second is the loudest thing in a trace
   * backend and tells you nothing.
   */
  ignore?: readonly string[]
  /** Add your own attributes per request — a tenant id, a plan, a feature flag. */
  attributes?: (ctx: Context) => Attributes
  /**
   * Record the route pattern rather than the raw path. On by default.
   *
   * `/users/:id` groups; `/users/8f14e45f` does not, and a backend that sees a million distinct
   * span names cannot aggregate anything.
   */
  useRoutePattern?: boolean
}

/**
 * OpenTelemetry tracing.
 *
 * Brings no SDK and no exporter: you configure those, exactly as you would for any other
 * OpenTelemetry application, and this uses whatever is globally registered. A framework shipping
 * its own exporter would own that dependency's release cadence forever, and users would have two
 * ways to configure the same thing.
 *
 * ```ts
 * import { NodeSDK } from '@opentelemetry/sdk-node'
 * new NodeSDK({ traceExporter }).start()
 *
 * app.use(telemetry())
 * ```
 */
export function telemetry(options: TelemetryOptions = {}): Middleware {
  const tracer: Tracer = trace.getTracer(
    options.name ?? '@theoven/core',
    options.version ?? undefined,
  )
  const ignore = options.ignore ?? ['/health', '/healthz', '/_oven/*']
  const useRoutePattern = options.useRoutePattern ?? true

  return async (ctx, next) => {
    if (isIgnored(ctx.path, ignore)) return next()

    /**
     * Continue an incoming trace rather than starting a new one.
     *
     * Without this a request arriving from another service becomes a disconnected root span, and
     * the distributed part of distributed tracing quietly does not work.
     */
    const parent = propagation.extract(context.active(), headersOf(ctx))

    return context.with(parent, () =>
      tracer.startActiveSpan(
        `${ctx.method} ${ctx.path}`,
        {
          kind: SpanKind.SERVER,
          attributes: {
            'http.request.method': ctx.method,
            'url.path': ctx.path,
            'url.scheme': ctx.url.protocol.replace(':', ''),
            'server.address': ctx.header('host') ?? '',
            'user_agent.original': ctx.header('user-agent') ?? '',
            ...(ctx.ip ? { 'client.address': ctx.ip } : {}),
            'oven.request_id': ctx.id,
          },
        },
        async (span: Span) => {
          try {
            const result = await next()

            const status = statusOf(result, ctx)
            span.setAttribute('http.response.status_code', status)

            /**
             * Only 5xx marks the span as failed.
             *
             * A 404 or a 422 is the server working correctly — a client asked for something that
             * is not there, or sent something invalid. Marking those as errors makes an error
             * rate that is mostly other people's typos, and nobody looks at a dashboard that is
             * always red.
             */
            if (status >= 500) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${status}` })
            }

            if (useRoutePattern) {
              const pattern = ctx.routePattern
              if (pattern) {
                span.setAttribute('http.route', pattern)
                span.updateName(`${ctx.method} ${pattern}`)
              }
            }

            if (options.attributes) span.setAttributes(options.attributes(ctx))

            return result
          } catch (thrown) {
            /**
             * A thrown error is not automatically a failed span.
             *
             * `throw new NotFound()` is the documented way to answer 404 in this framework, so
             * marking every throw as an error would put every missing page in the error rate —
             * the same mistake as marking a 4xx response as one, arrived at from the other side.
             * The status carried by the error decides, exactly as it does for a returned one.
             */
            const status = (thrown as { status?: number }).status ?? 500
            span.setAttribute('http.response.status_code', status)

            if (status >= 500) {
              span.recordException(thrown as Error)
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: thrown instanceof Error ? thrown.message : String(thrown),
              })
            }

            if (useRoutePattern && ctx.routePattern) {
              span.setAttribute('http.route', ctx.routePattern)
              span.updateName(`${ctx.method} ${ctx.routePattern}`)
            }

            // Re-thrown either way: the framework still owes the client its problem+json.
            throw thrown
          } finally {
            span.end()
          }
        },
      ),
    )
  }
}

/**
 * The current trace and span ids, for putting on a log line.
 *
 * A trace you cannot get from a log line, and a log line you cannot get from a trace, are two
 * tools instead of one.
 *
 * ```ts
 * ctx.log.info('charged', { amount, ...traceIds() })
 * ```
 */
export function traceIds(): { traceId?: string; spanId?: string } {
  const span = trace.getActiveSpan()
  if (!span) return {}

  const { traceId, spanId } = span.spanContext()
  return { traceId, spanId }
}

/**
 * Runs `work` inside its own span.
 *
 * For the parts of a request worth seeing separately — a third-party call, an expensive query.
 *
 * ```ts
 * const rates = await span('fetch-rates', () => fetch(url).then((r) => r.json()))
 * ```
 */
export async function span<Result>(
  name: string,
  work: (span: Span) => Result | Promise<Result>,
  attributes: Attributes = {},
): Promise<Result> {
  const tracer = trace.getTracer('@theoven/core')

  return tracer.startActiveSpan(name, { attributes }, async (active) => {
    try {
      return await work(active)
    } catch (thrown) {
      active.recordException(thrown as Error)
      active.setStatus({
        code: SpanStatusCode.ERROR,
        message: thrown instanceof Error ? thrown.message : String(thrown),
      })
      throw thrown
    } finally {
      active.end()
    }
  })
}

function isIgnored(path: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern) {
      return true
    }
  }
  return false
}

/** Propagation needs a plain record; `Headers` is not one. */
function headersOf(ctx: Context): Record<string, string> {
  const carrier: Record<string, string> = {}
  ctx.req.headers.forEach((value, key) => {
    carrier[key] = value
  })
  return carrier
}

function statusOf(result: unknown, ctx: Context): number {
  if (result instanceof Response) return result.status
  if (ctx.status !== undefined) return ctx.status
  return result === null ? 204 : 200
}
