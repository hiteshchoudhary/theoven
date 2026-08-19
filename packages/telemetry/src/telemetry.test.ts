import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { context, propagation, type Span, SpanStatusCode, trace } from '@opentelemetry/api'
import { createApp, NotFound, silentLogger } from '@theoven/core'
import { span, telemetry, traceIds } from './telemetry'

/**
 * A minimal in-memory tracer, registered globally the way a real SDK would be.
 *
 * Recording what the middleware actually produces — names, attributes, statuses — rather than
 * asserting that some function was called. A test against a mock tracer proves the mock works.
 */
interface Recorded {
  name: string
  attributes: Record<string, unknown>
  status?: { code: SpanStatusCode; message?: string }
  exceptions: unknown[]
  ended: boolean
}

const recorded: Recorded[] = []

function makeSpan(name: string): Span & { record: Recorded } {
  const record: Recorded = { name, attributes: {}, exceptions: [], ended: false }
  recorded.push(record)

  const self = {
    record,
    spanContext: () => ({ traceId: 'trace-1', spanId: 'span-1', traceFlags: 1 }),
    setAttribute: (key: string, value: unknown) => {
      record.attributes[key] = value
      return self
    },
    setAttributes: (attributes: Record<string, unknown>) => {
      Object.assign(record.attributes, attributes)
      return self
    },
    setStatus: (status: { code: SpanStatusCode; message?: string }) => {
      record.status = status
      return self
    },
    updateName: (next: string) => {
      record.name = next
      return self
    },
    recordException: (error: unknown) => {
      record.exceptions.push(error)
    },
    end: () => {
      record.ended = true
    },
    isRecording: () => true,
    addEvent: () => self,
    addLink: () => self,
    addLinks: () => self,
  }
  return self as unknown as Span & { record: Recorded }
}

let extracted: string[] = []

beforeEach(() => {
  recorded.length = 0
  extracted = []

  trace.getTracer = () =>
    ({
      startActiveSpan: (name: string, options: unknown, fn: (s: Span) => unknown) => {
        const attributes = (options as { attributes?: Record<string, unknown> })?.attributes ?? {}
        const created = makeSpan(name)
        Object.assign(created.record.attributes, attributes)
        return fn(created)
      },
      startSpan: (name: string) => makeSpan(name),
    }) as never

  propagation.extract = (active, carrier) => {
    // Record that propagation was consulted, and with what.
    const headers = carrier as Record<string, string>
    if (headers.traceparent) extracted.push(headers.traceparent)
    return active
  }
})

const opened: Array<{ close(options?: { timeout?: number }): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 0 })))
})

function withTelemetry(options = {}) {
  const app = createApp({ logger: silentLogger })
  opened.push(app)
  app.use(telemetry(options))
  return app
}

describe('request spans', () => {
  test('a span is created, named by route and ended', async () => {
    const app = withTelemetry()
    app.get('/users/:id', () => ({ ok: true }))
    await app.ready()

    await app.fetch(new Request('https://x/users/8f14e45f'))

    expect(recorded).toHaveLength(1)
    // The pattern, not the path — a backend seeing a million distinct names cannot aggregate.
    expect(recorded[0]?.name).toBe('GET /users/:id')
    expect(recorded[0]?.attributes['http.route']).toBe('/users/:id')
    expect(recorded[0]?.attributes['url.path']).toBe('/users/8f14e45f')
    expect(recorded[0]?.ended).toBe(true)
  })

  test('it carries the standard HTTP attributes and the request id', async () => {
    const app = withTelemetry()
    app.get('/x', () => 'ok')
    await app.ready()

    await app.fetch(new Request('https://x/x', { headers: { 'user-agent': 'test-agent' } }))

    const attributes = recorded[0]?.attributes ?? {}
    expect(attributes['http.request.method']).toBe('GET')
    expect(attributes['http.response.status_code']).toBe(200)
    expect(attributes['user_agent.original']).toBe('test-agent')
    expect(attributes['oven.request_id']).toBeTruthy()
  })

  /**
   * A 404 or a 422 is the server working correctly. Marking those as errors produces an error
   * rate made of other people's typos, and nobody looks at a dashboard that is always red.
   */
  test('4xx is not an error, 5xx is', async () => {
    const app = withTelemetry()
    app.get('/missing', () => {
      throw new NotFound('nope')
    })
    app.get('/broken', () => {
      throw new Error('genuinely broken')
    })
    await app.ready()

    await app.fetch(new Request('https://x/missing'))
    expect(recorded[0]?.status?.code).not.toBe(SpanStatusCode.ERROR)
    expect(recorded[0]?.attributes['http.response.status_code']).toBe(404)
    // A missing page is not an exception worth recording either.
    expect(recorded[0]?.exceptions).toHaveLength(0)

    await app.fetch(new Request('https://x/broken'))
    expect(recorded[1]?.status?.code).toBe(SpanStatusCode.ERROR)
    expect(recorded[1]?.exceptions).toHaveLength(1)
  })

  test('a thrown error is recorded and still reaches the client', async () => {
    const app = withTelemetry()
    app.get('/x', () => {
      throw new Error('boom')
    })
    await app.ready()

    const response = await app.fetch(new Request('https://x/x'))

    // Recorded on the span *and* answered as problem+json.
    expect(recorded[0]?.exceptions).toHaveLength(1)
    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toContain('problem+json')
    expect(recorded[0]?.ended).toBe(true)
  })

  test('custom attributes are added', async () => {
    const app = withTelemetry({ attributes: () => ({ 'app.tenant': 'acme' }) })
    app.get('/x', () => 'ok')
    await app.ready()

    await app.fetch(new Request('https://x/x'))
    expect(recorded[0]?.attributes['app.tenant']).toBe('acme')
  })
})

describe('ignored paths', () => {
  // A liveness probe every second is the loudest thing in a trace backend and says nothing.
  test('health checks and internal dashboards are skipped by default', async () => {
    const app = withTelemetry()
    app.get('/health', () => 'ok')
    app.get('/_oven/queue', () => 'ok')
    app.get('/real', () => 'ok')
    await app.ready()

    await app.fetch(new Request('https://x/health'))
    await app.fetch(new Request('https://x/_oven/queue'))
    expect(recorded).toHaveLength(0)

    await app.fetch(new Request('https://x/real'))
    expect(recorded).toHaveLength(1)
  })

  test('the list can be replaced', async () => {
    const app = withTelemetry({ ignore: ['/skip'] })
    app.get('/health', () => 'ok')
    app.get('/skip', () => 'ok')
    await app.ready()

    await app.fetch(new Request('https://x/skip'))
    expect(recorded).toHaveLength(0)

    // No longer ignored, because the default list was replaced.
    await app.fetch(new Request('https://x/health'))
    expect(recorded).toHaveLength(1)
  })
})

/**
 * Without extraction a request arriving from another service becomes a disconnected root span,
 * and the distributed part of distributed tracing quietly does not work.
 */
describe('context propagation', () => {
  test('an incoming traceparent is extracted', async () => {
    const app = withTelemetry()
    app.get('/x', () => 'ok')
    await app.ready()

    await app.fetch(
      new Request('https://x/x', {
        headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
      }),
    )

    expect(extracted).toEqual(['00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'])
  })
})

describe('helpers', () => {
  test('span() wraps work and ends even when it throws', async () => {
    await span('work', () => 'done')
    expect(recorded.at(-1)).toMatchObject({ name: 'work', ended: true })

    await span('failing', () => {
      throw new Error('inner')
    }).catch(() => {})

    expect(recorded.at(-1)?.exceptions).toHaveLength(1)
    expect(recorded.at(-1)?.ended).toBe(true)
  })

  test('traceIds is empty with no active span', () => {
    trace.getActiveSpan = () => undefined
    expect(traceIds()).toEqual({})
  })

  // A trace you cannot reach from a log line is two tools instead of one.
  test('traceIds returns the active ids for a log line', () => {
    trace.getActiveSpan = () => makeSpan('active')
    expect(traceIds()).toEqual({ traceId: 'trace-1', spanId: 'span-1' })
  })
})

describe('context', () => {
  test('the middleware does not disturb the response', async () => {
    const app = withTelemetry()
    app.get('/x', (ctx) => {
      ctx.set('x-custom', 'kept')
      ctx.status = 201
      return { ok: true }
    })
    await app.ready()

    const response = await app.fetch(new Request('https://x/x'))
    expect(response.status).toBe(201)
    expect(response.headers.get('x-custom')).toBe('kept')
    expect(await response.json()).toEqual({ ok: true })
    expect(recorded[0]?.attributes['http.response.status_code']).toBe(201)
  })

  test('an unmatched route is still traced', async () => {
    const app = withTelemetry()
    app.get('/x', () => 'ok')
    await app.ready()

    await app.fetch(new Request('https://x/nowhere'))
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.attributes['http.response.status_code']).toBe(404)
  })
})

void context
