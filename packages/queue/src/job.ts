import type { EnqueueOptions } from './types'

/** The context a job handler receives. */
export interface JobContext<Payload> {
  payload: Payload
  /** The job's id, stable across retries. */
  id: string
  /** Which attempt this is, starting at 1. */
  attempt: number
  /** Attempts remaining after this one. */
  remaining: number
  /** Request-style logger, tagged with the job name and id. */
  log: {
    debug(message: string, fields?: Record<string, unknown>): void
    info(message: string, fields?: Record<string, unknown>): void
    warn(message: string, fields?: Record<string, unknown>): void
    error(message: string, fields?: Record<string, unknown>): void
  }
  /**
   * Aborted when the job's timeout elapses or the worker is shutting down.
   *
   * Pass it to `fetch` and to anything else that takes one. Without it a timeout only stops
   * *waiting* for the handler; the work itself carries on in the background.
   */
  signal: AbortSignal
}

export interface JobDefinition<Payload = unknown> {
  /** Stable across deploys — it is what a stored job is matched against. */
  name: string
  handler(context: JobContext<Payload>): unknown | Promise<unknown>
  /** Attempts after the first. Default 3. */
  retries?: number
  /** Milliseconds before the first retry; doubles each attempt. Default 1000. */
  backoff?: number
  /** Milliseconds a single attempt may take. Default 30000. */
  timeout?: number
  /** Default enqueue options for this job. */
  defaults?: EnqueueOptions
  readonly __job?: true
}

/**
 * Declares a background job.
 *
 * The payload type is declared once and enforced at both ends: `dispatch` will not accept the
 * wrong shape, and the handler receives the right one without a cast.
 *
 * ```ts
 * export const resizeAvatar = defineJob<{ userId: string; url: string }>({
 *   name: 'resize-avatar',
 *   retries: 5,
 *   handler: async ({ payload, signal }) => {
 *     const image = await fetch(payload.url, { signal })
 *     // …
 *   },
 * })
 *
 * await ctx.queue.dispatch(resizeAvatar, { userId, url })
 * ```
 *
 * A definition is a plain object, so it can live next to the code that dispatches it and be
 * imported by both the app and the worker — which is what keeps the two from disagreeing about
 * what a job is called.
 */
export function defineJob<Payload = void>(
  definition: JobDefinition<Payload>,
): JobDefinition<Payload> {
  if (!definition.name) {
    throw new Error('A job needs a name. It is what a stored job is matched against.')
  }
  if (typeof definition.handler !== 'function') {
    throw new Error(`The job "${definition.name}" needs a handler.`)
  }
  return Object.defineProperty(definition, '__job', { value: true }) as JobDefinition<Payload>
}
