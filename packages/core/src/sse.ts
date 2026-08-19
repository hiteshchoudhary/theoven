/**
 * Server-sent events.
 *
 * The right tool for one-way updates — a progress bar, a live feed, a token stream from a model.
 * It is plain HTTP, so it passes through proxies, respects `Authorization`, and reconnects on its
 * own. Reach for a [WebSocket](/docs/reference/websockets/) when the client also needs to send.
 */

export interface ServerSentEvent {
  data: unknown
  /** Event name the client listens for. Without one the client's `onmessage` fires. */
  event?: string | undefined
  /** Sets `lastEventId` on the client, which it sends back as `Last-Event-ID` on reconnect. */
  id?: string | undefined
  /** Tells the client how long to wait before reconnecting, in milliseconds. */
  retry?: number | undefined
}

export interface StreamOptions {
  /**
   * Aborts the stream — pass `ctx.req.signal` so a client hanging up stops the work.
   *
   * Without it, a browser closing the tab leaves the producer running: the writes fail silently
   * and whatever they were computing carries on forever.
   */
  signal?: AbortSignal | undefined
  /**
   * Milliseconds between keep-alive comments. Default 15000; `0` disables them.
   *
   * Proxies and load balancers close connections that go quiet, so a feed that is legitimately
   * idle for a minute dies without these. The comment is invisible to the client.
   */
  heartbeat?: number | undefined
  /** Extra response headers. */
  headers?: Record<string, string> | undefined
}

/** What a producer is given. Returns `false` once the client has gone. */
export interface EventStream {
  send(event: ServerSentEvent | unknown): boolean
  /** A bare comment. Keeps the connection warm without the client seeing an event. */
  comment(text?: string): boolean
  close(): void
  readonly closed: boolean
}

/** Serialises one event into the wire format. */
export function formatEvent(event: ServerSentEvent): string {
  const lines: string[] = []

  if (event.event) lines.push(`event: ${event.event}`)
  if (event.id !== undefined) lines.push(`id: ${event.id}`)
  if (event.retry !== undefined) lines.push(`retry: ${event.retry}`)

  const payload = typeof event.data === 'string' ? event.data : JSON.stringify(event.data)

  // A newline inside `data:` would end the event early, so multi-line payloads are split across
  // repeated `data:` lines — which the protocol rejoins with newlines on the client.
  for (const line of payload.split('\n')) lines.push(`data: ${line}`)

  return `${lines.join('\n')}\n\n`
}

/**
 * Builds a server-sent event response.
 *
 * ```ts
 * app.get('/progress', (ctx) =>
 *   sse(async (stream) => {
 *     for (let percent = 0; percent <= 100; percent += 10) {
 *       stream.send({ event: 'progress', data: { percent } })
 *       await Bun.sleep(200)
 *     }
 *   }, { signal: ctx.req.signal }),
 * )
 * ```
 *
 * The producer runs until it returns or the client disconnects, whichever comes first.
 */
export function sse(
  producer: (stream: EventStream) => unknown | Promise<unknown>,
  options: StreamOptions = {},
): Response {
  const encoder = new TextEncoder()
  const heartbeat = options.heartbeat ?? 15_000
  let closed = false

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let timer: ReturnType<typeof setInterval> | undefined

      const finish = () => {
        if (closed) return
        closed = true
        if (timer) clearInterval(timer)
        try {
          controller.close()
        } catch {
          // Already closed by the runtime because the client went away.
        }
      }

      const write = (chunk: string): boolean => {
        if (closed) return false
        try {
          controller.enqueue(encoder.encode(chunk))
          return true
        } catch {
          // The client disconnected between our check and this write.
          finish()
          return false
        }
      }

      const stream: EventStream = {
        get closed() {
          return closed
        },
        send: (event) =>
          write(
            formatEvent(
              typeof event === 'object' && event !== null && 'data' in event
                ? (event as ServerSentEvent)
                : { data: event },
            ),
          ),
        comment: (text = '') => write(`: ${text}\n\n`),
        close: finish,
      }

      options.signal?.addEventListener('abort', finish, { once: true })

      if (heartbeat > 0) {
        timer = setInterval(() => stream.comment('keep-alive'), heartbeat)
        // Never hold the process open for a heartbeat at shutdown.
        timer.unref?.()
      }

      void (async () => {
        try {
          await producer(stream)
        } catch (thrown) {
          // The response has already begun, so there is no status left to change. Telling the
          // client is the only thing left worth doing.
          write(formatEvent({ event: 'error', data: { message: String(thrown) } }))
        } finally {
          finish()
        }
      })()
    },
  })

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      // A cached event stream is a stream that never updates.
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tells nginx not to buffer, which otherwise delays every event until the buffer fills.
      'x-accel-buffering': 'no',
      ...options.headers,
    },
  })
}
