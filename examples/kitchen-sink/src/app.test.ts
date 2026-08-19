import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { createWorker } from '@theoven/queue'

/**
 * The framework's integration test.
 *
 * Every brick is registered in one app here, so a change that breaks how two of them *compose*
 * fails in this file rather than in someone's project. Unit tests in each package prove each
 * brick works; this proves they work together.
 *
 * It exercises the app through `fetch`, the way a client does — not by calling handlers, which
 * would skip routing, validation, guards and serialisation.
 */

const STORAGE_DIR = `${import.meta.dir}/../.test-uploads`
process.env.STORAGE_DIR = STORAGE_DIR
process.env.AUTH_SECRET = 'kitchen-sink-test-secret'
process.env.LOG_LEVEL = 'error'

const { default: app } = await import('./app')

const CREDENTIALS = { name: 'Ada', email: 'ada@example.com', password: 'correct-horse' }
let accessToken = ''

function send(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`https://theoven.app${path}`, init))
}

function json(path: string, body: unknown, token?: string): Promise<Response> {
  return send(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  await app.ready()
  const response = await json('/auth/signup', CREDENTIALS)
  accessToken = ((await response.json()) as { accessToken: string }).accessToken
})

afterAll(async () => {
  await app.close({ timeout: 1000 })
  await rm(STORAGE_DIR, { recursive: true, force: true })
})

describe('the app boots with every brick', () => {
  test('each one is on the context', async () => {
    expect(await (await send('/')).json()).toEqual({
      name: 'kitchen-sink',
      bricks: { storage: 'disk', queue: 'memory', mail: 'console' },
    })
  })

  test('auth mounted its endpoints and openapi mounted its own', () => {
    const patterns = new Set(app.routes().map((route) => route.pattern))
    expect(patterns.has('/auth/signup')).toBe(true)
    expect(patterns.has('/openapi.json')).toBe(true)
    expect(patterns.has('/notes')).toBe(true)
  })

  // Both are development tools and both hold things worth not exposing.
  test('the mail inbox and queue dashboard are mounted in development', async () => {
    expect((await send('/_oven/mail')).status).toBe(200)
    expect((await send('/_oven/queue')).status).toBe(200)
  })
})

describe('the OpenAPI document describes what was registered', () => {
  test('it includes the routes and their schemas', async () => {
    const document = (await (await send('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { security?: unknown[]; parameters?: unknown[] }>>
    }

    expect(document.paths['/notes']?.get).toBeDefined()
    expect(document.paths['/notes']?.post).toBeDefined()
    // The guard is part of the description, not just the behaviour.
    expect(document.paths['/notes']?.post?.security).toBeDefined()
    expect(document.paths['/notes/{id}']?.get?.parameters).toBeDefined()
  })
})

describe('creating a note', () => {
  test('it is refused without a token', async () => {
    expect((await json('/notes', { title: 'Anonymous' })).status).toBe(401)
  })

  test('a signed-in user can create one', async () => {
    const response = await json('/notes', { title: 'First note', body: 'Hello' }, accessToken)
    expect(response.status).toBe(201)

    const note = (await response.json()) as { id: string; title: string; authorId: string }
    expect(note.title).toBe('First note')
    expect(note.authorId).toBeTruthy()
  })

  // Validation runs before the handler, so the handler never sees a bad title.
  test('a bad body is a 422 naming the field', async () => {
    const response = await json('/notes', { title: '' }, accessToken)
    expect(response.status).toBe(422)
    expect(await response.text()).toContain('title')
  })

  test('it appears in the list', async () => {
    const notes = (await (await send('/notes')).json()) as Array<{ title: string }>
    expect(notes.some((note) => note.title === 'First note')).toBe(true)
  })

  test('a missing note is problem+json, not a crash', async () => {
    const response = await send(`/notes/${crypto.randomUUID()}`)
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('problem+json')
  })

  test('a malformed id is refused by the schema before any query runs', async () => {
    expect((await send('/notes/not-a-uuid')).status).toBe(422)
  })
})

/**
 * The composition worth proving: one request that touches storage, the database and the queue,
 * with none of them wired in the route.
 */
describe('a note with an attachment', () => {
  let key = ''

  test('the upload is stored and recorded on the note', async () => {
    const form = new FormData()
    form.set('title', 'With a file')
    form.set('file', new File(['attachment bytes'], 'notes.txt', { type: 'text/plain' }))

    const response = await send('/notes', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      body: form,
    })

    expect(response.status).toBe(201)
    const note = (await response.json()) as { attachment: string }
    expect(note.attachment).toMatch(/^notes\/.+\/notes\.txt$/)
    key = note.attachment
  })

  test('it can be downloaded back', async () => {
    const response = await send(`/files/${key}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    expect(await response.text()).toBe('attachment bytes')
  })

  test('downloading is guarded', async () => {
    expect((await send(`/files/${key}`)).status).toBe(401)
  })

  // The storage brick refuses traversal before a path is ever built.
  test('a traversing key cannot escape the storage directory', async () => {
    const response = await send('/files/../../../etc/passwd', {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await response.text()).not.toContain('root:')
  })
})

describe('the queued notification', () => {
  test('creating a note enqueues it, and a worker runs it', async () => {
    const before = await app.service('queue').stats()
    expect(before.ready).toBeGreaterThan(0)

    const worker = createWorker(
      app.service('queue').raw as never,
      app.service('queue').jobs as never,
      { logger: app.logger },
    )
    await worker.drain()

    expect((await app.service('queue').stats()).ready).toBe(0)
    expect(await app.service('queue').dead(10)).toHaveLength(0)
  })
})

describe('the password reset flow', () => {
  test('it always answers the same, whether or not the address exists', async () => {
    const known = await json('/auth/forgot-password', { email: CREDENTIALS.email })
    const unknown = await json('/auth/forgot-password', { email: 'nobody@example.com' })

    expect(unknown.status).toBe(known.status)
    expect(await unknown.text()).toBe(await known.text())
  })
})
