import { describe, expect, test } from 'bun:test'
import { Context, type ContextInit } from './context'
import { type Logger, silentLogger } from './logger'

function makeContext(
  request: Request = new Request('https://theoven.app/users/7?page=2'),
  params: Record<string, string> = {},
  init: Partial<ContextInit> = {},
): Context {
  return new Context(request, params, {
    logger: init.logger ?? silentLogger,
    requestIdHeader: init.requestIdHeader ?? 'x-request-id',
    server: init.server,
  })
}

describe('basics', () => {
  test('exposes the raw request unwrapped', () => {
    const request = new Request('https://theoven.app/')
    expect(makeContext(request).req).toBe(request)
  })

  test('exposes route params', () => {
    expect(makeContext(undefined, { id: '7' }).params).toEqual({ id: '7' })
  })

  test('exposes the method', () => {
    const request = new Request('https://theoven.app/', { method: 'POST' })
    expect(makeContext(request).method).toBe('POST')
  })

  test('leaves status undefined so the returned value decides', () => {
    expect(makeContext().status).toBeUndefined()
  })
})

describe('url', () => {
  test('parses lazily and caches', () => {
    const ctx = makeContext()
    expect(ctx.url).toBe(ctx.url)
  })

  test('exposes the pathname', () => {
    expect(makeContext().path).toBe('/users/7')
  })

  test('retains the query string for §1.3 to parse', () => {
    expect(makeContext().url.search).toBe('?page=2')
  })
})

describe('request id', () => {
  test('adopts an inbound id so a trace survives the proxy hop', () => {
    const request = new Request('https://theoven.app/', {
      headers: { 'x-request-id': 'from-load-balancer' },
    })
    expect(makeContext(request).id).toBe('from-load-balancer')
  })

  test('generates one when absent', () => {
    expect(makeContext().id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('is stable across reads', () => {
    const ctx = makeContext()
    expect(ctx.id).toBe(ctx.id)
  })

  test('honours a custom header name', () => {
    const request = new Request('https://theoven.app/', { headers: { 'x-trace-id': 'trace-9' } })
    expect(makeContext(request, {}, { requestIdHeader: 'x-trace-id' }).id).toBe('trace-9')
  })

  test('differs between requests', () => {
    expect(makeContext().id).not.toBe(makeContext().id)
  })
})

// The lazy rule from CLAUDE.md §2b is a guarantee, so it gets tested like one.
describe('laziness', () => {
  test('generates no request id until something reads it', () => {
    const ctx = makeContext()
    expect(ctx.hasId).toBe(false)
    void ctx.id
    expect(ctx.hasId).toBe(true)
  })

  test('reading the url does not materialise the id', () => {
    const ctx = makeContext()
    void ctx.url
    void ctx.path
    expect(ctx.hasId).toBe(false)
  })

  test('setting headers does not materialise the id', () => {
    const ctx = makeContext()
    ctx.set('x-custom', 'v')
    expect(ctx.hasId).toBe(false)
  })

  test('allocates no header bag until a header is set', () => {
    const ctx = makeContext()
    expect(ctx.headers).toBeUndefined()
    ctx.set('x-custom', 'v')
    expect(ctx.headers).toBeDefined()
  })

  test('derives no child logger until log is read', () => {
    let childCount = 0
    const counting: Logger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        childCount++
        return counting
      },
    }
    const ctx = makeContext(undefined, {}, { logger: counting })
    expect(childCount).toBe(0)
    void ctx.log
    expect(childCount).toBe(1)
  })

  test('reuses the child logger across reads', () => {
    const ctx = makeContext()
    expect(ctx.log).toBe(ctx.log)
  })
})

describe('log', () => {
  test('binds the request id to every line', () => {
    const lines: Array<Record<string, unknown>> = []
    const recorder: Logger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child(fields) {
        lines.push(fields)
        return recorder
      },
    }
    const ctx = makeContext(undefined, {}, { logger: recorder })
    void ctx.log
    expect(lines[0]).toEqual({ requestId: ctx.id })
  })
})

describe('response headers', () => {
  test('set stores a header', () => {
    const ctx = makeContext()
    ctx.set('x-a', '1')
    expect(ctx.headers?.get('x-a')).toBe('1')
  })

  test('set replaces an existing value', () => {
    const ctx = makeContext()
    ctx.set('x-a', '1').set('x-a', '2')
    expect(ctx.headers?.get('x-a')).toBe('2')
  })

  test('append keeps both values, which set-cookie needs', () => {
    const ctx = makeContext()
    ctx.append('set-cookie', 'a=1').append('set-cookie', 'b=2')
    expect(ctx.headers?.getSetCookie()).toEqual(['a=1', 'b=2'])
  })

  test('is chainable', () => {
    const ctx = makeContext()
    expect(ctx.set('x-a', '1')).toBe(ctx)
  })
})

describe('redirect', () => {
  test('defaults to 302 with a Location header', () => {
    const response = makeContext().redirect('/login')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/login')
  })

  test('accepts a permanent status', () => {
    expect(makeContext().redirect('/new', 308).status).toBe(308)
  })

  test('carries headers already set on the context', () => {
    const ctx = makeContext()
    ctx.set('x-reason', 'moved')
    expect(ctx.redirect('/new').headers.get('x-reason')).toBe('moved')
  })

  test('sends no body', async () => {
    expect(await makeContext().redirect('/x').text()).toBe('')
  })
})

describe('respond', () => {
  test('coerces the handler return value', async () => {
    expect(await makeContext().respond({ ok: true }).json()).toEqual({ ok: true })
  })

  test('applies the context status', () => {
    const ctx = makeContext()
    ctx.status = 201
    expect(ctx.respond({ id: 1 }).status).toBe(201)
  })

  test('applies context headers', () => {
    const ctx = makeContext()
    ctx.set('x-total', '99')
    expect(ctx.respond([]).headers.get('x-total')).toBe('99')
  })
})

describe('ip', () => {
  test('is undefined when dispatched without a server', () => {
    expect(makeContext().ip).toBeUndefined()
  })
})
