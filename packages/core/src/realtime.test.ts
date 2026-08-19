import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createApp, formatEvent, silentLogger, sse, Unauthorized } from './index'

const opened: Array<{ close(options?: { timeout?: number }): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 200 })))
})

let nextPort = 4830
function makeApp() {
  const app = createApp({ logger: silentLogger })
  opened.push(app)
  return app
}

/** Opens a socket and resolves once `count` messages have arrived, or it fails to open. */
function connect(url: string, count = 1, send?: string): Promise<string[] | string> {
  return new Promise((resolve) => {
    const received: string[] = []
    const socket = new WebSocket(url)
    const done = setTimeout(() => resolve(received.length > 0 ? received : 'timeout'), 2000)

    socket.onopen = () => {
      if (send !== undefined) socket.send(send)
    }
    socket.onmessage = (event) => {
      received.push(String(event.data))
      if (received.length >= count) {
        clearTimeout(done)
        socket.close()
        resolve(received)
      }
    }
    socket.onerror = () => {
      clearTimeout(done)
      resolve('refused')
    }
  })
}

describe('websockets', () => {
  test('a socket opens, echoes and closes', async () => {
    const app = makeApp()
    const events: string[] = []

    app.ws('/echo', {
      upgrade: (ctx) => ({ who: ctx.query.who ?? 'anon' }),
      open: (socket) => {
        events.push(`open:${socket.data.data.who}`)
        socket.send(`welcome ${socket.data.data.who}`)
      },
      message: (socket, message) => {
        events.push(`message:${message}`)
        socket.send(`echo:${message}`)
      },
      close: () => events.push('close'),
    })

    const port = nextPort++
    await app.listen(port)

    expect(await connect(`ws://localhost:${port}/echo?who=ada`, 2, 'hello')).toEqual([
      'welcome ada',
      'echo:hello',
    ])

    await Bun.sleep(60)
    expect(events).toEqual(['open:ada', 'message:hello', 'close'])
  })

  /**
   * The reason `app.ws()` registers a normal route rather than opening a second entry point: a
   * socket endpoint that skipped the guard would be the unguarded way into an application.
   */
  test('the guard runs before the socket opens', async () => {
    const app = makeApp()
    app.onRequest((ctx) => {
      ;(ctx as unknown as { user: unknown }).user = ctx.token === 'good' ? { id: 'u1' } : null
    })
    app.ws('/private', {
      upgrade: (ctx) => {
        if (!(ctx as unknown as { user: unknown }).user) throw new Unauthorized('Sign in first.')
        return { ok: true }
      },
      open: (socket) => socket.send('in'),
    })

    const port = nextPort++
    await app.listen(port)

    expect(await connect(`ws://localhost:${port}/private`)).toBe('refused')
    expect(await connect(`ws://localhost:${port}/private?access_token=good`)).toEqual(['in'])
  })

  test('the params schema rejects a bad id before the upgrade', async () => {
    const app = makeApp()
    app.ws(
      '/rooms/:id',
      { params: z.object({ id: z.uuid() }) },
      { open: (socket) => socket.send('joined') },
    )

    const port = nextPort++
    await app.listen(port)

    expect(await connect(`ws://localhost:${port}/rooms/not-a-uuid`)).toBe('refused')
    expect(await connect(`ws://localhost:${port}/rooms/${crypto.randomUUID()}`)).toEqual(['joined'])
  })

  // Two clients connecting in the same tick must not be handed each other's handlers.
  test('concurrent upgrades to different routes stay separate', async () => {
    const app = makeApp()
    app.ws('/a', { open: (socket) => socket.send('from-a') })
    app.ws('/b', { open: (socket) => socket.send('from-b') })

    const port = nextPort++
    await app.listen(port)

    const [a, b] = await Promise.all([
      connect(`ws://localhost:${port}/a`),
      connect(`ws://localhost:${port}/b`),
    ])
    expect(a).toEqual(['from-a'])
    expect(b).toEqual(['from-b'])
  })

  test('publish reaches every subscriber of a topic', async () => {
    const app = makeApp()
    app.ws('/room', {
      open: (socket) => socket.subscribe('lobby'),
      message: (_socket, message) => {
        app.publish('lobby', `broadcast:${message}`)
      },
    })

    const port = nextPort++
    await app.listen(port)

    const listener = connect(`ws://localhost:${port}/room`, 1)
    await Bun.sleep(80)
    await connect(`ws://localhost:${port}/room`, 0, 'hi').catch(() => undefined)

    expect(await listener).toEqual(['broadcast:hi'])
  })

  // A plain browser GET on a socket endpoint should explain itself, not 404.
  test('a non-upgrade request gets 426 with an Upgrade header', async () => {
    const app = makeApp()
    app.ws('/socket', { open: () => {} })
    await app.ready()

    const response = await app.fetch(new Request('http://localhost/socket'))
    expect(response.status).toBe(426)
    expect(response.headers.get('upgrade')).toBe('websocket')
  })
})

describe('server-sent events', () => {
  test('events are serialised in the wire format', () => {
    expect(formatEvent({ data: { n: 1 } })).toBe('data: {"n":1}\n\n')
    expect(formatEvent({ event: 'tick', data: 'x' })).toBe('event: tick\ndata: x\n\n')
    expect(formatEvent({ data: 'x', id: '7', retry: 500 })).toBe('id: 7\nretry: 500\ndata: x\n\n')
  })

  /**
   * A newline inside `data:` would end the event early, so the client would see a truncated
   * payload and no error — the worst kind of bug.
   */
  test('a multi-line payload is split across data lines', () => {
    expect(formatEvent({ data: 'one\ntwo' })).toBe('data: one\ndata: two\n\n')
  })

  test('a stream produces events and ends', async () => {
    const app = makeApp()
    app.get('/events', (ctx) =>
      sse(
        async (stream) => {
          for (let n = 1; n <= 3; n++) stream.send({ event: 'tick', data: { n } })
        },
        { signal: ctx.req.signal, heartbeat: 0 },
      ),
    )
    await app.ready()

    const response = await app.fetch(new Request('http://localhost/events'))
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    // A cached event stream is a stream that never updates.
    expect(response.headers.get('cache-control')).toContain('no-cache')

    const body = await response.text()
    expect(body).toContain('event: tick')
    expect(body.match(/data: /g)).toHaveLength(3)
  })

  test('a bare value is sent as data', async () => {
    const app = makeApp()
    app.get('/events', () => sse((stream) => stream.send('hello'), { heartbeat: 0 }))
    await app.ready()

    expect(await (await app.fetch(new Request('http://localhost/events'))).text()).toBe(
      'data: hello\n\n',
    )
  })

  // The response has already begun, so there is no status left to change.
  test('a producer that throws tells the client rather than hanging', async () => {
    const app = makeApp()
    app.get('/events', () =>
      sse(
        () => {
          throw new Error('producer failed')
        },
        { heartbeat: 0 },
      ),
    )
    await app.ready()

    const body = await (await app.fetch(new Request('http://localhost/events'))).text()
    expect(body).toContain('event: error')
    expect(body).toContain('producer failed')
  })

  test('sending after close reports failure instead of throwing', async () => {
    const app = makeApp()
    let afterClose: boolean | undefined

    app.get('/events', () =>
      sse(
        (stream) => {
          stream.send('first')
          stream.close()
          afterClose = stream.send('second')
        },
        { heartbeat: 0 },
      ),
    )
    await app.ready()

    const body = await (await app.fetch(new Request('http://localhost/events'))).text()
    expect(body).toBe('data: first\n\n')
    expect(afterClose).toBe(false)
  })
})
