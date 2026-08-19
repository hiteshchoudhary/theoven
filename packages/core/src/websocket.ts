import type { Server, ServerWebSocket } from 'bun'
import type { Context } from './context'

/**
 * WebSockets, upgraded from an ordinary route.
 *
 * The important design choice is *when* the upgrade happens: after routing, after the brick
 * hooks, after the guard, after validation. A socket route therefore gets the same `auth: true`,
 * the same typed `ctx.params` and the same `ctx.user` as any HTTP route — rather than a second,
 * weaker authentication story bolted onto a different entry point, which is how socket endpoints
 * end up being the unguarded way into an application.
 */

/** Whatever you attach to a connection at upgrade time, available on every callback. */
export interface SocketData<Data = unknown> {
  data: Data
  /** The id of the request that opened this socket, so a trace spans the upgrade. */
  requestId: string
  /**
   * The route that owns this connection.
   *
   * Carried on the connection rather than in a map keyed by socket, because `open` arrives
   * asynchronously — anything resembling a "socket currently being upgraded" field would hand
   * the wrong handlers to one of two clients connecting in the same tick.
   *
   * @internal
   */
  route: SocketHandlers<Data>
}

export type OvenSocket<Data = unknown> = ServerWebSocket<SocketData<Data>>

export interface SocketHandlers<Data = unknown> {
  /**
   * Runs before the upgrade, with the full request context. Whatever it returns is attached to
   * the connection and reaches every callback as `socket.data.data`.
   *
   * **To refuse, throw** — `throw new Unauthorized()` — exactly as anywhere else in the
   * framework, and the client gets the usual problem+json before any socket exists. Refusing by
   * returning a `Response` would put a `Data | Response` union in the return type, and
   * TypeScript cannot infer `Data` out of that: every connection's data would land as `unknown`,
   * which is most of what this API is for.
   */
  upgrade?(ctx: Context): Data | Promise<Data>

  /**
   * Return type is `unknown` rather than `void` on purpose: `socket.send()` returns the number of
   * bytes queued, so `open: (socket) => socket.send('hi')` — the most natural thing anyone
   * writes — would otherwise not typecheck. The value is awaited and discarded.
   */
  open?(socket: OvenSocket<Data>): unknown
  message?(socket: OvenSocket<Data>, message: string | Buffer): unknown
  close?(socket: OvenSocket<Data>, code: number, reason: string): unknown
  /** Called when a backpressured socket drains. Send queued data from here. */
  drain?(socket: OvenSocket<Data>): unknown

  /** Bun's per-socket options — `maxPayloadLength`, `idleTimeout`, `backpressureLimit`. */
  options?: {
    maxPayloadLength?: number
    idleTimeout?: number
    backpressureLimit?: number
    closeOnBackpressureLimit?: boolean
  }
}

/** True when a request is actually asking to become a WebSocket. */
export function isUpgrade(request: Request): boolean {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket' && request.method === 'GET'
}

/**
 * Builds the single `websocket` handler `Bun.serve` takes.
 *
 * Bun allows exactly one per server, so every route's handlers are stored on the connection and
 * dispatched from here. That indirection is why `app.ws()` can feel per-route while the runtime
 * only ever sees one.
 */
export function socketRouter(): Required<
  Pick<SocketHandlers, 'open' | 'message' | 'close' | 'drain'>
> {
  const call = async (
    socket: OvenSocket<unknown>,
    pick: (route: SocketHandlers<unknown>) => undefined | ((...args: never[]) => unknown),
    args: unknown[],
  ) => {
    const route = socket.data?.route
    const handler = route && pick(route)
    if (!handler) return

    try {
      await (handler as (...a: unknown[]) => unknown)(...args)
    } catch (thrown) {
      // A throwing socket callback must not take the process down — there is no request to fail.
      // Closing with 1011 is what the protocol says an internal error looks like.
      try {
        socket.close(1011, 'Internal error')
      } catch {
        // Already gone.
      }
      throw thrown
    }
  }

  return {
    open: (socket) => call(socket, (r) => r.open, [socket]),
    message: (socket, message) => call(socket, (r) => r.message, [socket, message]),
    close: (socket, code, reason) => call(socket, (r) => r.close, [socket, code, reason]),
    drain: (socket) => call(socket, (r) => r.drain, [socket]),
  }
}

/**
 * Returned by dispatch when Bun has taken the connection.
 *
 * `fetch` must return `undefined` for an accepted upgrade — returning a `Response` makes Bun
 * close the socket it just opened. A sentinel keeps the rest of the pipeline returning a single
 * type instead of `Response | undefined` everywhere.
 */
export const UPGRADED = Symbol('oven.upgraded')

/** Publishes to every socket subscribed to a topic. Requires a listening server. */
export function publish(
  server: Server<unknown> | undefined,
  topic: string,
  message: string,
): number {
  return server?.publish(topic, message) ?? 0
}
