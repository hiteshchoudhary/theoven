import type { ModelPricing, TokenUsage } from './types'

/** Reads a numeric property off an unknown object, or `undefined` if it is not a number. */
function num(source: unknown, key: string): number | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nested(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined
  return (source as Record<string, unknown>)[key]
}

/**
 * Flattens the SDK's usage object into {@link TokenUsage}.
 *
 * Reads two shapes on purpose. AI SDK v5 reported flat siblings (`cachedInputTokens`,
 * `reasoningTokens`); v7 moved them into `inputTokenDetails` / `outputTokenDetails`. Since the
 * peer range spans both, reading one shape would make the extra counts vanish on the other
 * version — and vanish *quietly*, which is the whole problem with token numbers.
 *
 * Nothing is defaulted to zero. A provider that reports no usage yields all-`undefined`, and
 * every consumer downstream is written to expect that.
 */
export function normaliseUsage(raw: unknown): TokenUsage {
  const inputDetails = nested(raw, 'inputTokenDetails')
  const outputDetails = nested(raw, 'outputTokenDetails')

  const inputTokens = num(raw, 'inputTokens')
  const outputTokens = num(raw, 'outputTokens')

  return {
    inputTokens,
    outputTokens,
    // Prefer the reported total; fall back to the sum only when both halves are known, so a
    // half-reported call does not produce a total that looks complete.
    totalTokens:
      num(raw, 'totalTokens') ??
      (inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens
        : undefined),
    cachedInputTokens: num(inputDetails, 'cacheReadTokens') ?? num(raw, 'cachedInputTokens'),
    reasoningTokens: num(outputDetails, 'reasoningTokens') ?? num(raw, 'reasoningTokens'),
  }
}

/**
 * What one call cost, or `undefined` when that cannot be known.
 *
 * `undefined` is returned when there is no pricing for the model, or when the provider did not
 * report the tokens the price applies to. Returning `0` in those cases would be a number that
 * looks like an answer — an always-zero cost column is worse than an empty one, because nobody
 * investigates a zero.
 *
 * Cache reads are priced separately when a `cachedInput` rate is given: providers bill them at
 * roughly a tenth, so folding them into the input rate overstates a cached-prompt workload by
 * about an order of magnitude on its dominant term.
 */
export function computeCost(
  usage: TokenUsage,
  pricing: ModelPricing | undefined,
): number | undefined {
  if (!pricing) return undefined
  const { inputTokens, outputTokens, cachedInputTokens } = usage
  if (inputTokens === undefined && outputTokens === undefined) return undefined

  const perToken = (rate: number) => rate / 1_000_000
  let cost = 0

  if (inputTokens !== undefined) {
    const cached = pricing.cachedInput !== undefined ? (cachedInputTokens ?? 0) : 0
    // Guard the subtraction: a provider reporting more cache reads than input tokens would
    // otherwise produce a negative charge.
    const uncached = Math.max(0, inputTokens - cached)
    cost += uncached * perToken(pricing.input)
    if (cached > 0 && pricing.cachedInput !== undefined)
      cost += cached * perToken(pricing.cachedInput)
  }
  if (outputTokens !== undefined) cost += outputTokens * perToken(pricing.output)

  return cost
}
