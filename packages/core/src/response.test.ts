import { describe, expect, test } from 'bun:test'
import { toResponse } from './response'

describe('toResponse — passthrough', () => {
  test('returns a Response untouched', async () => {
    const original = new Response('hi', { status: 418 })
    const result = toResponse(original, undefined, undefined)
    expect(result).toBe(original)
    expect(result.status).toBe(418)
    expect(await result.text()).toBe('hi')
  })

  test('fills in context headers the Response did not set', () => {
    const headers = new Headers({ 'x-trace': 'abc' })
    const result = toResponse(new Response('hi'), undefined, headers)
    expect(result.headers.get('x-trace')).toBe('abc')
  })

  test('never overwrites a header the Response already set', () => {
    const headers = new Headers({ 'content-type': 'text/plain' })
    const original = new Response('<b>x</b>', { headers: { 'content-type': 'text/html' } })
    const result = toResponse(original, undefined, headers)
    expect(result.headers.get('content-type')).toBe('text/html')
  })

  test('ignores the context status, since the handler chose one deliberately', () => {
    expect(toResponse(new Response(null, { status: 201 }), 500, undefined).status).toBe(201)
  })
})

describe('toResponse — empty', () => {
  test('null becomes 204 with no body', async () => {
    const result = toResponse(null, undefined, undefined)
    expect(result.status).toBe(204)
    expect(await result.text()).toBe('')
  })

  test('undefined becomes 204', () => {
    expect(toResponse(undefined, undefined, undefined).status).toBe(204)
  })

  test('an explicit status wins over 204', () => {
    expect(toResponse(null, 201, undefined).status).toBe(201)
  })

  test('carries context headers', () => {
    const headers = new Headers({ location: '/next' })
    expect(toResponse(null, 303, headers).headers.get('location')).toBe('/next')
  })
})

describe('toResponse — strings', () => {
  test('becomes text/plain', async () => {
    const result = toResponse('hello', undefined, undefined)
    expect(result.status).toBe(200)
    expect(result.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await result.text()).toBe('hello')
  })

  test('an explicit content-type wins, so pre-rendered HTML works', async () => {
    const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' })
    const result = toResponse('<h1>hi</h1>', undefined, headers)
    expect(result.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await result.text()).toBe('<h1>hi</h1>')
  })

  test('an empty string is still a body, not a 204', async () => {
    const result = toResponse('', undefined, undefined)
    expect(result.status).toBe(200)
    expect(await result.text()).toBe('')
  })
})

describe('toResponse — JSON', () => {
  test('objects become JSON', async () => {
    const result = toResponse({ id: 1, name: 'oven' }, undefined, undefined)
    expect(result.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await result.json()).toEqual({ id: 1, name: 'oven' })
  })

  test('arrays become JSON', async () => {
    expect(await toResponse([1, 2, 3], undefined, undefined).json()).toEqual([1, 2, 3])
  })

  test('numbers are valid JSON documents', async () => {
    const result = toResponse(42, undefined, undefined)
    expect(result.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await result.json()).toBe(42)
  })

  test('booleans are valid JSON documents', async () => {
    expect(await toResponse(false, undefined, undefined).json()).toBe(false)
  })

  test('nested structures survive intact', async () => {
    const value = { a: [{ b: { c: null } }], d: 'x' }
    expect(await toResponse(value, undefined, undefined).json()).toEqual(value)
  })

  test('honours an explicit status', () => {
    expect(toResponse({ ok: true }, 201, undefined).status).toBe(201)
  })
})

describe('toResponse — binary and streams', () => {
  test('a Blob streams with its own content type', async () => {
    const blob = new Blob(['data'], { type: 'text/csv' })
    const result = toResponse(blob, undefined, undefined)
    expect(result.headers.get('content-type')).toBe('text/csv')
    expect(await result.text()).toBe('data')
  })

  test('a typeless Blob falls back to octet-stream', () => {
    const result = toResponse(new Blob(['x']), undefined, undefined)
    expect(result.headers.get('content-type')).toBe('application/octet-stream')
  })

  test('Bun.file streams from disk', async () => {
    const result = toResponse(Bun.file(`${import.meta.dir}/response.test.ts`), undefined, undefined)
    expect(result.status).toBe(200)
    expect(await result.text()).toContain('toResponse — binary and streams')
  })

  test('a ReadableStream passes through as octet-stream', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk'))
        controller.close()
      },
    })
    const result = toResponse(stream, undefined, undefined)
    expect(result.headers.get('content-type')).toBe('application/octet-stream')
    expect(await result.text()).toBe('chunk')
  })

  test('an ArrayBuffer becomes octet-stream', async () => {
    const result = toResponse(new TextEncoder().encode('bytes').buffer, undefined, undefined)
    expect(result.headers.get('content-type')).toBe('application/octet-stream')
    expect(await result.text()).toBe('bytes')
  })

  test('a typed array becomes octet-stream', async () => {
    const result = toResponse(new TextEncoder().encode('view'), undefined, undefined)
    expect(await result.text()).toBe('view')
  })
})

describe('toResponse — URL', () => {
  test('becomes a 302 redirect', () => {
    const result = toResponse(new URL('https://theoven.app/docs'), undefined, undefined)
    expect(result.status).toBe(302)
    expect(result.headers.get('location')).toBe('https://theoven.app/docs')
  })

  test('honours an explicit permanent status', () => {
    expect(toResponse(new URL('https://theoven.app/'), 308, undefined).status).toBe(308)
  })
})

describe('toResponse — bodiless statuses', () => {
  // Attaching a body to these throws inside the runtime, so the body is dropped instead.
  test.each([204, 205, 304])('drops the body at %i', async (status) => {
    const result = toResponse({ ignored: true }, status, undefined)
    expect(result.status).toBe(status)
    expect(await result.text()).toBe('')
  })

  test('still applies headers at a bodiless status', () => {
    const headers = new Headers({ etag: '"v1"' })
    expect(toResponse('body', 304, headers).headers.get('etag')).toBe('"v1"')
  })
})
