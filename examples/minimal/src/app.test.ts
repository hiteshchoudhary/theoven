import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import app from './app'

/**
 * The smallest app, tested.
 *
 * Small as it is, it is the first thing anyone runs, so it is worth knowing it works: file-based
 * routing finds the files, the schemas beside them validate, and the OpenAPI document describes
 * what was registered.
 */

beforeAll(() => app.ready())
afterAll(() => app.close({ timeout: 0 }))

const send = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`https://theoven.app${path}`, init))

describe('routes come from the filesystem', () => {
  test('the root route answers', async () => {
    expect((await send('/')).status).toBe(200)
  })

  test('every route file was registered', () => {
    const patterns = new Set(app.routes().map((route) => route.pattern))
    expect(patterns.has('/')).toBe(true)
    expect(patterns.has('/users')).toBe(true)
    expect(patterns.has('/users/:id')).toBe(true)
  })

  // `_store.ts` is a helper, not a route. A leading underscore is how the convention says so.
  test('underscore files are not routes', () => {
    expect(app.routes().some((route) => route.pattern.includes('_store'))).toBe(false)
  })
})

describe('validation comes from the schemas beside the handlers', () => {
  test('a valid user is created', async () => {
    const response = await send('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    })
    expect(response.status).toBe(201)
  })

  // Naming the field is the point: "validation failed" tells a client nothing it can act on.
  test('an invalid body is a 422 naming the offending field', async () => {
    const response = await send('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })

    expect(response.status).toBe(422)
    const problem = (await response.json()) as {
      errors: Array<{ location: string; path: string }>
    }
    expect(problem.errors[0]).toMatchObject({ location: 'body', path: 'name' })
  })

  test('a missing user is problem+json', async () => {
    const response = await send(`/users/${crypto.randomUUID()}`)
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('problem+json')
  })
})

describe('the OpenAPI document', () => {
  test('it is generated from those same schemas', async () => {
    const document = (await (await send('/openapi.json')).json()) as {
      openapi: string
      paths: Record<string, unknown>
    }
    expect(document.openapi).toStartWith('3.1')
    expect(Object.keys(document.paths)).toContain('/users')
  })

  test('the reference page is served', async () => {
    expect((await send('/docs')).status).toBe(200)
  })
})
