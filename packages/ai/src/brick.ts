import type { Brick, Context } from '@theoven/core'
import { generateText, embed as sdkEmbed, streamText } from 'ai'
import { cacheKey, UNCACHEABLE } from './key'
import { streamToSse } from './stream'
import {
  AiBudgetExceededError,
  type AiCache,
  AiConfigurationError,
  type ModelPricing,
  type RequestUsage,
  type TokenUsage,
  type UsageRecord,
} from './types'
import { computeCost, normaliseUsage } from './usage'

/**
 * The SDK's own option and model types, read off the functions rather than imported by name.
 *
 * The peer range spans AI SDK 5 through 7, which renamed several exported types along the way.
 * Deriving them keeps this package compiling against every version in the range instead of
 * pinning us to one release's spelling.
 */
type GenerateArgs = Parameters<typeof generateText>[0]
type StreamArgs = Parameters<typeof streamText>[0]
type EmbedArgs = Parameters<typeof sdkEmbed>[0]

export type LanguageModelLike = GenerateArgs['model']
export type EmbeddingModelLike = EmbedArgs['model']

/** Per-call cache control: `false` to skip, or an object to override the TTL. */
export type CacheControl = boolean | { ttl?: number | undefined }

export type GenerateOptions = Omit<GenerateArgs, 'model'> & {
  model?: LanguageModelLike
  cache?: CacheControl
}

export type StreamOptions = Omit<StreamArgs, 'model'> & {
  model?: LanguageModelLike
  cache?: CacheControl
}

export type EmbedOptions = Omit<EmbedArgs, 'model'> & {
  model?: EmbeddingModelLike
  cache?: CacheControl
}

export interface GenerateResult {
  text: string
  finishReason: string | undefined
  usage: TokenUsage
  /** `undefined` when the model has no configured price, or reported no tokens. */
  cost: number | undefined
  /** True when this brick's cache answered and no provider call was made. */
  cached: boolean
  /**
   * The full AI SDK result — tool calls, steps, response metadata, everything.
   *
   * **Absent on a cache hit.** A cached entry holds text and token counts, not the live result
   * object, and fabricating one would mean handing back an empty `toolCalls` array that reads
   * as "the model called nothing" rather than "this was not asked". In practice a call that
   * uses tools is never cached at all (a tool carries a function, which cannot be keyed), so
   * `raw` is only ever missing on a plain text generation.
   */
  raw: Awaited<ReturnType<typeof generateText>> | undefined
}

export interface EmbedResult {
  embedding: number[]
  usage: TokenUsage
  cost: number | undefined
  cached: boolean
}

export interface AiOptions {
  /** Default model. Every call may override it. */
  model?: LanguageModelLike | undefined
  /** Default model for {@link AiService.embed}. */
  embeddingModel?: EmbeddingModelLike | undefined
  /**
   * Cache identical calls.
   *
   * `true`, or an object with a `ttl`, uses whichever cache brick is registered — the brick
   * declares an optional dependency on it, so `.use(cache(...))` before this one is the whole
   * wiring. Pass an explicit `store` for anything else with `get`/`set`.
   *
   * Requesting a cache with no store and no cache brick registered fails at **boot**, naming
   * the problem, rather than silently running uncached and surfacing as a bill.
   *
   * **This makes generation deterministic for the TTL**, which is right for classification,
   * extraction and embeddings, and wrong for anything a user expects to vary between attempts.
   * It is off unless configured, and any call can opt out with `cache: false`.
   */
  cache?: boolean | { store?: AiCache | undefined; ttl?: number | undefined } | undefined
  /** Price per million tokens, keyed by model id. Without it, `cost` is always `undefined`. */
  pricing?: Record<string, ModelPricing> | undefined
  /** Refuse further calls once a request has spent this many tokens. */
  budget?: { tokens?: number | undefined } | undefined
  /** Called after every completed call, cache hits included. Failures here are logged, not thrown. */
  onUsage?: ((record: UsageRecord) => unknown) | undefined
}

export interface ScopeOptions {
  /** Token ceiling for the new scope. Defaults to the brick's configured budget. */
  budget?: number | undefined
  signal?: AbortSignal | undefined
}

export interface AiService {
  /** The default model, for dropping down to the SDK directly. */
  readonly model: LanguageModelLike | undefined

  generate(options: GenerateOptions): Promise<GenerateResult>

  /**
   * A ready-to-return server-sent event response.
   *
   * ```ts
   * export default (ctx) => ctx.ai.stream({ prompt: ctx.body.prompt })
   * ```
   *
   * Emits `delta` events carrying `{ text }`, then one `done` carrying the full text, token
   * usage and cost. The client disconnecting aborts the model call rather than leaving it
   * running and billable.
   */
  stream(options: StreamOptions): Response

  /**
   * The AI SDK's `streamText` result, with accounting attached but no transport chosen.
   *
   * For clients built on the SDK's own UI hooks, return `result.toUIMessageStreamResponse()`
   * from here — that protocol carries tool calls and structured parts that plain `delta` events
   * do not, and reimplementing it would only produce a worse copy.
   */
  streamRaw(options: StreamOptions): ReturnType<typeof streamText>

  embed(options: EmbedOptions): Promise<EmbedResult>

  /** Running totals for this scope. Inside a handler, that means this request. */
  readonly usage: RequestUsage

  /**
   * Folds usage from a call this brick did not make into the running totals.
   *
   * For when a route needs the SDK directly — a generic tool loop, a provider feature with no
   * passthrough here — and should still land in the same accounting as everything else.
   */
  record(usage: unknown, operation: UsageRecord['operation'], model: string): void

  /**
   * A fresh scope with its own totals and budget.
   *
   * Requests get one automatically. This is for work with no request behind it: a queue worker
   * running an agent loop wants a ceiling too, and the app-level service has no boundary to
   * enforce one against.
   */
  scope(options?: ScopeOptions): AiService
}

/** Structural check, because the cache brick is not imported and must not be. */
function isAiCache(value: unknown): value is AiCache {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { get?: unknown; set?: unknown }
  return typeof candidate.get === 'function' && typeof candidate.set === 'function'
}

function modelIdOf(model: LanguageModelLike | EmbeddingModelLike | undefined): string {
  if (model === undefined) return 'unknown'
  if (typeof model === 'string') return model
  const id = (model as { modelId?: unknown }).modelId
  return typeof id === 'string' ? id : 'unknown'
}

/** Everything shared across every scope: config, the cache, and in-flight deduplication. */
interface Runtime {
  options: AiOptions
  /** Resolved at boot from `options.cache` or the registered cache brick. */
  store?: AiCache | undefined
  ttl?: number | undefined
  /**
   * Identical calls in flight at the same moment, sharing one provider call.
   *
   * A cache alone does not prevent this: on a cold key, ten concurrent requests all miss, all
   * call the provider, and all pay. That is the cache stampede, and it costs real money here
   * rather than just database load. In-process only — it collapses duplicates within one
   * instance, not across a cluster.
   */
  inflight: Map<string, Promise<unknown>>
}

/** Just enough of a logger to report a failing usage hook. */
export interface UsageLogger {
  warn(message: string, detail?: unknown): void
}

function emptyUsage(): RequestUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, calls: 0, cachedCalls: 0 }
}

function createService(
  runtime: Runtime,
  scopeOptions: ScopeOptions,
  log: UsageLogger = console,
): AiService {
  const totals = emptyUsage()
  const budget = scopeOptions.budget
  const { options } = runtime

  const priceFor = (model: string): ModelPricing | undefined => options.pricing?.[model]

  const runUsageHook = (record: UsageRecord) => {
    if (options.onUsage) {
      try {
        const result = options.onUsage(record)
        // A rejected promise from a usage hook must not fail the request that produced it —
        // accounting is a side effect of the answer, not part of it.
        if (result instanceof Promise) {
          result.catch((error: unknown) => log.warn('ai: onUsage failed', error))
        }
      } catch (error) {
        log.warn('ai: onUsage failed', error)
      }
    }
  }

  const report = (record: UsageRecord) => {
    totals.calls += 1

    // A cache hit is billed nothing, so it contributes nothing to the totals. Counting the
    // tokens it *would* have used would overstate spend, and — because the budget is checked
    // against these totals — would let a request served entirely from cache exhaust an
    // allowance it never spent. The record still carries the token counts, so a consumer can
    // report what caching saved.
    if (record.cached) {
      totals.cachedCalls += 1
      return runUsageHook(record)
    }

    totals.inputTokens += record.usage.inputTokens ?? 0
    totals.outputTokens += record.usage.outputTokens ?? 0
    totals.totalTokens += record.usage.totalTokens ?? 0
    if (record.cost !== undefined) totals.cost += record.cost
    runUsageHook(record)
  }

  /**
   * Refuses the call when the scope has already spent its budget.
   *
   * Checked before the call, never during: token count is not known until the provider answers,
   * so a budget bounds how many calls a request may make, not how large any one of them is.
   * `maxOutputTokens` is the per-call ceiling.
   */
  const assertBudget = () => {
    if (budget !== undefined && totals.totalTokens >= budget) {
      throw new AiBudgetExceededError(totals.totalTokens, budget)
    }
  }

  const cacheTtl = (control: CacheControl | undefined): number | undefined | false => {
    if (!runtime.store || control === false) return false
    if (typeof control === 'object' && control.ttl !== undefined) return control.ttl
    return runtime.ttl
  }

  /** Runs `produce`, sharing the result with any identical call already in flight. */
  async function deduped<Value>(key: string, produce: () => Promise<Value>): Promise<Value> {
    const existing = runtime.inflight.get(key)
    if (existing) return (await existing) as Value
    const promise = produce()
    runtime.inflight.set(key, promise)
    try {
      return await promise
    } finally {
      runtime.inflight.delete(key)
    }
  }

  const service: AiService = {
    get model() {
      return options.model
    },

    get usage() {
      return { ...totals }
    },

    record(usage, operation, model) {
      const tokens = normaliseUsage(usage)
      report({
        model,
        operation,
        usage: tokens,
        cost: computeCost(tokens, priceFor(model)),
        cached: false,
        durationMs: 0,
      })
    },

    scope(next = {}) {
      return createService(
        runtime,
        { budget: next.budget ?? scopeOptions.budget, signal: next.signal ?? scopeOptions.signal },
        log,
      )
    },

    async generate(callOptions) {
      assertBudget()
      const { cache: control, model = options.model, ...rest } = callOptions
      if (!model)
        throw new AiConfigurationError('No model configured. Pass one to ai() or to generate().')

      const id = modelIdOf(model)
      const ttl = cacheTtl(control)
      const key =
        ttl === false ? UNCACHEABLE : cacheKey('generate', id, rest as Record<string, unknown>)
      const started = performance.now()

      if (key !== UNCACHEABLE && runtime.store) {
        const hit = await runtime.store.get<{
          text: string
          usage: TokenUsage
          finishReason: string | undefined
        }>(key)
        if (hit) {
          report({
            model: id,
            operation: 'generate',
            usage: hit.usage,
            cost: 0,
            cached: true,
            durationMs: performance.now() - started,
          })
          return { ...hit, cost: 0, cached: true, raw: undefined }
        }
      }

      const call = async (): Promise<GenerateResult> => {
        const result = await generateText({
          ...(rest as GenerateArgs),
          model,
          ...(scopeOptions.signal && rest.abortSignal === undefined
            ? { abortSignal: scopeOptions.signal }
            : {}),
        } as GenerateArgs)

        const usage = normaliseUsage(result.usage)
        const cost = computeCost(usage, priceFor(id))
        report({
          model: id,
          operation: 'generate',
          usage,
          cost,
          cached: false,
          durationMs: performance.now() - started,
        })

        if (key !== UNCACHEABLE && runtime.store && ttl !== false) {
          await runtime.store.set(
            key,
            { text: result.text, usage, finishReason: result.finishReason as string | undefined },
            ttl === undefined ? {} : { ttl },
          )
        }

        return {
          text: result.text,
          finishReason: result.finishReason as string | undefined,
          usage,
          cost,
          cached: false,
          raw: result,
        }
      }

      return key === UNCACHEABLE ? call() : deduped(key, call)
    },

    streamRaw(callOptions) {
      assertBudget()
      const { cache: _cache, model = options.model, ...rest } = callOptions
      if (!model)
        throw new AiConfigurationError('No model configured. Pass one to ai() or to stream().')
      const id = modelIdOf(model)
      const started = performance.now()

      const result = streamText({
        ...(rest as StreamArgs),
        model,
        ...(scopeOptions.signal && rest.abortSignal === undefined
          ? { abortSignal: scopeOptions.signal }
          : {}),
      } as StreamArgs)

      // `usage` settles when the stream finishes. Attaching here means accounting happens even
      // when the caller returns the SDK's own response and never touches `usage` themselves.
      void Promise.resolve(result.usage)
        .then((raw: unknown) => {
          const usage = normaliseUsage(raw)
          report({
            model: id,
            operation: 'stream',
            usage,
            cost: computeCost(usage, priceFor(id)),
            cached: false,
            durationMs: performance.now() - started,
          })
        })
        .catch(() => {
          // An aborted or failed stream never reports usage. Nothing was billed for us to record.
        })

      return result
    },

    stream(callOptions) {
      const { cache: control, model = options.model, ...rest } = callOptions

      // Checked here, not inside the producer. Once the first byte of an event stream is
      // written the response is committed to 200, so a budget or configuration failure raised
      // in there could only surface as an `error` event on a successful response. Out here it
      // is an ordinary throw and becomes a real 429 or 500 problem document.
      assertBudget()
      if (!model)
        throw new AiConfigurationError('No model configured. Pass one to ai() or to stream().')

      const id = modelIdOf(model)
      const ttl = cacheTtl(control)
      const key =
        ttl === false ? UNCACHEABLE : cacheKey('stream', id, rest as Record<string, unknown>)

      return streamToSse({
        signal: rest.abortSignal ?? scopeOptions.signal,
        start: async () => {
          if (key !== UNCACHEABLE && runtime.store) {
            const hit = await runtime.store.get<{ text: string; usage: TokenUsage }>(key)
            if (hit) {
              report({
                model: id,
                operation: 'stream',
                usage: hit.usage,
                cost: 0,
                cached: true,
                durationMs: 0,
              })
              return { cached: hit }
            }
          }
          return { result: service.streamRaw(callOptions) }
        },
        onComplete: async (text, usage) => {
          if (key === UNCACHEABLE || !runtime.store || ttl === false) return
          await runtime.store.set(key, { text, usage }, ttl === undefined ? {} : { ttl })
        },
        costOf: (usage) => computeCost(usage, priceFor(id)),
      })
    },

    async embed(callOptions) {
      assertBudget()
      const { cache: control, model = options.embeddingModel, ...rest } = callOptions
      if (!model) {
        throw new AiConfigurationError(
          'No embedding model configured. Pass one to ai() or to embed().',
        )
      }

      const id = modelIdOf(model)
      const ttl = cacheTtl(control)
      const key =
        ttl === false ? UNCACHEABLE : cacheKey('embed', id, rest as Record<string, unknown>)
      const started = performance.now()

      if (key !== UNCACHEABLE && runtime.store) {
        const hit = await runtime.store.get<{ embedding: number[]; usage: TokenUsage }>(key)
        if (hit) {
          report({
            model: id,
            operation: 'embed',
            usage: hit.usage,
            cost: 0,
            cached: true,
            durationMs: performance.now() - started,
          })
          return { embedding: hit.embedding, usage: hit.usage, cost: 0, cached: true }
        }
      }

      const call = async (): Promise<EmbedResult> => {
        const result = await sdkEmbed({
          ...(rest as EmbedArgs),
          model,
          ...(scopeOptions.signal && rest.abortSignal === undefined
            ? { abortSignal: scopeOptions.signal }
            : {}),
        } as EmbedArgs)

        // An embedding model reports `{ tokens }`, not the input/output split of a chat model.
        // Mapping it onto `inputTokens` is what makes the `input` price rate apply.
        const reported = (result.usage as { tokens?: number } | undefined)?.tokens
        const usage: TokenUsage = {
          inputTokens: reported,
          outputTokens: undefined,
          totalTokens: reported,
          cachedInputTokens: undefined,
          reasoningTokens: undefined,
        }
        const cost = computeCost(usage, priceFor(id))
        report({
          model: id,
          operation: 'embed',
          usage,
          cost,
          cached: false,
          durationMs: performance.now() - started,
        })

        const embedding = Array.from(result.embedding as ArrayLike<number>)
        if (key !== UNCACHEABLE && runtime.store && ttl !== false) {
          await runtime.store.set(key, { embedding, usage }, ttl === undefined ? {} : { ttl })
        }
        return { embedding, usage, cost, cached: false }
      }

      return key === UNCACHEABLE ? call() : deduped(key, call)
    },
  }

  return service
}

/**
 * The AI brick.
 *
 * ```ts
 * import { openai } from '@ai-sdk/openai'
 * import { ai } from '@theoven/ai'
 *
 * const app = createApp().use(ai({ model: openai('gpt-4o-mini') }))
 * ```
 *
 * It deliberately does **not** wrap the AI SDK's model layer. Providers, prompts, tools and
 * structured output are the SDK's job and it does them well; re-exporting them behind our own
 * names would age badly and teach a model nothing it already knows. What is missing when you
 * call the SDK straight from a route is everything around the call — streaming as SSE, aborting
 * when the client hangs up, not paying twice for the same prompt, and knowing what any of it
 * cost. That is this brick.
 *
 * `ctx.ai` inside a handler is bound to that request: its abort signal is wired, its token
 * totals are per-request, and its budget is enforced across every call the request makes. The
 * same service is available on the app for work with no request behind it.
 */
export function ai(options: AiOptions = {}): Brick<'ai', AiService, { ai: AiService }> {
  const runtime: Runtime = { options, inflight: new Map() }

  return {
    name: 'ai',

    // Optional: the brick works with no cache brick present, and `cache: true` then becomes a
    // boot error rather than a silent no-op.
    dependsOn: ['cache?'],

    setup(context) {
      if (options.cache) {
        const explicit = typeof options.cache === 'object' ? options.cache.store : undefined
        const registered = context.resolved.cache
        const store = explicit ?? (isAiCache(registered) ? registered : undefined)
        if (!store) {
          throw new AiConfigurationError(
            'ai({ cache }) was requested but no cache is available. Register a cache brick before this one, or pass cache.store explicitly.',
          )
        }
        runtime.store = store
        runtime.ttl = typeof options.cache === 'object' ? options.cache.ttl : undefined
      }
      return createService(runtime, { budget: options.budget?.tokens })
    },

    // Shadows the shared service with one bound to this request. Same interface, so nothing in a
    // handler has to know which it holds — but a route's totals, budget and abort signal are its
    // own rather than the process's.
    request(ctx: Context) {
      return {
        ai: createService(
          runtime,
          { budget: options.budget?.tokens, signal: ctx.req.signal },
          ctx.log,
        ),
      }
    },
  }
}
