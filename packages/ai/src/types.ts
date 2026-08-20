import { OvenError } from '@theoven/core'

/**
 * The slice of a cache this brick uses.
 *
 * Declared structurally rather than imported, because a brick never depends on a sibling brick.
 * `ctx.cache` from `@theoven/cache` satisfies it as-is, and so does a `Map`-shaped object you
 * write yourself — there is nothing to adapt.
 */
export interface AiCache {
  get<Value>(key: string): Promise<Value | undefined>
  set<Value>(key: string, value: Value, options?: { ttl?: number | undefined }): Promise<void>
}

/**
 * Tokens for one call, flattened from whichever SDK shape reported them.
 *
 * **Every count is optional, and that is not defensiveness.** The AI SDK types these as
 * `number | undefined` because plenty of providers do not report usage at all, and some report
 * it only on non-streaming calls. Treating a missing count as `0` is the tempting mistake: the
 * bill silently reads zero and a token budget never trips. Absent stays absent.
 */
export interface TokenUsage {
  inputTokens: number | undefined
  outputTokens: number | undefined
  totalTokens: number | undefined
  /**
   * Input tokens the **provider** served from its own prompt cache.
   *
   * Not this brick's cache — see {@link AiOptions.cache}. This is Anthropic's or OpenAI's
   * server-side prompt caching, billed at a reduced rate, which is why
   * {@link ModelPricing.cachedInput} exists.
   */
  cachedInputTokens: number | undefined
  /** Output tokens spent on reasoning rather than the visible answer. Billed as output. */
  reasoningTokens: number | undefined
}

/**
 * What a model costs, in currency units per **one million** tokens.
 *
 * Supplied by you, never shipped by us. A built-in price table is wrong the week a provider
 * changes a price, and silently wrong — the number still looks authoritative. Yours lives in
 * your repo next to the rest of your billing assumptions, where a stale figure is reviewable.
 */
export interface ModelPricing {
  input: number
  output: number
  /** Rate for input tokens the provider served from its prompt cache. Often ~10% of `input`. */
  cachedInput?: number | undefined
}

/** One completed call, handed to {@link AiOptions.onUsage}. */
export interface UsageRecord {
  /** The model's id, as the provider reports it — e.g. `gpt-4o`. */
  model: string
  operation: 'generate' | 'stream' | 'embed'
  /**
   * Tokens the answer represents.
   *
   * On a cache hit these are the counts from the call that originally produced it — nothing was
   * billed again. Combined with `cached`, that is what lets a consumer report what caching saved.
   */
  usage: TokenUsage
  /**
   * What this call was billed.
   *
   * `0` on a cache hit, because nothing was. `undefined` when no pricing was configured or the
   * provider reported no tokens — a value that cannot be known, which is a different thing from
   * a call that was free.
   */
  cost: number | undefined
  /** True when this brick's cache answered and no provider call was made. */
  cached: boolean
  durationMs: number
}

/**
 * Running totals for one request.
 *
 * These count what was **actually spent**. A call served from this brick's cache adds to
 * `calls` and `cachedCalls` but contributes no tokens and no cost, because none were billed —
 * and since the budget is checked against these totals, a request answered entirely from cache
 * would otherwise exhaust an allowance it never spent.
 */
export interface RequestUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** Sums only the calls that could be priced; stays `0` when none could. */
  cost: number
  /** Every call made, cache hits included. */
  calls: number
  /** How many of `calls` this brick's cache answered without contacting a provider. */
  cachedCalls: number
}

/**
 * A request tried to spend more tokens than its budget allowed.
 *
 * 429 rather than 402: the request is refused for exceeding a quota, and nothing about payment
 * is being demanded of the caller.
 */
export class AiBudgetExceededError extends OvenError {
  override name = 'AiBudgetExceededError'
  readonly spent: number
  readonly budget: number

  constructor(spent: number, budget: number) {
    super(
      429,
      'Token budget exceeded',
      `This request has spent ${spent} tokens against a budget of ${budget}.`,
      { type: 'https://theoven.app/errors/ai-budget-exceeded', detail: { spent, budget } },
    )
    this.spent = spent
    this.budget = budget
  }
}

/** No model was given to the brick or to the call. */
export class AiConfigurationError extends OvenError {
  override name = 'AiConfigurationError'
  constructor(message: string) {
    super(500, 'AI misconfigured', message)
  }
}
