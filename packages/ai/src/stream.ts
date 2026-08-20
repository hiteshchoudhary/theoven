import { sse } from '@theoven/core'
import type { TokenUsage } from './types'
import { normaliseUsage } from './usage'

/** What {@link StreamToSseOptions.start} decided: replay a cached answer, or run a live stream. */
export type StreamSource =
  | { cached: { text: string; usage: TokenUsage }; result?: undefined }
  | {
      result: { textStream: AsyncIterable<string>; usage: PromiseLike<unknown> }
      cached?: undefined
    }

export interface StreamToSseOptions {
  signal?: AbortSignal | undefined
  start: () => Promise<StreamSource>
  onComplete: (text: string, usage: TokenUsage) => Promise<void>
  costOf: (usage: TokenUsage) => number | undefined
}

/**
 * Bridges a token stream onto server-sent events.
 *
 * The wire format is deliberately small: `delta` events carrying `{ text }`, then one `done`
 * carrying the whole answer with its usage and cost. Anything can consume it — `EventSource`,
 * curl, a mobile client — because it is just SSE.
 *
 * It is not the AI SDK's own UI stream protocol, and does not try to be. That protocol carries
 * tool calls, reasoning parts and structured output, and a reimplementation would be a worse
 * copy that drifts. Return `streamRaw(...).toUIMessageStreamResponse()` when you want it.
 *
 * **The status is already 200 by the time the first token is written.** Failures that can be
 * known earlier are raised before this is ever called; a provider failing mid-stream can only
 * be reported as an `error` event, because the headers are long gone.
 */
export function streamToSse(options: StreamToSseOptions): Response {
  return sse(
    async (stream) => {
      const source = await options.start()

      if (source.cached) {
        // Replayed as a single delta rather than re-chunked to imitate typing. The answer did
        // not stream, and pretending otherwise would be theatre in the transport layer.
        stream.send({ event: 'delta', data: { text: source.cached.text } })
        stream.send({
          event: 'done',
          data: {
            text: source.cached.text,
            usage: source.cached.usage,
            cost: options.costOf(source.cached.usage),
            cached: true,
          },
        })
        return
      }

      const { result } = source
      let text = ''

      try {
        for await (const delta of result.textStream) {
          text += delta
          // `send` returns false once the client has gone. Stopping here ends the iteration,
          // which aborts the upstream call rather than paying for tokens nobody will read.
          if (!stream.send({ event: 'delta', data: { text: delta } })) return
        }
      } catch (error) {
        if (options.signal?.aborted || stream.closed) return
        throw error
      }

      const usage = normaliseUsage(await result.usage)
      stream.send({
        event: 'done',
        data: { text, usage, cost: options.costOf(usage), cached: false },
      })

      await options.onComplete(text, usage)
    },
    options.signal ? { signal: options.signal } : {},
  )
}
